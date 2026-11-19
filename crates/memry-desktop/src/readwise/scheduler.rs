//! The Readwise scheduler and the open vault's run service (`runtime-effects.ts`, and
//! `getReadwiseSyncService` in `sync-service.ts`). One [`ReadwiseRuns`] per open vault holds
//! the vault's one [`Engine`] and one [`PullGate`]: the gate keeps its claim confirmation in
//! memory, so a gate per run would confirm again on every run.
//!
//! - Cadence is the synced `cadence` option: Manual never starts a run, Hourly and Daily start
//!   one when the interval since the last attempt has passed. The launch run is due at once.
//! - One run at a time. Sync now joins a run the scheduler already has going.
//! - It never runs without a token, and never before the first import: that import shows the
//!   preview, which the user must see first.
//! - A revoked token (`needsAttention`) stops the schedule until the user connects again. Other
//!   failures back off, doubling from 5 minutes to 6 hours. A pull-gate refusal is a failure
//!   here too, and the status shows no error for it (`run_status::classify`).
//! - While no run is in flight, each tick drops the token once another device holds the claim
//!   (`releaseTokenIfClaimedElsewhere`).
//!
//! Blocking: every call reads the data DB or the keychain, and a run lives on the calling
//! thread. [`ReadwiseRuns::start`] runs the minute tick on a thread of its own.

use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use memry_core::api::errors::SecureStoreError;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::claim::Claim;
use super::engine::Engine;
use super::library::Library;
use super::pull_gate::{Authority, PullGate, SyncView, authority};
use super::run_state::RunState;
use super::run_status::RunStatus;
use super::run_types::{RunError, RunResult, Unobserved};
use super::telemetry::{Origin, sync_completed};
use super::token::ReadwiseToken;
use crate::telemetry::events::TelemetryEvent;

const SCOPE: &str = "Readwise:Scheduler";

/// The shared minute tick.
pub const TICK: Duration = Duration::from_secs(60);
const HOUR_MS: i64 = 60 * 60 * 1000;
/// A failed run is retried after this, doubling per consecutive failure.
pub const BACKOFF_BASE_MS: i64 = 5 * 60 * 1000;
pub const BACKOFF_MAX_MS: i64 = 6 * HOUR_MS;
/// The tick drifts by a few seconds; a run due on this tick should not wait a full minute more.
const TICK_TOLERANCE_MS: i64 = 5 * 1000;

/// `ReadwiseCadence`. A value only a newer build knows reads as the default, Hourly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cadence {
    Manual,
    Hourly,
    Daily,
}

impl Cadence {
    /// `group` is the stored `readwise` object.
    pub fn from_group(group: &Value) -> Self {
        match group.get("cadence").and_then(Value::as_str) {
            Some("manual") => Self::Manual,
            Some("daily") => Self::Daily,
            _ => Self::Hourly,
        }
    }

    fn interval_ms(self) -> Option<i64> {
        match self {
            Self::Manual => None,
            Self::Hourly => Some(HOUR_MS),
            Self::Daily => Some(24 * HOUR_MS),
        }
    }
}

/// Why Sync now did not run (`ReadwiseRunInProgressError`, `ReadwiseUnavailableError`), or
/// the run's own failure.
#[derive(Debug, Clone, thiserror::Error)]
pub enum SyncNowError {
    /// A run the scheduler did not start (a book command) holds the engine.
    #[error("A Readwise run is already in progress")]
    InProgress,
    #[error("Readwise is not connected")]
    NotConnected,
    #[error("Readwise does not sync on this device")]
    OtherDevice,
    /// The vault is closing.
    #[error("The vault is closing")]
    Closing,
    #[error(transparent)]
    Keychain(Arc<SecureStoreError>),
    #[error(transparent)]
    Run(Arc<RunError>),
}

/// The vault's pieces a run needs. The engine was built over `gate`.
pub struct RunsParts {
    pub library: Library,
    pub engine: Engine,
    pub gate: Arc<PullGate>,
    pub token: ReadwiseToken,
    pub sync: Arc<dyn SyncView>,
    /// `net.isOnline()`.
    pub online: Arc<dyn Fn() -> bool + Send + Sync>,
    /// Epoch milliseconds.
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// `trackReadwiseSync`.
    pub track: Arc<dyn Fn(TelemetryEvent) + Send + Sync>,
}

type Outcome = Result<RunResult, Arc<RunError>>;

/// The run in flight, for a Sync now that joins it.
#[derive(Default)]
struct Slot {
    outcome: Mutex<Option<Outcome>>,
    done: Condvar,
}

impl Slot {
    fn wait(&self) -> Outcome {
        let mut outcome = lock(&self.outcome);
        loop {
            if let Some(outcome) = outcome.as_ref() {
                return outcome.clone();
            }
            outcome = self.done.wait(outcome).unwrap_or_else(|e| e.into_inner());
        }
    }
}

