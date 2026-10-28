//! The ordered, deadline-bound quit of the app. One shared budget runs the registered steps in
//! `STEP_ORDER`, the durable ones first, so a wedged teardown step degrades a quit to "slow",
//! never to lost edits (`apps/desktop/src/main/shutdown-sequence.ts`, `before-quit` in
//! `apps/desktop/src/main/index.ts`). This module never depends on `tauri`: the shell supplies
//! [`ShutdownEffects`] (the crash marker and the process exit) and registers the steps.

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::time::Instant;

use crate::telemetry::crash::ShutdownFailure;

/// Budget of the whole graceful chain.
pub const BUDGET: Duration = Duration::from_millis(8000);
/// Windows allows about five seconds for a session end.
pub const SESSION_END_BUDGET: Duration = Duration::from_millis(4000);
/// Hard ceiling on a quit, outside the sequence: 500 ms past the latest a timeout can exit.
pub const HARD_BACKSTOP: Duration = Duration::from_millis(10_000);
/// Granted after the budget is gone, only to make data durable.
pub const LAST_CHANCE: Duration = Duration::from_millis(1500);
/// Ceiling on the final snapshot push of `stop-sync-runtime`.
pub const FINAL_SNAPSHOT_PUSH: Duration = Duration::from_millis(2000);
/// What the final snapshot push must leave for the steps behind it.
pub const CLOSE_VAULT_RESERVE: Duration = Duration::from_millis(2000);
/// Ceiling on the telemetry and log-ship flush.
pub const TELEMETRY_FLUSH: Duration = Duration::from_millis(1000);
/// What `close-vault` keeps for the database close behind its projection drain.
pub const DATABASE_CLOSE_RESERVE: Duration = Duration::from_millis(1000);
const PROJECTION_DRAIN_CEILING: Duration = Duration::from_millis(5000);

/// The canonical step names, in run order. They are a contract: a name becomes the crash-marker
/// token and the telemetry code `SHUTDOWN_TIMEOUT_<STEP>`.
pub const STEP_ORDER: [&str; 11] = [
    "flush-windows",
    "flush-writebacks",
    "flush-activity-log",
    "close-snapshots",
    "stop-schedulers",
    "stop-capture-server",
    "stop-chat-server",
    "stop-utility-processes",
    "stop-sync-runtime",
    "close-vault",
    "flush-telemetry",
];

/// Re-run once the budget is gone, in this order, under [`LAST_CHANCE`]. Neither depends on the
/// step that is wedged, and both are cheap.
pub const LAST_CHANCE_STEPS: [&str; 2] = ["flush-writebacks", "flush-activity-log"];
const CLOSE_VAULT: &str = "close-vault";

/// The final snapshot push's timeout inside `remaining`: zero skips it.
pub fn final_snapshot_push_timeout(remaining: Duration) -> Duration {
    FINAL_SNAPSHOT_PUSH.min(remaining.saturating_sub(CLOSE_VAULT_RESERVE))
}

/// The projection drain's timeout inside `close-vault` within `remaining`: zero skips the drain,
/// which only leaves derived state the next open re-derives.
pub fn close_vault_drain_timeout(remaining: Duration) -> Duration {
    PROJECTION_DRAIN_CEILING.min(remaining.saturating_sub(DATABASE_CLOSE_RESERVE))
}

/// An exit request this soon after the last window was destroyed came from the window system.
/// The destroy and its exit request arrive in one event-loop pass, and no user reaches Dock Quit
/// in half a second.
pub const IMPLICIT_EXIT_WINDOW: Duration = Duration::from_millis(500);

/// Whether an exit request with no exit code is the window system's reaction to the last window
/// closing, given when that window was destroyed.
pub fn is_implicit_exit(last_window_destroyed: Option<std::time::Instant>) -> bool {
    last_window_destroyed.is_some_and(|at| at.elapsed() < IMPLICIT_EXIT_WINDOW)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownReason {
    Quit,
    /// The OS is ending the session (Windows logoff or shutdown).
    SessionEnd,
}

impl ShutdownReason {
    pub fn budget(self) -> Duration {
        match self {
            Self::SessionEnd => SESSION_END_BUDGET,
            Self::Quit => BUDGET,
        }
    }
}

/// What a step may ask about the quit it runs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShutdownContext {
    /// An update is about to install: `stop-sync-runtime` skips its final push.
    pub installing_update: bool,
    pub reason: ShutdownReason,
}

