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
        if !paused {
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

    /// Persists the pause, then holds it in memory and tells the driver, even when the write
    /// failed, as Electron's `setPaused` does: the pause asked for holds until a restart. A pause
    /// also cuts the pass in flight and answers its Sync Now callers `paused`, as Electron's
    /// `pause` aborts its run (`engine.ts:663-668`). The driver makes the cut: its requests answer
    /// `Cancelled`, and the pass ends on its own. Aborting the task instead would drop it at an
    /// await, and with it whatever it held in memory there.
    pub(super) async fn set_paused(&mut self, paused: bool) -> Result<(), StorageError> {
        let db = self.db.clone();
        let write = move || db.call_blocking(move |conn| pause::write(conn, paused));
        let written = match tokio::task::spawn_blocking(write).await {
            Ok(written) => written,
            Err(error) => Err(StorageError::Failed {
                what: format!("the pause write task failed: {error}"),
            }),
        };
        self.paused = paused;
        self.pause.send_replace(paused);
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
            self.release_waiters(Blocked::Paused);
        }
        written
    }

    /// Aborts a running pass, with the driver it runs on about to go, and releases its waiters.
    fn abort_pass(&mut self, reason: Blocked) {
        if let Some(running) = self.running.take() {
            running.abort();
        }
        self.release_waiters(reason);
    }

    /// Drops the trailing pass and answers every Sync Now caller with `reason`.
    fn release_waiters(&mut self, reason: Blocked) {
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
