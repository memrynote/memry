//! One pass of the loop: the task that runs it, and what the loop takes from its report.

use std::sync::Arc;
use std::time::Duration;

use memry_core::api::errors::{ApiError, SyncError, TransportError};
use memry_core::sync::driver::ApplyObserver;
use memry_core::sync::driver::progress::InitialSyncSink;
use memry_core::sync::engine::PassReport;
use memry_core::sync::outbox;
use memry_core::sync::state::SyncState;
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

use super::{Loop, blocking, now_ms};
use crate::sync::backend::{SyncBackend, SyncPasses};
use crate::sync::error_category::SyncErrorCategory;
use crate::sync::events::{EventObserver, SyncEvent};
use crate::sync::gate::GateDecision;
use crate::sync::result::{SyncNowBlockedReason as Blocked, TriggerSyncResult};
use crate::sync::telemetry::{ConflictTelemetry, sync_error_event};
use crate::sync::triggers::{MAX_CLOCK_SKEW_MS, Trigger, rate_limit_backoff};

/// What a pass task hands back.
pub(super) struct PassDone {
    pub(super) id: u64,
    trigger: Trigger,
    /// When the pass was requested: a pull's age counts from its start.
    started: Instant,
    /// The driver the pass ran on, or why it could not be opened.
    driver: Result<Arc<dyn SyncPasses>, SyncError>,
    report: Option<PassReport>,
    /// A failure outside the report: the first sync's (then `report` is the pass that drained
    /// the outbox after it, if one ran), or the read of whether one is owed.
    error: Option<SyncError>,
    pending: Option<u32>,
}

/// The driver a pass runs on.
pub(super) enum PassDriver {
    /// The one the loop holds.
    Held(Arc<dyn SyncPasses>),
    /// One the pass opens, which `observers` hear from its open on.
    Open {
        entitled: bool,
        observers: Vec<Arc<dyn ApplyObserver>>,
    },
}

/// Runs one pass, or the first sync with its progress to `progress` while the vault has not
/// finished one. `pause` is the loop's: it reaches the driver while the pass holds it.
pub(super) async fn run(
    id: u64,
    trigger: Trigger,
    driver: PassDriver,
    backend: Arc<dyn SyncBackend>,
    db: memry_core::storage::Db,
    pause: watch::Receiver<bool>,
    progress: Arc<dyn InitialSyncSink>,
) -> PassDone {
    let started = Instant::now();
    let driver = match driver {
        PassDriver::Held(driver) => Ok(driver),
        PassDriver::Open {
            entitled,
            observers,
        } => backend.open(observers).await.inspect(|driver| {
            if entitled {
                driver.set_entitled(true);
            }
        }),
    };
    let (report, error) = match &driver {
        Ok(driver) => tokio::select! {
            biased;
            ran = pass_on(driver.as_ref(), trigger, progress) => ran,
            () = follow_pause(driver.as_ref(), pause) => (None, None),
        },
        Err(_) => (None, None),
    };
    let pending = match blocking(&db, outbox::depth).await {
        Ok(depth) => u32::try_from(depth).ok(),
        Err(error) => {
            tracing::warn!(%error, "could not read the outbox depth");
            None
        }
    };
    PassDone {
        id,
        trigger,
        started,
        driver,
        report,
        error,
        pending,
    }
}

/// A fresh device's first pass, whatever asked for it, is the first sync (`full-sync-runner.ts`
/// `isFreshDevice`): it pulls every live body, which the feed alone does not serve (#2297). A
/// first sync cut short resumes from what it wrote at the next pass.
///
/// A first sync that fails is followed by a pass, so the seeds run and the outbox drains while the
/// device stays fresh: Electron's full sync seeds and pushes on every run (`full-sync-runner.ts:
/// 400-455`), and one body the server keeps refusing must not hold every local write back.
async fn pass_on(
    driver: &dyn SyncPasses,
    trigger: Trigger,
    progress: Arc<dyn InitialSyncSink>,
) -> (Option<PassReport>, Option<SyncError>) {
    let (report, error) = match driver.needs_first_sync().await {
        Err(error) => (None, Some(error)),
        Ok(true) => match driver.first_sync(progress).await {
            Ok(report) => (report, None),
            Err(error) if drains_after(&error) => {
                (driver.run_pass(trigger.pass_trigger()).await, Some(error))
            }
            Err(error) => (None, Some(error)),
        },
        Ok(false) => (
            match trigger {
                Trigger::Hint { cursor } => driver.wake(cursor).await,
                _ => driver.run_pass(trigger.pass_trigger()).await,
            },
            None,
        ),
    };
    // The pass ends with the snapshots due, so their gate reads the pull it just ran.
    if report.is_some() {
        driver.push_due_snapshots(now_ms()).await;
    }
    (report, error)
}

