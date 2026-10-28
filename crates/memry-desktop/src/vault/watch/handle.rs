//! The worker's queue, and what the rest of the app may put on it.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};

use super::event::EventSink;

pub(super) enum Msg {
    Paths(Vec<PathBuf>),
    Rescan,
    Error(notify::Error),
    /// A consumer could not apply what was reported for this vault-relative path.
    Forget(String),
}

/// What a rescan does with a file no row names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NewFiles {
    /// Reports it `Added`: the consumer gives it a note.
    Report,
    /// Looks at it only when it can be a moved note: its size is that of a note the pass
    /// found missing. Nothing adopts new files, so reading every one of them on every rescan
    /// would cost a vault-sized read for nothing. A live event still reports a new file.
    PairOnly,
}

/// What a consumer of the events asks of the watcher.
#[derive(Clone)]
pub struct WatchHandle {
    tx: SyncSender<Msg>,
    resync: Arc<AtomicBool>,
}

impl WatchHandle {
    pub(super) fn new(tx: SyncSender<Msg>, resync: Arc<AtomicBool>) -> Self {
        Self { tx, resync }
    }

    /// Reports `rel` again at the next debounce: what was reported for it is forgotten, so the
    /// path is compared with its row again. Dropped once the watcher stopped.
    pub fn forget(&self, rel: String) {
        if let Err(TrySendError::Full(_)) = self.tx.try_send(Msg::Forget(rel)) {
            tracing::warn!(
                scope = "vault_watch",
                "a retry was dropped; the next open looks at the file again"
            );
        }
    }

    /// The consumer dropped events: everything reported is forgotten and a rescan with
    /// changes compares the disk with the rows, which hold what was applied.
    pub fn resync(&self) {
        self.resync.store(true, Ordering::Relaxed);
    }
}

/// Lets events through until the watcher is stopped. `stop` closes it before anything else, so
/// no event leaves a watcher once its stop has begun, even while its thread is still finishing
/// a step (a folder of a million files) and the next vault is already open: the sink is shared
/// and an event carries no vault identity. Only a call already inside the sink can still land.
#[derive(Clone)]
pub(super) struct Gate(Arc<AtomicBool>);

impl Gate {
    pub(super) fn open() -> Self {
        Self(Arc::new(AtomicBool::new(true)))
    }

    pub(super) fn wrap(&self, sink: EventSink) -> EventSink {
        let open = self.0.clone();
        Arc::new(move |event| {
            if open.load(Ordering::SeqCst) {
                sink(event);
            }
        })
    }

    pub(super) fn close(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