#[derive(Default)]
struct Schedule {
    current: Option<Arc<Slot>>,
    /// Start of the last run this service began. `None`: none yet, so the launch run is due.
    last_attempt_at: Option<i64>,
    failures: u32,
    next_retry_at: i64,
}

/// The open vault's Readwise runs.
pub struct ReadwiseRuns {
    parts: RunsParts,
    schedule: Mutex<Schedule>,
    /// Cancelled when the vault closes: stops the tick and the run in flight.
    closing: CancellationToken,
    tick: Duration,
    ticker: Mutex<Option<JoinHandle<()>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl ReadwiseRuns {
    pub fn new(parts: RunsParts) -> Self {
        Self {
            parts,
            schedule: Mutex::default(),
            closing: CancellationToken::new(),
            tick: TICK,
            ticker: Mutex::new(None),
        }
    }

    /// Tests tick faster.
    pub fn with_tick(mut self, tick: Duration) -> Self {
        self.tick = tick;
        self
    }

    pub fn library(&self) -> &Library {
        &self.parts.library
    }

    pub fn gate(&self) -> &Arc<PullGate> {
        &self.parts.gate
    }

    /// The run in progress and the last failure.
    pub fn status(&self) -> &RunStatus {
        self.parts.engine.status()
    }

    pub fn is_running(&self) -> bool {
        self.parts.engine.is_running()
    }

    /// Stops the run in progress at its next book, whoever started it.
    pub fn cancel(&self) {
        self.parts.engine.cancel();
    }

    /// Subscribes to the minute tick and takes the launch run, off the caller's thread.
    pub fn start(self: &Arc<Self>) {
        let runs = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("readwise-tick".to_owned())
            .spawn(move || {
                let runtime = runs.parts.library.runtime.clone();
                while !runs.closing.is_cancelled() {
                    runs.tick();
                    runtime.block_on(async {
                        tokio::select! {
                            () = runs.closing.cancelled() => {}
                            () = tokio::time::sleep(runs.tick) => {}
                        }
                    });
                }
            });
        match spawned {
            Ok(handle) => *lock(&self.ticker) = Some(handle),
            Err(error) => tracing::error!(scope = SCOPE, %error, "the Readwise tick did not start"),
        }
    }

    /// The vault is closing: stops the tick and the run in flight, and waits for both.
    pub fn stop(&self) {
        self.closing.cancel();
        let ticker = lock(&self.ticker).take();
        if let Some(ticker) = ticker
            && ticker.join().is_err()
        {
            tracing::error!(scope = SCOPE, "the Readwise tick panicked");
        }
        let current = lock(&self.schedule).current.clone();
        if let Some(slot) = current {
            let _ = slot.wait();
        }
    }

    /// `canPull`: a run may start now.
    pub fn can_pull(&self) -> bool {
        match Claim::read(&self.parts.library.store()) {
            Ok(claim) => matches!(
                authority(&self.parts.sync.env(), &claim),
                Authority::Pull | Authority::ClaimNeeded
            ),
            Err(error) => {
                tracing::warn!(scope = SCOPE, %error, "the Readwise claim could not be read");
                false
            }
        }
    }

    fn token(&self) -> Result<Option<String>, SecureStoreError> {
        self.parts.token.read()
    }

    /// The schedule's inputs from the data DB: the cadence, and whether a first import ran and
    /// the token still works. `None` when nothing will run.
    fn interval(&self) -> Option<i64> {
        let store = self.parts.library.store();
        let cadence = match store.settings_group() {
            Ok(group) => Cadence::from_group(&group),
            Err(error) => {
                tracing::warn!(scope = SCOPE, %error, "the Readwise options could not be read");
                return None;
            }
        };
        let interval = cadence.interval_ms()?;
        let state = RunState::new(store);
        let imported = state.cursor().map(|cursor| cursor.is_some());
        let parked = state
            .last_run()
            .map(|run| run.is_some_and(|r| r.needs_attention));
        match (imported, parked) {
            (Ok(true), Ok(false)) => Some(interval),
            (Ok(_), Ok(_)) => None,
            (Err(error), _) | (_, Err(error)) => {
                tracing::warn!(scope = SCOPE, %error, "the Readwise run state could not be read");
                None
            }
        }
    }

    /// The token to run with when a run is due now, else `None`.
    fn due(&self) -> Option<String> {
        if self.closing.is_cancelled() || self.is_running() {
            return None;
        }
        let interval = self.interval()?;
        let now = (self.parts.clock)();
        {
            let schedule = lock(&self.schedule);
            if schedule.current.is_some() || now + TICK_TOLERANCE_MS < schedule.next_retry_at {
                return None;
            }
            // After a failure the backoff sets the retry time, not the cadence.
            let waiting = schedule
                .last_attempt_at
                .is_some_and(|at| now + TICK_TOLERANCE_MS < at + interval);
            if schedule.failures == 0 && waiting {
                return None;
            }
        }
        if !self.can_pull() || !(self.parts.online)() {
            return None;
        }
        match self.token() {
            Ok(token) => token,
            Err(error) => {
                tracing::warn!(scope = SCOPE, %error, "the Readwise token could not be read");
                None
            }
        }
    }

    /// One scheduler decision: drop the token if the claim moved, then start a run if one is
    /// due. Never fails.
    pub fn tick(&self) {
        if !self.is_running() {
            match self.parts.gate.claim_gate().release_if_claimed_elsewhere() {
                Ok(true) => tracing::info!(scope = SCOPE, "another device pulls Readwise now"),
                Ok(false) => {}
                Err(error) => tracing::warn!(scope = SCOPE, %error, "the Readwise release failed"),
            }
        }
        if let Some(token) = self.due() {
            let _ = self.begin(&token, Origin::Scheduled);
        }
    }

    /// Sync now: runs at once and returns when the run completes. Joins the scheduler's own
    /// run; a run started elsewhere cannot be joined, so it is refused.
    pub fn sync_now(&self) -> Result<RunResult, SyncNowError> {
        if let Some(slot) = lock(&self.schedule).current.clone() {
            return slot.wait().map_err(SyncNowError::Run);
        }
        if self.is_running() {
            return Err(SyncNowError::InProgress);
        }
        let token = self
            .token()
            .map_err(|error| SyncNowError::Keychain(Arc::new(error)))?
            .ok_or(SyncNowError::NotConnected)?;
        if !self.can_pull() {
            return Err(SyncNowError::OtherDevice);
        }
        self.begin(&token, Origin::Manual)
            .ok_or(SyncNowError::Closing)?
            .map_err(SyncNowError::Run)
    }

    /// When the schedule next starts a run (epoch ms), or `None` when nothing will: Manual,
    /// parked, or no first import yet.
    pub fn next_run_at(&self) -> Option<i64> {
        let interval = self.interval()?;
        let now = (self.parts.clock)();
        let schedule = lock(&self.schedule);
        if schedule.failures > 0 {
            return Some(schedule.next_retry_at.max(now));
        }
        Some(
            schedule
                .last_attempt_at
                .map_or(now, |at| (at + interval).max(now)),
        )
    }

    /// Takes the run slot, or joins the run that holds it. `None` once the vault is closing:
    /// checked under the slot's lock, so a run either holds the slot `stop()` waits on or never
    /// starts.
    fn begin(&self, token: &str, origin: Origin) -> Option<Outcome> {
        let started = (self.parts.clock)();
        let slot = {
            let mut schedule = lock(&self.schedule);
            if let Some(slot) = schedule.current.clone() {
                drop(schedule);
                return Some(slot.wait());
            }
            if self.closing.is_cancelled() {
                return None;
            }
            let slot = Arc::new(Slot::default());
            schedule.current = Some(Arc::clone(&slot));
            schedule.last_attempt_at = Some(started);
            slot
        };
        let p = &self.parts;
        // A panic must still free the slot, or a joining Sync now and the close wait forever.
        let run = || p.engine.run(&p.library, token, &Unobserved, &self.closing);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run))
            .unwrap_or_else(|_| Err(RunError::Failed("the Readwise run panicked".to_owned())))
            .map_err(Arc::new);
        let duration = u64::try_from((p.clock)() - started).unwrap_or(0);
        (p.track)(sync_completed(
            origin,
            duration,
            outcome.as_ref().map_err(|e| &**e),
        ));
        {
            let mut schedule = lock(&self.schedule);
            match &outcome {
                Ok(_) => {
                    schedule.failures = 0;
                    schedule.next_retry_at = 0;
                }
                Err(error) => {
                    schedule.failures += 1;
                    let doubling = 2_i64.saturating_pow(schedule.failures - 1);
                    let delay = BACKOFF_BASE_MS.saturating_mul(doubling).min(BACKOFF_MAX_MS);
                    schedule.next_retry_at = (p.clock)() + delay;
                    tracing::warn!(
                        scope = SCOPE,
                        origin = ?origin,
                        code = %super::telemetry::error_code(error),
                        failures = schedule.failures,
                        retry_in_ms = delay,
                        "a Readwise run failed"
                    );
                }
            }
            schedule.current = None;
        }
        *lock(&slot.outcome) = Some(outcome.clone());
        slot.done.notify_all();
        Some(outcome)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::Cadence;

    #[test]
    fn the_cadence_reads_its_stored_value_and_anything_else_is_hourly() {
        assert_eq!(
            Cadence::from_group(&json!({"cadence": "manual"})),
            Cadence::Manual
        );
        assert_eq!(
            Cadence::from_group(&json!({"cadence": "daily"})),
            Cadence::Daily
        );
        assert_eq!(
            Cadence::from_group(&json!({"cadence": "weekly"})),
            Cadence::Hourly
        );
        assert_eq!(Cadence::from_group(&json!(null)), Cadence::Hourly);
    }
}