/// Whether a pass runs after a first sync that failed with `error`. Not after a pause cut, an
/// auth refusal, a `429` or offline: the pass would fail the same way.
fn drains_after(error: &SyncError) -> bool {
    !(error.is_cancelled()
        || is_offline(error)
        || rate_limited(error).is_some()
        || matches!(
            SyncErrorCategory::of(error),
            SyncErrorCategory::AuthExpired
                | SyncErrorCategory::DeviceRevoked
                | SyncErrorCategory::CertificatePinFailed
        ))
}

/// The engine's offline case (`engine.rs` `is_offline`): a reachability transition, not a backoff.
fn is_offline(error: &SyncError) -> bool {
    matches!(
        error,
        SyncError::Api {
            source: ApiError::Transport {
                source: TransportError::Offline
            }
        }
    )
}

/// Pauses and resumes `driver` with the loop. The loop does so for the driver it holds; a driver
/// this pass opened is the pass's until it hands it back, and a pause during its pass must still
/// cut it.
async fn follow_pause(driver: &dyn SyncPasses, mut pause: watch::Receiver<bool>) {
    loop {
        if *pause.borrow_and_update() {
            driver.pause();
        } else {
            driver.resume();
        }
        if pause.changed().await.is_err() {
            return std::future::pending().await;
        }
    }
}

impl Loop {
    /// What a driver this loop opens hears: the shell's events and the conflict telemetry.
    pub(super) fn observers(&self) -> Vec<Arc<dyn ApplyObserver>> {
        let mut observers: Vec<Arc<dyn ApplyObserver>> =
            vec![Arc::new(EventObserver(Arc::clone(&self.on_event)))];
        if let Some(telemetry) = &self.telemetry {
            observers.push(Arc::new(ConflictTelemetry(Arc::clone(telemetry))));
        }
        observers
    }

    pub(super) async fn finished(&mut self, done: PassDone) {
        if let Some(pending) = done.pending {
            self.pending = pending;
        }
        let driver = match done.driver {
            Ok(driver) => driver,
            Err(error) => {
                tracing::warn!(%error, "sync did not start");
                self.report(&error);
                let category = SyncErrorCategory::of(&error);
                self.last_error = Some((error.to_string(), category));
                self.failed(category);
                self.answer(
                    done.id,
                    TriggerSyncResult::blocked(Blocked::Failed, Some(error)),
                );
                return;
            }
        };
        // The keychain answered: the open read the master key.
        self.keychain = None;
        // A pause or resume may have come after the pass let go of the driver.
        if self.paused {
            driver.pause();
        } else {
            driver.resume();
        }
        self.driver = Some(Arc::clone(&driver));
        let result = match &done.error {
            Some(error) if error.is_cancelled() => {
                TriggerSyncResult::blocked(Blocked::Paused, None)
            }
            Some(error) => {
                self.first_sync_failed(error, done.report.as_ref(), done.started, done.pending)
            }
            None => self.reported(
                done.report.as_ref(),
                done.trigger,
                done.started,
                done.pending,
            ),
        };
        if result.success {
            self.socket_refused = false;
        }
        self.ensure_socket();
        // Only a reading this pass learned: the driver keeps the last one, and a fixed clock
        // must not pause again on it (`push-coordinator.ts:525` checks each fresh `serverTime`).
        let fresh = driver
            .server_clock()
            .filter(|clock| Some(*clock) != self.seen_clock);
        if let Some(clock) = fresh {
            self.seen_clock = Some(clock);
            if clock.skew_ms().abs() > MAX_CLOCK_SKEW_MS && !self.paused {
                tracing::warn!(
                    skew_ms = clock.skew_ms(),
                    "the clock is off from the server's; sync paused"
                );
                // Paused in memory even when the write failed (`set_paused`), so the event and
                // the status agree.
                if let Err(error) = self.set_paused(true).await {
                    tracing::error!(%error, "could not persist the clock-skew pause");
                }
                self.skew_paused = true;
                (self.on_event)(&SyncEvent::clock_skew(clock));
            }
        }
        let result = if self.paused {
            TriggerSyncResult::blocked(Blocked::Paused, None)
        } else {
            result
        };
        self.answer(done.id, result);
    }

