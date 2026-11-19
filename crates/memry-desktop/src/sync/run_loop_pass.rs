//! One pass of the loop: the task that runs it, and what the loop takes from its report.

use std::sync::Arc;
use std::time::Duration;

use memry_core::api::errors::{ApiError, SyncError};
use memry_core::sync::engine::PassReport;
use memry_core::sync::outbox;
use memry_core::sync::state::SyncState;
use tokio::sync::oneshot;
use tokio::time::Instant;

use super::{Loop, blocking, now_ms};
use crate::sync::backend::{SyncBackend, SyncPasses};
use crate::sync::error_category::SyncErrorCategory;
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
    pending: Option<u32>,
}

/// Runs one pass on `existing`, or on a driver opened for it.
pub(super) async fn run(
    id: u64,
    trigger: Trigger,
    existing: Option<Arc<dyn SyncPasses>>,
    backend: Arc<dyn SyncBackend>,
    db: memry_core::storage::Db,
    entitled: bool,
) -> PassDone {
    let started = Instant::now();
    let driver = match existing {
        Some(driver) => Ok(driver),
        None => backend.open().await.inspect(|driver| {
            if entitled {
                driver.set_entitled(true);
            }
        }),
    };
    let report = match (&driver, trigger) {
        (Ok(driver), Trigger::Hint { cursor }) => driver.wake(cursor).await,
        (Ok(driver), _) => driver.run_pass(trigger.pass_trigger()).await,
        (Err(_), _) => None,
    };
    // The pass ends with the snapshots due, so their gate reads the pull it just ran.
    if let (Ok(driver), Some(_)) = (&driver, &report) {
        driver.push_due_snapshots(now_ms()).await;
    }
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
        pending,
    }
}

impl Loop {
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
        let fresh = !self
            .driver
            .as_ref()
            .is_some_and(|d| Arc::ptr_eq(d, &driver));
        if let Some(telemetry) = self.telemetry.as_ref().filter(|_| fresh) {
            driver.observe(Arc::new(ConflictTelemetry(Arc::clone(telemetry))));
        }
        for observer in self.observers.iter().filter(|_| fresh) {
            driver.observe(Arc::clone(observer));
        }
        if self.paused {
            driver.pause();
        }
        self.driver = Some(Arc::clone(&driver));
        let result = match &done.report {
            // A hint the engine dropped: this device already holds its change.
            None if matches!(done.trigger, Trigger::Hint { .. }) && !self.paused => {
                TriggerSyncResult::ok()
            }
            None => TriggerSyncResult::blocked(Blocked::Paused, None),
            Some(report) => self.record(report, done.started),
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
                match self.set_paused(true).await {
                    Ok(()) => self.skew_paused = true,
                    Err(error) => tracing::error!(%error, "could not persist the clock-skew pause"),
                }
            }
        }
        let result = if self.paused {
            TriggerSyncResult::blocked(Blocked::Paused, None)
        } else {
            result
        };
        self.answer(done.id, result);
    }

    /// Takes in what one pass did and says how a Sync Now caller sees it.
    fn record(&mut self, report: &PassReport, started: Instant) -> TriggerSyncResult {
        self.engine = Some(report.final_state);
        if report.transitions.contains(&SyncState::Applying) {
            self.last_pull = Some(started);
            self.signals.pulled();
        }
        match report.error() {
            Some(error) => {
                self.report(error);
                let category = SyncErrorCategory::of(error);
                self.last_error = Some((error.to_string(), category));
                if let Some(retry_after) = rate_limited(error) {
                    self.rate_failures += 1;
                    let wait = rate_limit_backoff(retry_after, self.rate_failures);
                    self.blocked_until = Some(Instant::now() + wait);
                } else if report.final_state != SyncState::Offline {
                    self.failed(category);
                }
                if report.final_state == SyncState::Offline {
                    return TriggerSyncResult::blocked(Blocked::Offline, None);
                }
                TriggerSyncResult::blocked(Blocked::Failed, Some(error.clone()))
            }
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
