//! The note index (Step 13e, #3530): tier 1 of ingest, Electron's `ingest-backfill.ts` and the
//! note-state projector. The vault tier gives every file its note and row (tier 0, from
//! `stat`); this measures the file's text into `note_stats` (word and character counts,
//! snippet, cover, task ids, header tags, journal day), all through core functions.
//!
//! - **Who triggers it.** One background task per open vault subscribes to the tier's
//!   [`Applied`] facts. `Added`, `Changed` and `Renamed` queue the note, `Removed` drops its
//!   row. The queue is worked [`IDLE_DELAY`] after the first fact that filled it, smallest file
//!   first, as `scheduleDrain` arms its timer once per burst: a stream of edits cannot hold
//!   the rest of the queue back. Nothing is worked before the open walk ends (`Indexed`):
//!   tier 0 goes first, and a pass beside a first walk would hold its database locks. The
//!   end of the walk and a lagged subscription (facts were lost, the walk's end among them,
//!   maybe) run a scan instead: every markdown note whose row is missing or names other
//!   bytes than its file ([`Search::unindexed_notes`]).
//! - **Links and body tags** have one owner, the core search reindex, which reads them from the
//!   note's document. A pass that measured anything ends with [`Search::reindex`].
//! - **Not measured:** a file past the large-file byte ceiling (Electron streams it; a
//!   follow-up), and a file that cannot be read (logged; the next scan tries again).
//! - [`NoteIndex::reindex`] (`vault_reindex`) measures every note again and reports its
//!   progress at most once per [`PROGRESS_INTERVAL`], never backwards, ending at the total.

mod progress;

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use memry_core::api::errors::StorageError;
use memry_core::api::search::Search;
use memry_core::api::vault::Vault;
use memry_core::domain::note_stats::{MeasuredFile, Unindexed};
use memry_core::markdown::shared::markdown_class::{
    MarkdownClassThresholds, classify_markdown_stat,
};
use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::TryRecvError;

pub use progress::{IndexProgress, ProgressThrottle};

use crate::session::projection::CancelToken;
use crate::session::{OpenStage, OpenVault, Session};
use crate::vault::config::read_vault_config;
use crate::vault::consumer::{Applied, VaultTier};
use crate::vault::journal_format::{normalize_journal_folder, parse_journal_date};
use crate::vault::note_file::read_note;

/// How long after the first queued fact the queue is worked (`IDLE_DELAY_MS`): a burst of
/// adds lands first.
pub const IDLE_DELAY: Duration = Duration::from_millis(500);
/// Progress goes out at most this often during a reindex.
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// Files measured per core write.
pub const BATCH: usize = 200;
/// How often the task looks for facts and for its cancel while idle.
const POLL: Duration = Duration::from_millis(50);

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("no vault is open")]
    NotOpen,
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
    /// Missing, unreadable or past the byte ceiling.
    pub skipped: usize,
    /// Core write calls, one per [`BATCH`] or less.
    pub writes: usize,
}

/// The note index of whichever vault is open. The app holds one.
pub struct NoteIndex {
    tier: Arc<VaultTier>,
    /// The open's facts, subscribed before its walk starts and taken by its task.
    facts: Mutex<Option<Receiver<Applied>>>,
    current: Mutex<Option<Arc<Indexer>>>,
}

impl NoteIndex {
    pub fn new(tier: Arc<VaultTier>) -> Arc<Self> {
        Arc::new(Self {
            tier,
            facts: Mutex::new(None),
            current: Mutex::new(None),
        })
    }

    /// Runs the index task as a background task of every open.
    pub fn register(self: &Arc<Self>, session: &Session) {
        let index = self.clone();
        // A stage before `Watcher`, whose walk publishes `Indexed`: the background task starts
        // after the open, by when a small vault's walk may have ended, and the task works
        // nothing before that fact.
        session.on_open(
            "note-index",
            OpenStage::LockGuard,
            Arc::new(move |_| {
                *lock(&index.facts) = Some(index.tier.subscribe());
                Ok(())
            }),
        );
        let index = self.clone();
        session.on_background(
            "note-index",
            Arc::new(move |vault, cancel| {
                let facts = lock(&index.facts)
                    .take()
                    .ok_or("the open subscribed no facts")?;
                let indexer = Arc::new(Indexer::new(vault));
                *lock(&index.current) = Some(indexer.clone());
                indexer.run(facts, cancel);
                let mut current = lock(&index.current);
                if current.as_ref().is_some_and(|c| Arc::ptr_eq(c, &indexer)) {
                    *current = None;
                }
                Ok(())
            }),
        );
    }

    /// Measures every note of the open vault again. Blocks; `progress` is called on this
    /// thread.
    pub fn reindex(
        &self,
        mut progress: impl FnMut(IndexProgress),
    ) -> Result<Backfilled, IndexError> {
        let indexer = lock(&self.current).clone().ok_or(IndexError::NotOpen)?;
        let notes = indexer.search.unindexed_notes(true)?;
        let mut throttle = ProgressThrottle::new(PROGRESS_INTERVAL);
        // A close ends the pass: it must not keep the closed vault's databases open.
        let closed = || {
            !lock(&self.current)
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &indexer))
        };
        let done = indexer.backfill(notes, &closed, &mut |step| {
            if throttle.offer(step, Instant::now()) {
                progress(step);
            }
        })?;
        Ok(done)
    }
}

/// One open vault's index.
pub struct Indexer {
    root: PathBuf,
    vault: Arc<Vault>,
    search: Arc<Search>,
    journal_folder: String,
    journal_format: String,
    /// One pass writes at a time: a reindex and the task's drain take turns per batch.
    work: Mutex<()>,
}

