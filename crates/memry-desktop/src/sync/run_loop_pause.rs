//! Pausing and closing: what ends a pass before it is done.

use memry_core::api::errors::StorageError;
use memry_core::sync::pause;
use tokio::sync::oneshot;

use super::Loop;
use crate::sync::result::{SyncNowBlockedReason as Blocked, TriggerSyncResult};
use crate::sync::triggers::Trigger;

impl Loop {
    /// The pause switch: a resume runs a pass and reopens the socket.
    pub(super) async fn pause_command(
        &mut self,
        paused: bool,
        reply: oneshot::Sender<Result<(), StorageError>>,
    ) {
        let resume = self.resume_trigger();
        let outcome = self.set_paused(paused).await;
        if outcome.is_ok() && !paused {
            self.request(resume);
            self.ensure_socket();
        }
        let _ = reply.send(outcome);
    }

    /// Ending a clock-skew pause polls the server clock again (a foreground pass), so a clock
    /// that is still off pauses at once.
    pub(super) fn resume_trigger(&self) -> Trigger {
        if self.skew_paused {
            Trigger::Foreground
        } else {
            Trigger::Explicit
        }
    }

    /// Persists the pause, then tells the driver. A pause also cuts the pass in flight and
    /// answers its Sync Now callers `paused`, as Electron's `pause` aborts its run
    /// (`engine.ts:663-668`): the driver's own pause only stops the next pass, so without the
    /// cut a push already under way goes on after the user paused.
    pub(super) async fn set_paused(&mut self, paused: bool) -> Result<(), StorageError> {
        let db = self.db.clone();
        let write = move || db.call_blocking(move |conn| pause::write(conn, paused));
        tokio::task::spawn_blocking(write)
            .await
            .map_err(|error| StorageError::Failed {
                what: format!("the pause write task failed: {error}"),
            })??;
        self.paused = paused;
        self.skew_paused = false;
        if let Some(driver) = &self.driver {
            if paused {
                driver.pause();
            } else {
                driver.resume();
            }
        }
        if paused {
            self.stop_socket();
            self.abort_pass(Blocked::Paused);
        }
        Ok(())
    }

    /// Aborts a running pass, drops the trailing one and answers every Sync Now caller with
    /// `reason`. A cut pass leaves what it committed; the rest runs again on the next pass.
    fn abort_pass(&mut self, reason: Blocked) {
        if let Some(running) = self.running.take() {
            running.abort();
        }
        self.trailing = None;
        for (_, reply) in self.waiters.drain(..) {
            let _ = reply.send(TriggerSyncResult::blocked(reason, None));
        }
    }

    /// Aborts a running pass, answers whoever waited on it, and forgets the driver and the
    /// at-rest key. The key goes even with no driver kept: the open that installed it may have
    /// failed, or its pass was cut before it handed the driver back. A loop that never opened
    /// one leaves the key alone: another owner may have installed it.
    pub(super) fn close_driver(&mut self) {
        self.stop_socket();
        self.abort_pass(Blocked::Unavailable);
        self.push_at = None;
        self.engine = None;
        self.driver = None;
        self.seen_clock = None;
        if std::mem::take(&mut self.opened) {
            self.backend.close();
        }
    }
}