/// The shared budget. Every bounded wait of a step clamps itself with [`Deadline::cap`], so no
/// set of waits can collectively outlive the sequence.
#[derive(Debug, Clone, Copy)]
pub struct Deadline {
    at: Instant,
}

impl Deadline {
    pub fn after(budget: Duration) -> Self {
        Self {
            at: Instant::now() + budget,
        }
    }

    pub fn remaining(&self) -> Duration {
        self.at.saturating_duration_since(Instant::now())
    }

    /// `preferred`, clamped to what is left.
    pub fn cap(&self, preferred: Duration) -> Duration {
        preferred.min(self.remaining())
    }
}

pub type StepFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type StepFn = Arc<dyn Fn(ShutdownContext, Deadline) -> StepFuture + Send + Sync>;

/// A step name that is not in [`STEP_ORDER`].
#[derive(Debug, thiserror::Error)]
#[error("{0:?} is not a shutdown step; the names are listed in STEP_ORDER")]
pub struct UnknownStep(pub String);

/// The closures every owner registered for each step name. Several owners may share a name
/// (`stop-schedulers`); they run in registration order.
#[derive(Default)]
pub struct ShutdownRegistry {
    steps: Mutex<HashMap<&'static str, Vec<StepFn>>>,
}

impl ShutdownRegistry {
    pub fn register(&self, name: &str, run: StepFn) -> Result<(), UnknownStep> {
        let name = STEP_ORDER
            .iter()
            .copied()
            .find(|known| *known == name)
            .ok_or_else(|| UnknownStep(name.to_owned()))?;
        self.steps
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(name)
            .or_default()
            .push(run);
        Ok(())
    }

    /// The registered steps in `STEP_ORDER`; a name nobody registered is skipped.
    pub fn steps(&self) -> Vec<ShutdownStep> {
        STEP_ORDER.iter().filter_map(|n| self.step(n)).collect()
    }

    pub fn step(&self, name: &str) -> Option<ShutdownStep> {
        let steps = self.steps.lock().unwrap_or_else(PoisonError::into_inner);
        let (name, runs) = steps.get_key_value(name)?;
        Some(ShutdownStep {
            name,
            runs: runs.clone(),
        })
    }
}

#[derive(Clone)]
pub struct ShutdownStep {
    pub name: &'static str,
    runs: Vec<StepFn>,
}