impl Indexer {
    pub fn new(vault: &OpenVault) -> Self {
        let config = read_vault_config(&vault.path);
        Self {
            root: vault.path.clone(),
            vault: vault.vault.clone(),
            search: vault.search.clone(),
            journal_folder: normalize_journal_folder(&config.journal_folder),
            journal_format: config.journal_date_format,
            work: Mutex::new(()),
        }
    }

    /// The task: facts in, passes out, until `cancel`.
    pub fn run(&self, mut facts: Receiver<Applied>, cancel: &CancelToken) {
        let mut queue: BTreeSet<String> = BTreeSet::new();
        let mut scan = false;
        let mut armed: Option<Instant> = None;
        let mut walked = false;
        while !cancel.is_cancelled() {
            match facts.try_recv() {
                Ok(
                    Applied::Added { note_id, .. }
                    | Applied::Changed { note_id, .. }
                    | Applied::Renamed { note_id, .. },
                ) => {
                    queue.insert(note_id);
                    armed = armed.or(Some(Instant::now()));
                }
                Ok(Applied::Removed { note_id, .. }) => {
                    queue.remove(&note_id);
                    if let Err(error) = self.search.forget_note_stats(&note_id) {
                        tracing::warn!(scope = "note_index", note_id, "row not dropped: {error}");
                    }
                }
                Ok(Applied::Indexed { .. }) => {
                    walked = true;
                    scan = true;
                    armed = armed.or(Some(Instant::now()));
                }
                Ok(Applied::Vault(_)) => {}
                Err(TryRecvError::Lagged(missed)) => {
                    tracing::warn!(scope = "note_index", missed, "facts were lost: scanning");
                    walked = true;
                    scan = true;
                    armed = armed.or(Some(Instant::now()));
                }
                Err(TryRecvError::Closed) => return,
                Err(TryRecvError::Empty) => {
                    let due = armed.is_none_or(|at| at.elapsed() >= IDLE_DELAY);
                    if walked && due && (scan || !queue.is_empty()) {
                        armed = None;
                        let notes = if std::mem::take(&mut scan) {
                            queue.clear();
                            self.search.unindexed_notes(false)
                        } else {
                            self.queued(std::mem::take(&mut queue))
                        };
                        self.pass(notes, cancel);
                    } else {
                        std::thread::sleep(POLL);
                    }
                }
            }
        }
    }

    /// One backfill of `notes`, its failure logged: the next scan tries again.
    fn pass(&self, notes: Result<Vec<Unindexed>, StorageError>, cancel: &CancelToken) {
        let stop = || cancel.is_cancelled();
        let outcome = notes
            .map_err(IndexError::from)
            .and_then(|notes| self.backfill(notes, &stop, &mut |_| {}));
        if let Err(error) = outcome {
            tracing::warn!(scope = "note_index", "index pass failed: {error}");
        }
    }

    fn queued(&self, ids: BTreeSet<String>) -> Result<Vec<Unindexed>, StorageError> {
        let files = self.vault.note_files();
        let mut notes = Vec::new();
        for note_id in ids {
            if let Some(row) = files.by_id(&note_id)?
                && row.file_type == "markdown"
            {
                notes.push(Unindexed {
                    note_id,
                    path: row.path,
                    file_size: row.file_size,
                });
            }
        }
        notes.sort_by_key(|note| note.file_size);
        Ok(notes)
    }

    /// Reads and measures `notes` in batches. `progress` gets `built` of `total` after each
    /// batch and once at the end; a `stop` ends the pass between files.
    pub fn backfill(
        &self,
        notes: Vec<Unindexed>,
        stop: &dyn Fn() -> bool,
        progress: &mut dyn FnMut(IndexProgress),
    ) -> Result<Backfilled, IndexError> {
        let total = notes.len();
        let mut done = Backfilled {
            listed: total,
            ..Backfilled::default()
        };
        progress(IndexProgress { built: 0, total });
        for chunk in notes.chunks(BATCH) {
            let mut batch = Vec::with_capacity(chunk.len());
            for note in chunk {
                if stop() {
                    return Ok(done);
                }
                match self.read(note) {
                    Some(file) => batch.push(file),
                    None => done.skipped += 1,
                }
            }
            if !batch.is_empty() {
                let _turn = lock(&self.work);
                done.indexed += self.search.index_note_files(batch)?;
                done.writes += 1;
            }
            progress(IndexProgress {
                built: done.indexed + done.skipped,
                total,
            });
        }
        if done.indexed > 0 {
            let _turn = lock(&self.work);
            self.search.reindex()?;
        }
        Ok(done)
    }

    fn read(&self, note: &Unindexed) -> Option<MeasuredFile> {
        let size = note.file_size.unwrap_or_default().max(0) as usize;
        if classify_markdown_stat(size, MarkdownClassThresholds::default()).is_some() {
            tracing::debug!(
                scope = "note_index",
                note_id = note.note_id,
                "large file: not measured"
            );
            return None;
        }
        match read_note(&self.root, &note.path) {
            Ok(Some(file)) => Some(MeasuredFile {
                note_id: note.note_id.clone(),
                file_hash: file.hash,
                date: self.journal_day(&note.path),
                text: file.raw,
            }),
            Ok(None) => None,
            Err(error) => {
                tracing::warn!(
                    scope = "note_index",
                    note_id = note.note_id,
                    "not read: {error}"
                );
                None
            }
        }
    }

    /// `extractDateFromPath`: the day a path under the journal folder names in its format.
    fn journal_day(&self, path: &str) -> Option<String> {
        if self.journal_folder.is_empty() {
            return None;
        }
        let stem = path
            .strip_prefix(&self.journal_folder)?
            .strip_prefix('/')?
            .strip_suffix(".md")?;
        parse_journal_date(stem, &self.journal_format).map(|date| date.to_string())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
