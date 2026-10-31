//! The note index (Step 13e, #3530): tier 1 of ingest, Electron's `ingest-backfill.ts` and the
//! note-state projector. The vault tier gives every file its note and row (tier 0, from
//! `stat`); this measures the file's text into `note_stats` (word and character counts,
//! snippet, cover, task ids, header tags, journal day), all through core functions.
//!
//! - **One task per open vault** does all of it, so no two passes interleave: it takes the
//!   tier's [`Applied`] facts and the `vault_reindex` requests in order ([`task`]), and parks
//!   between them.
//! - **What a fact owes.** `Added`, `Changed` and `Renamed` queue the note, worked
//!   [`IDLE_DELAY`] after the first fact that filled the queue, as `scheduleDrain` arms its
//!   timer once per burst. `Removed` drops its row. The end of the open walk (`Indexed`), a
//!   lagged subscription and a failed watcher owe a scan: the rows of notes with no markdown
//!   file are dropped, and every markdown note whose row is missing, names other bytes than its
//!   file or another journal day than its path is measured, with the queue
//!   ([`Indexer::scan`]). Nothing is worked, a reindex included, before the walk ends or a
//!   failed watcher means none will come: tier 0 goes first, and a pass beside a first walk
//!   holds its database locks.
//! - **The index converges.** A pass that does not finish (stopped, a failed write, a file that
//!   could not be read, a failed search reindex) leaves its work owed, and the next pass, after
//!   a backoff from [`RETRY_FIRST`] to [`RETRY_MAX`], pays it. Nothing waits for a file to
//!   change again, and a backoff never holds back a live fact's note. A finished pass ends the
//!   backoff.
//! - **Links, body tags and full text** have one owner, the core search reindex, which reads
//!   them from the note's document. It is owed at every open and after every pass that wrote a
//!   row, and stops when the vault closes ([`Search::reindex_until`]); a stopped one commits
//!   nothing to `index.db` and stays owed.
//! - **Not measured:** a file in the large-file class (Electron streams it; a follow-up).
//! - [`NoteIndex::reindex`] (`vault_reindex`) measures every note again, through the task once
//!   the open walk ended, and reports its progress at most once per [`PROGRESS_INTERVAL`],
//!   never backwards, ending at the total once every file was read. The open's pass, the first
//!   after the walk, reports the same way (Electron's `indexVault` on open, `0` of `0`
//!   included): the renderer refreshes the notes list on it. A close or a failed write ends a
//!   pass without the total, and the pass that pays the rest does not report.
//!
//! [`Search::reindex_until`]: memry_core::api::search::Search::reindex_until

mod pass;
mod progress;
mod task;

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use memry_core::api::errors::StorageError;
use tokio::sync::broadcast::Receiver;

pub use pass::Indexer;
pub use progress::{IndexProgress, ProgressThrottle};
pub use task::{TaskHandle, TaskInbox, task_channel};

use crate::session::{OpenStage, Session};
use crate::vault::consumer::{Applied, VaultTier};

/// How long after the first queued fact the queue is worked (`IDLE_DELAY_MS`): a burst of
/// adds lands first.
pub const IDLE_DELAY: Duration = Duration::from_millis(500);
/// Progress goes out at most this often during a reindex.
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// Files measured per core write, at most.
pub const BATCH: usize = 200;
/// File text one core write carries, at most: a batch of large notes stays small in memory.
pub const BATCH_BYTES: usize = 8 * 1024 * 1024;
/// The wait before the first retry of a pass that did not finish; doubled per failure.
pub const RETRY_FIRST: Duration = Duration::from_secs(1);
/// The longest wait between retries.
pub const RETRY_MAX: Duration = Duration::from_secs(300);

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("no vault is open")]
    NotOpen,
    /// The vault is open but its index task did not start, or stopped.
    #[error("the note index is not running for this vault")]
    NotRunning,
    #[error(transparent)]
    Storage(#[from] StorageError),
}

