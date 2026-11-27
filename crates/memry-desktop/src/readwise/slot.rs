//! The open vault's Readwise run service (`scheduler::ReadwiseRuns`), Electron's per-vault
//! start and stop in `runtime-effects.ts`: built with every vault open, stopped with every close,
//! so a vault switch runs over the new vault's token and run state.

use std::sync::{Arc, Mutex, MutexGuard};

use super::scheduler::ReadwiseRuns;
use crate::session::{OpenStage, OpenVault, Session};

/// Builds the run service of a vault, `None` when it cannot run there (the builder logs why).
pub type BuildRuns = Arc<dyn Fn(&OpenVault) -> Option<Arc<ReadwiseRuns>> + Send + Sync>;

/// The open vault's run service, `None` while no vault is open.
#[derive(Default)]
pub struct ReadwiseSlot(Mutex<Option<Arc<ReadwiseRuns>>>);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl ReadwiseSlot {
    pub fn current(&self) -> Option<Arc<ReadwiseRuns>> {
        lock(&self.0).clone()
    }

    /// Builds the runs of every vault the session opens from here on and stops them on its
    /// close. A vault already open is the caller's: build it and pass it to [`Self::settle`].
    pub fn attach(self: &Arc<Self>, session: &Session, build: BuildRuns) {
        let slot = Arc::clone(self);
        // The open hooks run under the session's lifecycle lock after `open` is set, so `open`
        // is the open vault until they return.
        session.on_open(
            "readwise",
            OpenStage::SyncStart,
            Arc::new(move |open| {
                let old = slot.hold(build(open));
                stop(old);
                Ok(())
            }),
        );
        let slot = Arc::clone(self);
        session.on_close("readwise", Arc::new(move |_| slot.clear()));
    }

    /// Stops whatever it held, so a run never outlives its vault.
    pub fn clear(&self) {
        let old = lock(&self.0).take();
        stop(old);
    }

    /// Takes the build for `open`: holds and starts `built`, or stops what it held when the
    /// build failed. A result for a vault handle that is no longer the open one changes
    /// nothing: the launch build can finish after a switch, or after a close and reopen of the
    /// same vault. The handle, not the id, tells them apart.
    pub fn settle(&self, session: &Session, open: &OpenVault, built: Option<Arc<ReadwiseRuns>>) {
        // The check and the swap share the slot lock, so a close's `clear` after the check
        // stops what this holds.
        let old = {
            let slot = lock(&self.0);
            if session
                .current()
                .is_none_or(|current| !Arc::ptr_eq(&current.vault, &open.vault))
            {
                return;
            }
            Self::swap(slot, built)
        };
        stop(old);
    }

    fn hold(&self, built: Option<Arc<ReadwiseRuns>>) -> Option<Arc<ReadwiseRuns>> {
        Self::swap(lock(&self.0), built)
    }

    fn swap(
        mut slot: MutexGuard<'_, Option<Arc<ReadwiseRuns>>>,
        built: Option<Arc<ReadwiseRuns>>,
    ) -> Option<Arc<ReadwiseRuns>> {
        match built {
            Some(runs) => {
                runs.start();
                slot.replace(runs)
            }
            None => slot.take(),
        }
    }
}

/// Outside the slot lock: `stop` waits for the run in flight.
fn stop(old: Option<Arc<ReadwiseRuns>>) {
    if let Some(old) = old {
        old.stop();
    }
}