    fn reported(
        &mut self,
        report: Option<&PassReport>,
        trigger: Trigger,
        started: Instant,
        pending: Option<u32>,
    ) -> TriggerSyncResult {
        match report {
            // A hint the engine dropped: this device already holds its change.
            None if matches!(trigger, Trigger::Hint { .. }) && !self.paused => {
                TriggerSyncResult::ok()
            }
            None => TriggerSyncResult::blocked(Blocked::Paused, None),
            Some(report) => {
                self.took_in(report, started, pending);
                self.record(report)
            }
        }
    }

    /// A first sync that failed, and the pass that drained the outbox after it. The pass's push
    /// and pull are taken in, but not its success: the failure stays shown and its backoff keeps
    /// doubling until a first sync completes. A failure of the pass itself (a latch, a `429`)
    /// wins, as it would on its own.
    fn first_sync_failed(
        &mut self,
        error: &SyncError,
        drained: Option<&PassReport>,
        started: Instant,
        pending: Option<u32>,
    ) -> TriggerSyncResult {
        let mut error = error;
        if let Some(report) = drained {
            self.took_in(report, started, pending);
            if let Some(failed) = report.error().filter(|failed| !failed.is_cancelled()) {
                error = failed;
            }
        }
        self.pass_failed(error, is_offline(error))
    }

    /// What every pass that ran tells, whatever its outcome: queue-cleared and the pull's age.
    fn took_in(&mut self, report: &PassReport, started: Instant, pending: Option<u32>) {
        if report.pushed_items > 0 && report.push_error.is_none() && pending == Some(0) {
            (self.on_event)(&SyncEvent::QueueCleared {
                item_count: u32::try_from(report.pushed_items).unwrap_or(u32::MAX),
                duration_ms: i64::try_from(report.push_ms).unwrap_or(i64::MAX),
            });
        }
        if report.transitions.contains(&SyncState::Applying) {
            self.last_pull = Some(started);
            self.signals.pulled();
        }
    }

    /// Takes in what one pass did and says how a Sync Now caller sees it.
    fn record(&mut self, report: &PassReport) -> TriggerSyncResult {
        // A pass the pause cut failed nothing: the pass after the resume goes on from it.
        if report.error().is_some_and(SyncError::is_cancelled) {
            return TriggerSyncResult::blocked(Blocked::Paused, None);
        }
        self.engine = Some(report.final_state);
        match report.error() {
            Some(error) => self.pass_failed(error, report.final_state == SyncState::Offline),
            None if report.final_state == SyncState::Offline => {
                TriggerSyncResult::blocked(Blocked::Offline, None)
            }
            // The engine refuses a pull body that is not a sync envelope before the push, and
            // writes no success state for it (`state.rs`).
            None if report.final_state == SyncState::Refused => {
                let message = "the server answered the pull with something that is not a sync \
                               page; nothing was pushed";
                self.last_error = Some((message.to_owned(), SyncErrorCategory::ServerError));
                self.back_off();
                let mut result = TriggerSyncResult::blocked(Blocked::Failed, None);
                result.error = Some(message.to_owned());
                result
            }
            None => {
                self.rate_failures = 0;
                self.blocked_until = None;
                self.failures = 0;
                self.backoff_until = None;
                self.last_error = None;
                self.last_sync_at = Some(now_ms());
                TriggerSyncResult::ok()
            }
        }
    }
}

impl Loop {
    /// A pass or a first sync that failed: told, shown, and backed off (`429`: its window).
    fn pass_failed(&mut self, error: &SyncError, offline: bool) -> TriggerSyncResult {
        self.report(error);
        let category = SyncErrorCategory::of(error);
        self.last_error = Some((error.to_string(), category));
        if let Some(retry_after) = rate_limited(error) {
            self.rate_failures += 1;
            let wait = rate_limit_backoff(retry_after, self.rate_failures);
            self.blocked_until = Some(Instant::now() + wait);
        } else if !offline {
            self.failed(category);
        }
        if offline {
            return TriggerSyncResult::blocked(Blocked::Offline, None);
        }
        TriggerSyncResult::blocked(Blocked::Failed, Some(error.clone()))
    }

