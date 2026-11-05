//! One pass of the index: which notes, read and measured in bounded batches, then the core
//! search reindex.
//!
//! A note's property values are read with its text and stored with its row (`note_properties`),
//! each typed by the definitions as the pass found them. A pass first reads again every note
//! holding a name whose definition changed since the rows were typed (`retypeIndexedProperties`),
//! or every note when the index never recorded the definitions (an index from before the rows
//! were filled), and records them unless it was stopped. A note it could not read, or that is
//! in the large-file class, loses its rows (Electron's `note.properties ?? {}`): none typed
//! otherwise survives, and an unread note is owed to the next pass anyway. A pass whose
//! definitions did not read reads nothing and is owed again.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::api::search::Search;
use memry_core::api::vault::Vault;
use memry_core::domain::note_properties::retyped;
use memry_core::domain::note_stats::{MeasuredFile, Unindexed};
use memry_core::domain::search::LinkChanges;
use memry_core::markdown::shared::markdown_class::{
    MarkdownClassThresholds, classify_markdown_content, classify_markdown_stat,
};

use memry_core::seams::secure_store::SecureStore;

use super::{BATCH, BATCH_BYTES, Backfilled, IndexError, IndexProgress};
use crate::notes::properties::{file_properties, read_definition_types};
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
    /// Holds the device key the definitions' records are read under.
    store: Arc<dyn SecureStore>,
}

/// The definitions a pass types the property values it reads with, and the notes it owes them.
pub(super) struct Typing {
    types: HashMap<String, String>,
    /// Every note is read: the index never recorded the definitions.
    pub all: bool,
    /// The notes holding a name whose definition changed since their rows were typed.
    pub retype: BTreeSet<String>,
    /// What the index records once the pass finished, when it changed.
    record: Option<BTreeMap<String, String>>,
}

/// What a pass did, and what it leaves owed.
pub(super) struct Pass {
    pub done: Backfilled,
    /// The notes whose file could not be read.
    pub unread: Vec<String>,
    /// Ended by `stop` before it finished.
    pub stopped: bool,
    /// The notes whose rows it wrote.
    pub written: Vec<String>,
}

enum Read {
    File(MeasuredFile),
    /// Gone, or not text: nothing to measure.
    Skipped,
    /// In the large-file class: not measured, and its property rows go.
    Large,
    /// Owed to the next pass; its property rows go.
    Failed,
}

impl Indexer {
    pub fn new(vault: &OpenVault, store: Arc<dyn SecureStore>) -> Self {
        Self {
            root: vault.path.clone(),
            vault: vault.vault.clone(),
            search: vault.search.clone(),
            store,
        }
    }

    /// The definitions' types. Their failure fails the pass, which is owed again: no row is
    /// typed without them.
    fn types(&self) -> Result<HashMap<String, String>, IndexError> {
        read_definition_types(&self.root, &self.vault, self.store.clone()).map_err(|error| {
            IndexError::Storage(StorageError::Failed {
                what: format!("the property definitions did not read: {error}"),
            })
        })
    }

    /// The definitions as they are, and the notes whose rows were typed with others.
    pub(super) fn typing(&self) -> Result<Typing, IndexError> {
        let types = self.types()?;
        let now: BTreeMap<String, String> = types.clone().into_iter().collect();
        let before = self.search.properties_typed_with()?;
        let retype = match &before {
            Some(before) => {
                let names = retyped(before, &now);
                if names.is_empty() {
                    BTreeSet::new()
                } else {
                    tracing::info!(scope = "note_index", ?names, "definitions changed type");
                    self.search
                        .notes_holding_properties(names)?
                        .into_iter()
                        .collect()
                }
            }
            None => BTreeSet::new(),
        };
        Ok(Typing {
            types,
            all: before.is_none(),
            retype,
            record: (before.as_ref() != Some(&now)).then_some(now),
        })
    }

