//! One pass of the loop: the task that runs it, and what the loop takes from its report.

use std::sync::Arc;
use std::time::Duration;

use memry_core::api::errors::{ApiError, SyncError};
use memry_core::sync::engine::PassReport;
use memry_core::sync::outbox;
use memry_core::sync::state::SyncState;
use tokio::time::Instant;

use super::{Loop, blocking, now_ms};
use crate::sync::backend::{SyncBackend, SyncPasses};
use crate::sync::error_category::SyncErrorCategory;
use crate::sync::result::{SyncNowBlockedReason as Blocked, TriggerSyncResult};
use crate::sync::triggers::{MAX_CLOCK_SKEW_MS, Trigger, rate_limit_backoff};

/// What a pass task hands back.
pub(super) struct PassDone {
    pub(super) id: u64,
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
    let report = match &driver {
        Ok(driver) => driver.run_pass(trigger.pass_trigger()).await,
        Err(_) => None,
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
                tracing::warn!(%error, "sync did not start; retried on the next trigger");
                self.last_error = Some((error.to_string(), SyncErrorCategory::of(&error)));
                self.answer(
                    done.id,
                    TriggerSyncResult::blocked(Blocked::Failed, Some(error)),
                );
                return;
            }
        };
        if self.paused {
            driver.pause();
        }
        self.driver = Some(Arc::clone(&driver));
        let result = match &done.report {
            None => TriggerSyncResult::blocked(Blocked::Paused, None),
            Some(report) => self.record(report, done.started),
        };
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
        }
        match report.error() {
            Some(error) => {
                if let Some(retry_after) = rate_limited(error) {
                    self.rate_failures += 1;
                    let wait = rate_limit_backoff(retry_after, self.rate_failures);
                    self.blocked_until = Some(Instant::now() + wait);
                }
                self.last_error = Some((error.to_string(), SyncErrorCategory::of(error)));
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
                let mut result = TriggerSyncResult::blocked(Blocked::Failed, None);
                result.error = Some(message.to_owned());
                result
            }
            None => {
                self.rate_failures = 0;
                self.blocked_until = None;
                self.last_error = None;
                self.last_sync_at = Some(now_ms());
                TriggerSyncResult::ok()
            }
        }
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