    /// `sync_error`, redacted by the service; dropped by it while telemetry is off.
    fn report(&self, error: &memry_core::api::errors::SyncError) {
        if let Some(telemetry) = &self.telemetry {
            telemetry.track_main_event(sync_error_event(error, |m| telemetry.redact_message(m)));
        }
    }

    /// What a failed open or pass leads to: a revoked device, a session the server refused for
    /// good and a pin mismatch end sync; an unreadable keychain waits on its ladder; anything
    /// else backs off. The open fetches the device directory with the session's tokens, so a
    /// refused refresh there latches too.
    fn failed(&mut self, category: SyncErrorCategory) {
        match category {
            SyncErrorCategory::DeviceRevoked | SyncErrorCategory::CertificatePinFailed => {
                self.latch(category);
            }
            SyncErrorCategory::AuthExpired if self.backend.refresh_refused() => {
                self.latch(category);
            }
            SyncErrorCategory::KeychainUnavailable => self.keychain_failed(),
            _ => self.back_off(),
        }
    }

    /// A snapshot came due: a pass, which ends with the push ([`run`]).
    pub(super) fn snapshot_tick(&mut self) {
        if let Some(driver) = &self.driver
            && driver.snapshots_due(now_ms())
        {
            self.request(Trigger::Push);
        }
    }

    /// Shutdown's final snapshot push (`stop-sync-runtime`): skipped while paused or with no
    /// driver open. Answered on every path; a dropped reply reads as done.
    pub(super) async fn final_snapshots(&mut self, deadline: Instant, reply: oneshot::Sender<()>) {
        if let Some(driver) = self.driver.clone().filter(|_| !self.paused) {
            let _ = tokio::time::timeout_at(deadline, driver.final_snapshots(deadline)).await;
        }
        let _ = reply.send(());
    }

    pub(super) async fn sync_now(&mut self, reply: oneshot::Sender<TriggerSyncResult>) {
        let facts = self.backend.auth_facts().await;
        if !facts.signed_in {
            let _ = reply.send(TriggerSyncResult::blocked(Blocked::SignedOut, None));
            return;
        }
        self.reevaluate_with(facts);
        if self.decision != GateDecision::Start {
            let _ = reply.send(self.blocked_result(Blocked::Unavailable));
            return;
        }
        if self.latched.is_some() {
            let _ = reply.send(self.blocked_result(Blocked::Failed));
            return;
        }
        let resume = self.resume_trigger();
        self.backoff_until = None;
        if self.paused
            && let Err(error) = self.set_paused(false).await
        {
            tracing::error!(%error, "could not persist the end of the pause");
        }
        if let Some(reason) = self.blocked() {
            let _ = reply.send(self.blocked_result(reason));
            return;
        }
        // A running pass may have read the feed before this request: the answer comes from the
        // next pass that starts.
        let target = self.next_id;
        self.request(resume);
        self.waiters.push((target, reply));
    }

    pub(super) fn blocked_result(&self, reason: Blocked) -> TriggerSyncResult {
        let mut result = TriggerSyncResult::blocked(reason, None);
        if reason == Blocked::Failed && self.latched.is_some() {
            result.error = self.last_error.as_ref().map(|(message, _)| message.clone());
            return result;
        }
        if reason == Blocked::Failed
            && let Some(until) = self.blocked_until
        {
            let secs = until
                .saturating_duration_since(Instant::now())
                .as_secs_f64()
                .ceil();
            result.error = Some(format!("Rate limited. Resuming in {secs}s."));
        }
        result
    }

    pub(super) fn answer(&mut self, id: u64, result: TriggerSyncResult) {
        let mut kept = Vec::new();
        for (target, reply) in self.waiters.drain(..) {
            if target <= id {
                let _ = reply.send(result.clone());
            } else {
                kept.push((target, reply));
            }
        }
        self.waiters = kept;
    }
}

/// `Some(retry_after)` for a `429`.
fn rate_limited(error: &SyncError) -> Option<Option<Duration>> {
    match error {
        SyncError::Api {
            source: ApiError::RateLimited { retry_after_s, .. },
        } => Some(retry_after_s.map(Duration::from_secs)),
        SyncError::Api {
            source: ApiError::Status { status: 429, .. },
        } => Some(None),
        _ => None,
    }
}
