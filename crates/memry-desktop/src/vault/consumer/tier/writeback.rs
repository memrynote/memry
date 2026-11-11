//! The write-back side of [`VaultTier`]: what reaches the open vault's write-back from outside
//! (schedules, flushes, the quit steps) and the reconcile that ends each walk.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast;

use super::VaultTier;
use crate::editor::versions::close_step;
use crate::session::Session;
use crate::shell::shutdown::{StepFn, writeback_flush_timeout};
use crate::vault::consumer::AfterWalk;
use crate::vault::writeback::{Pass, WriteBack, WriteBackFailed, reconcile};

impl VaultTier {
    /// Writes the note's body to its vault file, on the write-back thread
    /// ([`crate::vault::writeback`]). The editor (Step 14) calls it once a body edit is durable,
    /// the sync driver (Step 17) once a page committed. Nothing happens while no vault is open.
    pub fn schedule(&self, note_id: &str) {
        match self.current() {
            Some(open) => open.writeback.schedule(note_id),
            // The next open's reconcile writes it: its body moved after its row was stamped.
            None => tracing::warn!(
                scope = "vault_writeback",
                note_id,
                "no vault is open: the file is written on the next open"
            ),
        }
    }

    /// What the open vault's write-back did for the note (e2e build), `None` before any schedule.
    #[cfg(feature = "e2e")]
    pub fn writeback_debug(&self, id: &str) -> Option<crate::vault::writeback::WriteBackDebug> {
        self.current()?.writeback.debug(id)
    }

    /// Every note whose file could not be updated from its body, once per run of failures.
    pub fn subscribe_failures(&self) -> broadcast::Receiver<WriteBackFailed> {
        self.failures.subscribe()
    }

    /// Runs every scheduled write-back of the open vault now and waits, at most `timeout`, for
    /// them. True when none is left; also when no vault is open.
    pub fn flush(&self, timeout: Duration) -> bool {
        self.current()
            .is_none_or(|open| open.writeback.flush(timeout))
    }

    /// The quit steps of the vault the shell registers, by step name: `flush-writebacks`
    /// ([`Self::flush_step`]), `flush-activity-log` and `close-snapshots`
    /// (`editor::versions::close_step`).
    pub fn quit_steps(self: &Arc<Self>, session: &Session) -> [(&'static str, StepFn); 3] {
        [
            ("flush-writebacks", self.flush_step()),
            ("flush-activity-log", self.activity().flush_step()),
            ("close-snapshots", close_step(session.clone())),
        ]
    }

    /// The `flush-writebacks` shutdown step: the scheduled write-backs run within
    /// [`writeback_flush_timeout`] of what is left, so the steps behind keep their share. Passes
    /// still left then run in the vault close (`close-vault`), bounded only by the sequence
    /// budget; the step itself succeeds, since a failed step would end the sequence before
    /// that close.
    pub fn flush_step(self: &Arc<Self>) -> StepFn {
        let tier = self.clone();
        Arc::new(move |_, deadline| {
            let tier = tier.clone();
            Box::pin(async move {
                let timeout = writeback_flush_timeout(deadline.remaining());
                tokio::task::spawn_blocking(move || tier.flush(timeout))
                    .await
                    .map(drop)
                    .map_err(|error| error.to_string())
            })
        })
    }
}

/// The write-back's reconcile, once a walk ended.
pub(super) fn after_walk(pass: &Arc<Pass>, writeback: &Arc<WriteBack>) -> AfterWalk {
    let (pass, writeback) = (pass.clone(), writeback.clone());
    Box::new(move |stopped| reconcile(&pass, &writeback, stopped))
}