/// What one pass did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Backfilled {
    /// Notes the pass was given.
    pub listed: usize,
    /// Rows written.
    pub indexed: usize,
    /// Missing, or in the large-file class.
    pub skipped: usize,
    /// Could not be read: owed to the next pass.
    pub unread: usize,
}

/// The index of the open vault, as the app's commands reach it.
enum Slot {
    Closed,
    /// `start` waits for the background task, which takes it.
    Open {
        handle: TaskHandle,
        start: Option<(Receiver<Applied>, TaskInbox)>,
    },
    /// The open's task did not start, or ended on an error.
    Failed,
}

/// The note index of whichever vault is open. The app holds one.
pub struct NoteIndex {
    tier: Arc<VaultTier>,
    slot: Mutex<Slot>,
    report: Box<dyn Fn(IndexProgress) + Send + Sync>,
}

impl NoteIndex {
    /// `report` gets the progress of each open's pass, on the task's thread.
    pub fn new(
        tier: Arc<VaultTier>,
        report: impl Fn(IndexProgress) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            tier,
            slot: Mutex::new(Slot::Closed),
            report: Box::new(report),
        })
    }

    /// Runs the index task as a background task of every open, and stops it at the close.
    pub fn register(self: &Arc<Self>, session: &Session) {
        let index = self.clone();
        // A stage before `Watcher`, whose walk publishes `Indexed`: the background task starts
        // after the open, by when a small vault's walk may have ended.
        session.on_open(
            "note-index",
            OpenStage::LockGuard,
            Arc::new(move |_| {
                let (handle, inbox) = task_channel();
                let start = Some((index.tier.subscribe(), inbox));
                *lock(&index.slot) = Slot::Open { handle, start };
                Ok(())
            }),
        );
        let index = self.clone();
        session.on_background(
            "note-index",
            Arc::new(move |vault, cancel| {
                let started = match &mut *lock(&index.slot) {
                    Slot::Open { handle, start } => start.take().map(|s| (handle.clone(), s)),
                    _ => None,
                };
                // The slot is not this open's (a close came first): it is left as it is.
                let Some((handle, (facts, inbox))) = started else {
                    return Err("the open subscribed no facts".into());
                };
                let ended = Indexer::new(vault).run(facts, inbox, cancel, &index.report);
                if ended.is_err() {
                    let mut slot = lock(&index.slot);
                    if matches!(&*slot, Slot::Open { handle: open, .. } if open.same(&handle)) {
                        *slot = Slot::Failed;
                    }
                }
                ended
            }),
        );
        let index = self.clone();
        // Wakes the parked task: the close's cancel token alone does not.
        session.on_close(
            "note-index",
            Arc::new(move |_| {
                if let Slot::Open { handle, .. } =
                    std::mem::replace(&mut *lock(&index.slot), Slot::Closed)
                {
                    handle.stop();
                }
            }),
        );
    }

    /// Measures every note of the open vault again, through its task, once the open walk ended
    /// and after the pass the task is in. Blocks; `progress` is called on the task's thread.
    pub fn reindex(
        &self,
        progress: impl FnMut(IndexProgress) + Send + 'static,
    ) -> Result<Backfilled, IndexError> {
        let handle = match &*lock(&self.slot) {
            Slot::Closed => return Err(IndexError::NotOpen),
            Slot::Failed => return Err(IndexError::NotRunning),
            Slot::Open { handle, .. } => handle.clone(),
        };
        let answer = handle.reindex(Box::new(progress));
        answer
            .and_then(|answer| answer.recv().ok())
            .unwrap_or_else(|| Err(self.gone()))
    }

    /// Why a request got no answer: the vault closed, or its task ended.
    fn gone(&self) -> IndexError {
        match &*lock(&self.slot) {
            Slot::Closed => IndexError::NotOpen,
            _ => IndexError::NotRunning,
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
