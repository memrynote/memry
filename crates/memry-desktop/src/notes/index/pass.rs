//! One pass of the index: which notes, read and measured in bounded batches, then the core
//! search reindex.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::api::search::Search;
use memry_core::api::vault::Vault;
use memry_core::domain::note_stats::{MeasuredFile, Unindexed};
use memry_core::markdown::shared::markdown_class::{
    MarkdownClassThresholds, classify_markdown_content, classify_markdown_stat,
};

use super::{BATCH, BATCH_BYTES, Backfilled, IndexError, IndexProgress};
use crate::session::OpenVault;
use crate::vault::note_file::{NoteFileError, read_note};

/// One open vault's index. A note's journal day is its record's, which the core reads when it
/// stores the row (`Search::index_note_files`): the vault tier decided which day a file is
/// when it named it (`vault::journal_format::JournalDays`), so no path is read for a day here.
/// An unreadable or changed vault config changes no stored day, and a day owed a move of its
/// file has none.
pub struct Indexer {
    root: PathBuf,
    pub(super) vault: Arc<Vault>,
    pub(super) search: Arc<Search>,
}

/// What a pass did, and what it leaves owed.
pub(super) struct Pass {
    pub done: Backfilled,
    /// The notes whose file could not be read.
    pub unread: Vec<String>,
    /// Ended by `stop` before it finished.
    pub stopped: bool,
}

enum Read {
    File(MeasuredFile),
    /// Gone, or in the large-file class: nothing to measure.
    Skipped,
    /// Owed to the next pass.
    Failed,
}

impl Indexer {
    pub fn new(vault: &OpenVault) -> Self {
        Self {
            root: vault.path.clone(),
            vault: vault.vault.clone(),
            search: vault.search.clone(),
        }
    }

    /// Drops the rows of notes that lost their markdown file while no fact said so, then
    /// lists the notes to measure: those without a current row, or every one (`all`).
    pub fn scan(&self, all: bool) -> Result<Vec<Unindexed>, StorageError> {
        let pruned = self.search.prune_note_stats()?;
        if pruned > 0 {
            tracing::info!(scope = "note_index", pruned, "rows of gone notes dropped");
        }
        self.search.unindexed_notes(all)
    }

    /// The notes a pass works: a scan's when one is owed, and the queued ones, which a scan
    /// does not list when the file's bytes and its journal day did not change. Smallest file
    /// first.
    pub(super) fn listed(
        &self,
        scan: bool,
        queued: &BTreeSet<String>,
    ) -> Result<Vec<Unindexed>, IndexError> {
        let mut notes = if scan { self.scan(false)? } else { Vec::new() };
        let listed: BTreeSet<String> = notes.iter().map(|note| note.note_id.clone()).collect();
        let files = self.vault.note_files();
        for note_id in queued.difference(&listed) {
            if let Some(row) = files.by_id(note_id)?
                && row.file_type == "markdown"
            {
                notes.push(Unindexed {
                    note_id: note_id.clone(),
                    path: row.path,
                    file_size: row.file_size,
                });
            }
        }
        notes.sort_by_key(|note| note.file_size);
        Ok(notes)
    }

    /// Reads and measures `notes` in batches of at most [`BATCH`] files and [`BATCH_BYTES`],
    /// then brings the search index up to date when `links` is owed. `progress` gets `built`
    /// of `total` first, after each batch and at the end; `stop` ends the pass between files
    /// and inside the search reindex.
    pub(super) fn pass(
        &self,
        notes: Vec<Unindexed>,
        links: &mut bool,
        stop: &dyn Fn() -> bool,
        progress: &mut dyn FnMut(IndexProgress),
    ) -> Result<Pass, IndexError> {
        let total = notes.len();
        let mut pass = Pass {
            done: Backfilled {
                listed: total,
                ..Backfilled::default()
            },
            unread: Vec::new(),
            stopped: false,
        };
        // Owed before the first write: a pass that ends early leaves it owed.
        *links |= total > 0;
        progress(IndexProgress { built: 0, total });
        let mut batch: Vec<MeasuredFile> = Vec::new();
        let mut bytes = 0;
        for note in notes {
            if stop() {
                pass.stopped = true;
                return Ok(pass);
            }
            match self.read(&note) {
                Read::File(file) => {
                    bytes += file.text.len();
                    batch.push(file);
                }
                Read::Skipped => pass.done.skipped += 1,
                Read::Failed => pass.unread.push(note.note_id),
            }
            if batch.len() >= BATCH || bytes >= BATCH_BYTES {
                pass.done.indexed += self.search.index_note_files(std::mem::take(&mut batch))?;
                bytes = 0;
                progress(built(&pass, total));
            }
        }
        if !batch.is_empty() {
            pass.done.indexed += self.search.index_note_files(batch)?;
        }
        pass.done.unread = pass.unread.len();
        progress(built(&pass, total));
        if *links {
            match self.search.reindex_until(stop)? {
                Some(_) => *links = false,
                None => pass.stopped = true,
            }
        }
        Ok(pass)
    }

    fn read(&self, note: &Unindexed) -> Read {
        let size = note.file_size.unwrap_or_default().max(0) as usize;
        if classify_markdown_stat(size, MarkdownClassThresholds::default()).is_some() {
            return large(note);
        }
        match read_note(&self.root, &note.path) {
            // The file grew past the class since its row was written.
            Ok(Some(file))
                if classify_markdown_content(&file.raw, MarkdownClassThresholds::default())
                    .large_file
                    .is_some() =>
            {
                large(note)
            }
            Ok(Some(file)) => Read::File(MeasuredFile {
                note_id: note.note_id.clone(),
                file_hash: file.hash,
                text: file.raw,
            }),
            // Gone: its `Removed` fact, or the next scan's prune, drops the row.
            Ok(None) => Read::Skipped,
            Err(NoteFileError::TooLarge) => large(note),
            // Not text: no later read differs until the file changes, which a fact reports.
            Err(NoteFileError::NotUtf8) => Read::Skipped,
            Err(error) => {
                tracing::warn!(
                    scope = "note_index",
                    note_id = note.note_id,
                    "not read, retried later: {error}"
                );
                Read::Failed
            }
        }
    }
}

fn built(pass: &Pass, total: usize) -> IndexProgress {
    IndexProgress {
        built: pass.done.indexed + pass.done.skipped + pass.unread.len(),
        total,
    }
}

fn large(note: &Unindexed) -> Read {
    tracing::debug!(
        scope = "note_index",
        note_id = note.note_id,
        "large file: not measured"
    );
    Read::Skipped
}
