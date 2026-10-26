//! Open and close hooks: how later steps hang their services (watcher, sync supervisor,
//! index build) on the vault lifecycle without the session knowing them.

use std::sync::Arc;
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use super::OpenVault;

/// Where an open hook runs, in the order of `vault/index.ts:613-968`. Hooks of one stage run
/// in registration order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum OpenStage {
    /// Settings migrations (Step 09).
    Settings,
    /// Vault lock guard (Step 12).
    LockGuard,
    /// Watcher and activity log (Step 12).
    Watcher,
    /// Default task project and note fold start (Steps 14, 21).
    Defaults,
    /// After the status is `is_open`: the sync supervisor start (Step 17).
    SyncStart,
    /// Spawned on its own thread and never awaited: the background index build (Step 13).
    BackgroundIndex,
}

impl OpenStage {
    /// Runs before the status becomes `is_open`.
    pub fn before_open(self) -> bool {
        self < Self::SyncStart
    }
}

pub type OpenHook = Arc<dyn Fn(&OpenVault) -> Result<(), String> + Send + Sync>;
pub type CloseHook = Arc<dyn Fn(&OpenVault) + Send + Sync>;

pub(super) struct Hooks {
    pub open: Vec<(String, OpenStage, OpenHook)>,
    pub close: Vec<(String, CloseHook)>,
}

impl Hooks {
    pub fn new() -> Self {
        Self {
            open: Vec::new(),
            close: Vec::new(),
        }
    }
}

/// Runs `work` on its own thread and waits at most `deadline`. `false` means it overran: the
/// thread keeps running (a blocked call cannot be cancelled), and whatever it holds stays
/// held. The caller decides what that means for reopening the same databases.
pub(super) fn run_with_deadline(
    name: &str,
    deadline: Duration,
    work: impl FnOnce() + Send + 'static,
) -> bool {
    let (done, finished) = channel();
    let spawned = std::thread::Builder::new()
        .name(format!("hook-{name}"))
        .spawn(move || {
            work();
            let _ = done.send(());
        });
    if spawned.is_err() {
        tracing::error!(hook = name, "could not start a hook thread");
        return false;
    }
    let started = Instant::now();
    let ok = finished.recv_timeout(deadline).is_ok();
    if !ok {
        tracing::warn!(hook = name, ?deadline, "close hook overran its deadline");
    } else {
        tracing::debug!(hook = name, elapsed = ?started.elapsed(), "close hook finished");
    }
    ok
}