    /// [`Self::typing`] of a pass that reads every note.
    pub(super) fn typing_all(&self) -> Result<Typing, IndexError> {
        let types = self.types()?;
        Ok(Typing {
            record: Some(types.clone().into_iter().collect()),
            types,
            all: true,
            retype: BTreeSet::new(),
        })
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
    /// then brings the search index up to date when `links` is owed, and hands `announce` the
    /// links it changed once they are committed. `progress` gets `built`
    /// of `total` first, after each batch and at the end, and none once `stop` is set; `stop`
    /// ends the pass between files and inside the search reindex.
    pub(super) fn pass(
        &self,
        notes: Vec<Unindexed>,
        typing: Typing,
        links: &mut bool,
        stop: &dyn Fn() -> bool,
        progress: &mut dyn FnMut(IndexProgress),
        announce: &dyn Fn(LinkChanges),
    ) -> Result<Pass, IndexError> {
        let total = notes.len();
        let mut pass = Pass {
            done: Backfilled {
                listed: total,
                ..Backfilled::default()
            },
            unread: Vec::new(),
            stopped: false,
            written: Vec::new(),
        };
        // Owed before the first write: a pass that ends early leaves it owed.
        *links |= total > 0;
        // No step once the vault is closing, the total included (`indexVault` after a cancel).
        let mut progress = |step| {
            if !stop() {
                progress(step);
            }
        };
        progress(IndexProgress { built: 0, total });
        let mut batch: Vec<MeasuredFile> = Vec::new();
        let mut bytes = 0;
        // Large notes: their property rows go with the unread ones'.
        let mut large = Vec::new();
        for note in notes {
            if stop() {
                pass.stopped = true;
                return Ok(pass);
            }
            match self.read(&note, &typing.types) {
                Read::File(file) => {
                    bytes += file.text.len();
                    batch.push(file);
                }
                Read::Skipped => pass.done.skipped += 1,
                Read::Large => {
                    pass.done.skipped += 1;
                    large.push(note.note_id);
                }
                Read::Failed => pass.unread.push(note.note_id),
            }
            if batch.len() >= BATCH || bytes >= BATCH_BYTES {
                self.write(&mut pass, std::mem::take(&mut batch))?;
                bytes = 0;
                progress(built(&pass, total));
            }
        }
        if !batch.is_empty() {
            self.write(&mut pass, batch)?;
        }
        pass.done.unread = pass.unread.len();
        large.extend(pass.unread.iter().cloned());
        self.search.forget_note_properties(large)?;
        progress(built(&pass, total));
        if *links {
            match self.search.reindex_until(stop)? {
                Some(changed) => {
                    *links = false;
                    if !changed.is_empty() {
                        announce(changed);
                    }
                }
                None => pass.stopped = true,
            }
        }
        // Every note it read is typed with them, and an unread one holds no rows.
        if !pass.stopped
            && let Some(record) = typing.record
        {
            self.search.set_properties_typed_with(record)?;
        }
        Ok(pass)
    }

    fn write(&self, pass: &mut Pass, batch: Vec<MeasuredFile>) -> Result<(), IndexError> {
        let ids: Vec<String> = batch.iter().map(|file| file.note_id.clone()).collect();
        pass.done.indexed += self.search.index_note_files(batch)?;
        pass.written.extend(ids);
        Ok(())
    }

    /// The note's file measured into its row, outside a pass; `false` when it has no markdown
    /// file, is in the large-file class or did not read.
    pub(super) fn measure_now(&self, note_id: &str) -> Result<bool, IndexError> {
        let queued = BTreeSet::from([note_id.to_owned()]);
        let Some(note) = self.listed(false, &queued)?.pop() else {
            return Ok(false);
        };
        let types = match self.types() {
            Ok(types) => types,
            Err(error) => {
                tracing::warn!(scope = "note_index", note_id, "left to a pass: {error}");
                return Ok(false);
            }
        };
        match self.read(&note, &types) {
            Read::File(file) => Ok(self.search.index_note_files(vec![file])? > 0),
            Read::Large | Read::Failed => {
                self.search.forget_note_properties(vec![note.note_id])?;
                Ok(false)
            }
            Read::Skipped => Ok(false),
        }
    }

    fn read(&self, note: &Unindexed, types: &HashMap<String, String>) -> Read {
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
                properties: file_properties(&file, types),
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
    Read::Large
}