impl ShutdownStep {
    /// Runs every owner's closure in order. One failing does not stop the rest; the first error
    /// is the step's.
    async fn run(&self, ctx: ShutdownContext, deadline: Deadline) -> Result<(), String> {
        let mut first_error = None;
        for run in &self.runs {
            if let Err(error) = run(ctx, deadline).await {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SequenceStatus {
    Complete,
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShutdownOutcome {
    pub status: SequenceStatus,
    /// The step in flight when the budget ran out.
    pub overrun_step: Option<&'static str>,
    pub overrun_step_ms: u64,
    pub elapsed_ms: u64,
}

/// A step returned an error: the cleanup failed, as opposed to ran out of time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepFailure {
    pub step: &'static str,
    pub message: String,
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// Runs `steps` in order under one `budget`. The next step does not start once the budget is
/// spent, and a timeout names the step that was in flight. `on_step_start` runs synchronously as
/// each step starts, so a process that dies mid-step still leaves its name behind.
pub async fn run_shutdown_sequence(
    steps: &[ShutdownStep],
    ctx: ShutdownContext,
    budget: Duration,
    on_step_start: &(dyn Fn(&'static str) + Send + Sync),
) -> Result<ShutdownOutcome, StepFailure> {
    let started = Instant::now();
    let deadline = Deadline::after(budget);
    let in_flight: Mutex<Option<(&'static str, Instant)>> = Mutex::new(None);
    let chain = async {
        for step in steps {
            *in_flight.lock().unwrap_or_else(PoisonError::into_inner) =
                Some((step.name, Instant::now()));
            on_step_start(step.name);
            step.run(ctx, deadline)
                .await
                .map_err(|message| StepFailure {
                    step: step.name,
                    message,
                })?;
            *in_flight.lock().unwrap_or_else(PoisonError::into_inner) = None;
        }
        Ok(())
    };
    match tokio::time::timeout(budget, chain).await {
        Ok(Ok(())) => Ok(ShutdownOutcome {
            status: SequenceStatus::Complete,
            overrun_step: None,
            overrun_step_ms: 0,
            elapsed_ms: millis(started.elapsed()),
        }),
        Ok(Err(failure)) => Err(failure),
        Err(_) => {
            let current = *in_flight.lock().unwrap_or_else(PoisonError::into_inner);
            Ok(ShutdownOutcome {
                status: SequenceStatus::Timeout,
                overrun_step: current.map(|(name, _)| name),
                overrun_step_ms: current.map_or(0, |(_, at)| millis(at.elapsed())),
                elapsed_ms: millis(started.elapsed()),
            })
        }
    }
}

/// Hands a downloaded update to the installer; `crate::updater::service` implements it. With
/// none registered the calls are skipped.
pub trait UpdateApplyHook: Send + Sync {
    /// The OS is ending the session: an install-on-quit must not start.
    fn disable_install_on_quit(&self);
    /// The OS cancelled that session end: the install-on-quit decision is back as it was.
    fn enable_install_on_quit(&self);
    /// The user asked to install, so the quit hands off to the installer before the exit.
    fn install_requested(&self) -> bool;
    /// Starts the installer, which waits for this process to exit. Returns without exiting: the
    /// sequence ends the process after it. It runs after the sequence claimed the exit, so the
    /// backstop no longer covers it: it must start the installer and return, never wait on it.
    fn apply_and_restart(&self);
    /// Runs when the process is exiting normally.
    fn apply_on_quit(&self);
}

/// What the shell does for the sequence: the crash marker and the process.
pub trait ShutdownEffects: Send + Sync + 'static {
    fn step_started(&self, step: &str);
    fn mark_failure(&self, failure: ShutdownFailure, step: Option<&str>);
    /// The quit was clean: the next launch must not report it as a crash.
    fn clear_marker(&self);
    /// Exits the process with code 0, letting the quit through.
    fn exit_clean(&self);
    /// Ends the process now with a failure code.
    fn terminate(&self);
}

#[derive(Default)]
pub struct ShutdownCore {
    pub registry: ShutdownRegistry,
    hook: Mutex<Option<Arc<dyn UpdateApplyHook>>>,
    /// Set by whichever of the sequence and the backstop ends the process first.
    claimed: AtomicBool,
}

impl ShutdownCore {
    pub fn set_update_hook(&self, hook: Arc<dyn UpdateApplyHook>) {
        *self.hook.lock().unwrap_or_else(PoisonError::into_inner) = Some(hook);
    }

    pub fn update_hook(&self) -> Option<Arc<dyn UpdateApplyHook>> {
        self.hook
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn installing_update(&self) -> bool {
        self.update_hook()
            .is_some_and(|hook| hook.install_requested())
    }

    /// Takes the right to end the process. False when the other path already has it.
    fn claim(&self) -> bool {
        !self.claimed.swap(true, Ordering::SeqCst)
    }

    /// Starts the installer the user asked for, before the process ends.
    fn hand_off_install(&self) {
        if let Some(hook) = self.update_hook().filter(|hook| hook.install_requested()) {
            hook.apply_and_restart();
        }
    }

    /// A pending install survives a failed cleanup, otherwise the exit drops the update and the
    /// prompt returns. The exit stays a forced one.
    fn force_exit(&self, effects: &dyn ShutdownEffects) {
        self.hand_off_install();
        effects.terminate();
    }

    /// A timer on a plain thread, so a wedged async runtime cannot stop it. After `after` it
    /// records the timeout in the marker, keeping the step already stamped, and ends the process.
    pub fn arm_backstop(self: &Arc<Self>, after: Duration, effects: Arc<dyn ShutdownEffects>) {
        let core = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(after);
            if core.claim() {
                tracing::error!(scope = "Shutdown", "hard backstop reached");
                effects.mark_failure(ShutdownFailure::Timeout, None);
                core.force_exit(&*effects);
            }
        });
    }

    /// Runs the whole quit and ends in exactly one of: a clean exit, the installer, a forced
    /// exit. The caller has already armed the backstop.
    pub async fn run(&self, reason: ShutdownReason, effects: &Arc<dyn ShutdownEffects>) {
        // Also covers a session end that skipped the query path (a forced sign-out, a session
        // manager's `Stop`), whose first signal is this sequence.
        if reason == ShutdownReason::SessionEnd {
            self.session_ending();
        }
        let ctx = ShutdownContext {
            installing_update: self.installing_update(),
            reason,
        };
        let on_start = {
            let effects = effects.clone();
            move |name: &'static str| effects.step_started(name)
        };
        let outcome =
            run_shutdown_sequence(&self.registry.steps(), ctx, reason.budget(), &on_start).await;
        match outcome {
            Ok(outcome) if outcome.status == SequenceStatus::Complete => {
                tracing::info!(
                    scope = "Shutdown",
                    "cleanup complete in {} ms",
                    outcome.elapsed_ms
                );
                if !self.claim() {
                    return;
                }
                effects.clear_marker();
                self.hand_off_install();
                effects.exit_clean();
            }
            Ok(outcome) => {
                // Stamped first: whatever happens next, the next launch can name the step.
                effects.mark_failure(ShutdownFailure::Timeout, outcome.overrun_step);
                tracing::error!(
                    scope = "Shutdown",
                    "cleanup ran out of budget in {:?} after {} ms",
                    outcome.overrun_step,
                    outcome.overrun_step_ms
                );
                self.finish_failed(ctx, outcome.overrun_step, effects).await;
            }
            Err(failure) => {
                tracing::error!(
                    scope = "Shutdown",
                    "step {} failed: {}",
                    failure.step,
                    failure.message
                );
                effects.mark_failure(ShutdownFailure::CleanupError, None);
                self.finish_failed(ctx, Some(failure.step), effects).await;
            }
        }
    }

    async fn finish_failed(
        &self,
        ctx: ShutdownContext,
        failed_step: Option<&'static str>,
        effects: &Arc<dyn ShutdownEffects>,
    ) {
        self.last_chance(ctx, failed_step).await;
        if self.claim() {
            self.force_exit(&**effects);
        }
    }

    /// Makes the user's data durable with the budget gone: the write-back and activity flushes,
    /// and the vault close when the wedged step sat before it.
    async fn last_chance(&self, ctx: ShutdownContext, failed_step: Option<&'static str>) {
        let close_pending =
            failed_step.is_none_or(|failed| position(failed) < position(CLOSE_VAULT));
        let names = LAST_CHANCE_STEPS
            .iter()
            .copied()
            .chain(close_pending.then_some(CLOSE_VAULT));
        let steps: Vec<_> = names.filter_map(|name| self.registry.step(name)).collect();
        let deadline = Deadline::after(LAST_CHANCE);
        let work = async {
            for step in &steps {
                if let Err(error) = step.run(ctx, deadline).await {
                    tracing::error!(
                        scope = "Shutdown",
                        "last-chance step {} failed: {error}",
                        step.name
                    );
                }
            }
        };
        if tokio::time::timeout(LAST_CHANCE, work).await.is_err() {
            tracing::error!(
                scope = "Shutdown",
                "last-chance flush did not finish in time"
            );
        }
    }

    /// The OS is ending the session: install on quit is off from here. A session end never
    /// installs on quit, because Windows kills an installer started then, after it removed the
    /// old install (#1851). The shell calls this for every session end, also one that arrives
    /// while a quit already runs and so starts no sequence of its own.
    pub fn session_ending(&self) {
        if let Some(hook) = self.update_hook() {
            hook.disable_install_on_quit();
        }
    }

    /// Runs when the process exits normally.
    pub fn apply_on_quit(&self) {
        if let Some(hook) = self.update_hook() {
            hook.apply_on_quit();
        }
    }
}

fn position(name: &str) -> usize {
    STEP_ORDER
        .iter()
        .position(|known| *known == name)
        .unwrap_or(usize::MAX)
}
