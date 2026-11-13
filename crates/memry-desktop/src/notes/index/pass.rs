//! One pass of the index: which notes, read and measured in bounded batches, then the core
//! search reindex.
//!
//! A note's property values are read with its text and stored with its row (`note_properties`),
//! each typed by the definitions as the pass found them. A pass first reads again every note
//! holding a name whose definition changed since the rows were typed (`retypeIndexedProperties`),
//! or every note when the index never recorded the definitions (an index from before the rows
//! were filled), and records them unless it was stopped. A name it reads with no definition
//! is given a learned type ([`super::learn`]), and the next pass retypes the rows holding it. A note it could
//! not read, or that is in the large-file class, loses its rows (Electron's
//! `note.properties ?? {}`): none typed otherwise survives, and an unread note is owed to the
//! next pass anyway. A pass whose definitions did not read reads nothing and is owed again.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::api::search::Search;
use memry_core::api::vault::Vault;
use memry_core::domain::note_properties::retyped;
use memry_core::domain::note_stats::{MeasuredFile, Unindexed};
use memry_core::domain::search::LinkChanges;

use memry_core::seams::secure_store::SecureStore;

use super::learn::{Learner, order};
use super::{BATCH, BATCH_BYTES, Backfilled, IndexError, IndexProgress};
use crate::notes::properties::{file_properties, read_definition_types};
use crate::session::OpenVault;
use crate::vault::note_file::{NoteFileError, large_by_size, large_file_class, read_note};

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
    /// The notes the pass reads only to retype them: no type is learned from them
    /// ([`super::learn`]).
    pub retype_only: BTreeSet<String>,
    /// What the index records once the pass finished, when it changed.
    record: Option<BTreeMap<String, String>>,
}

impl Typing {
    /// Nothing owed, for a listing outside a pass.
    fn none() -> Self {
        Self {
            types: HashMap::new(),
            all: false,
            retype: BTreeSet::new(),
            retype_only: BTreeSet::new(),
            record: None,
        }
    }
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
    /// It learned a type ([`super::learn`]): the rows holding its name are owed it.
    pub learned: bool,
    /// The search reindex ran to its end: the body tags are the files' ([`Self::define_tags`]).
    pub reindexed: bool,
}

enum Read {
    File(MeasuredFile),
    /// Gone, not text, or bytes the vault tier has not taken yet: nothing to measure.
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
            retype_only: BTreeSet::new(),
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
            retype_only: BTreeSet::new(),
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
    /// does not list when the file's bytes and its journal day did not change, then the ones
    /// `typing` owes a retype, which it marks read only for that.
    pub(super) fn listed(
        &self,
        scan: bool,
        queued: &BTreeSet<String>,
        typing: &mut Typing,
    ) -> Result<Vec<Unindexed>, IndexError> {
        let mut notes = if scan { self.scan(false)? } else { Vec::new() };
        let listed: BTreeSet<String> = notes.iter().map(|note| note.note_id.clone()).collect();
        typing.retype_only = typing
            .retype
            .iter()
            .filter(|id| !queued.contains(*id) && !listed.contains(*id))
            .cloned()
            .collect();
        let queued: BTreeSet<String> = queued.union(&typing.retype).cloned().collect();
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
        Ok(notes)
    }

    /// Reads and measures `notes` in batches of at most [`BATCH`] files and [`BATCH_BYTES`],
    /// then brings the search index up to date when `links` is owed, and hands `announce` the
    /// links it changed once they are committed, with the relation values `links` holds: those
    /// written since the last announce, this pass's and [`Self::measure_now`]'s. `progress` gets `built`
    /// of `total` first, after each batch and at the end, and none once `stop` is set; `stop`
    /// ends the pass between files and inside the search reindex.
    pub(super) fn pass(
        &self,
        mut notes: Vec<Unindexed>,
        typing: Typing,
        links: &mut Option<LinkChanges>,
        stop: &dyn Fn() -> bool,
        progress: &mut dyn FnMut(IndexProgress),
        announce: &dyn Fn(LinkChanges),
    ) -> Result<Pass, IndexError> {
        order(&mut notes, &self.root);
        let total = notes.len();
        let mut pass = Pass {
            done: Backfilled {
                listed: total,
                ..Backfilled::default()
            },
            unread: Vec::new(),
            stopped: false,
            written: Vec::new(),
            learned: false,
            reindexed: false,
        };
        // Owed before the first write: a pass that ends early leaves it owed.
        if total > 0 {
            links.get_or_insert_default();
        }
        // No step once the vault is closing, the total included (`indexVault` after a cancel).
        let mut progress = |step| {
            if !stop() {
                progress(step);
            }
        };
        progress(IndexProgress { built: 0, total });
        let mut learner = Learner::new(self.root.clone(), self.vault.clone(), self.store.clone());
        // Large notes: their property rows go with the unread ones'.
        let mut large = Vec::new();
        // Learns what it read however the reads end: stopped, done, or a write failed.
        let read = || -> Result<(), IndexError> {
            let mut batch: Vec<MeasuredFile> = Vec::new();
            let mut bytes = 0;
            for note in notes {
                if stop() {
                    pass.stopped = true;
                    return Ok(());
                }
                match self.read(&note, &typing.types) {
                    Read::File(file) => {
                        if !typing.retype_only.contains(&file.note_id) {
                            learner.read(&file.properties, &typing.types);
                        }
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
                    self.write(&mut pass, links, std::mem::take(&mut batch))?;
                    bytes = 0;
                    progress(built(&pass, total));
                }
            }
            if !batch.is_empty() {
                self.write(&mut pass, links, batch)?;
            }
            Ok(())
        };
        let read = read();
        pass.learned = learner.learn();
        read?;
        if pass.stopped {
            return Ok(pass);
        }
        pass.done.unread = pass.unread.len();
        large.extend(pass.unread.iter().cloned());
        self.search.forget_note_properties(large)?;
        progress(built(&pass, total));
        if links.is_some() {
            match self.search.reindex_until(stop)? {
                Some(mut changed) => {
                    changed.extend(links.take().unwrap_or_default());
                    if !changed.is_empty() {
                        announce(changed);
                    }
                    pass.reindexed = true;
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

    /// Mints a definition for every tag of the notes `only` names, or of every note, that has
    /// none (#4418, Electron's `ensureTagDefinitions` for each file it indexes), once a pass's
    /// search reindex brought the body tags up to date. A pass mints for the files it read; the
    /// open's pass for every note, which defines the tags of a vault an older build indexed. A
    /// failure is logged, and the next pass that reads the file, or the next open, tries again.
    pub(super) fn define_tags(&self, only: Option<Vec<String>>) {
        if only.as_ref().is_some_and(Vec::is_empty) {
            return;
        }
        let defined = self.search.used_tags(only).and_then(|tags| {
            let hub =
                self.vault
                    .tag_hub(self.store.clone())
                    .map_err(|error| StorageError::Failed {
                        what: format!("no device identity: {error}"),
                    })?;
            hub.define_used(&tags)
        });
        match defined {
            Ok(0) => {}
            Ok(created) => tracing::info!(scope = "note_index", created, "tags defined"),
            Err(error) => {
                tracing::warn!(
                    scope = "note_index",
                    "tags not defined, retried later: {error}"
                );
            }
        }
    }

    fn write(
        &self,
        pass: &mut Pass,
        links: &mut Option<LinkChanges>,
        batch: Vec<MeasuredFile>,
    ) -> Result<(), IndexError> {
        let ids: Vec<String> = batch.iter().map(|file| file.note_id.clone()).collect();
        let refs = self.search.index_note_files(batch)?;
        links.get_or_insert_default().extend(refs);
        pass.done.indexed += ids.len();
        pass.written.extend(ids);
        Ok(())
    }

    /// The note's file measured into its row, outside a pass; `false` when it has no markdown
    /// file, is in the large-file class or did not read. It learns no definition: the write's
    /// own fact queues the note for a pass, which does. The relation values it wrote join
    /// `refs`, which the next pass announces with its links.
    pub(super) fn measure_now(
        &self,
        note_id: &str,
        refs: &mut LinkChanges,
    ) -> Result<bool, IndexError> {
        let queued = BTreeSet::from([note_id.to_owned()]);
        let Some(note) = self.listed(false, &queued, &mut Typing::none())?.pop() else {
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
            Read::File(file) => {
                refs.extend(self.search.index_note_files(vec![file])?);
                Ok(true)
            }
            Read::Large | Read::Failed => {
                self.search.forget_note_properties(vec![note.note_id])?;
                Ok(false)
            }
            Read::Skipped => Ok(false),
        }
    }

    /// The note's file measured, when it holds the bytes the vault tier took. The row's reading
    /// is what an outside edit of a note with no baseline is measured against
    /// (`identity::properties::edited`, whose `previous` is the row's `content_hash`), so it
    /// stays the reading of the text the note's document and record took. Any other bytes are
    /// skipped, and the tier's own fact queues the note again once it took them: an edit it has
    /// not applied yet, one it retries (the record or the body refused it, #4225), and one the
    /// document did not take. The row's `file_hash` moves on to those bytes already, so a move
    /// before the retry pairs on them; the index goes by it only for a note whose document
    /// holds no text of its file (`content_hash` none). A note with no row takes the file's
    /// reading all the same, so a rebuilt or dropped index fills it again: no reading is
    /// there to keep.
    /// A note under an exclude pattern or in a hidden folder keeps its reading too, through a
    /// full reindex or a retype: the tier applies no edit of its file, so neither its record nor
    /// its search sees one.
    fn read(&self, note: &Unindexed, types: &HashMap<String, String>) -> Read {
        if large_by_size(note.file_size.unwrap_or_default().max(0) as u64).is_some() {
            return large(note);
        }
        match read_note(&self.root, &note.path) {
            // The file grew past the class since its row was written.
            Ok(Some(file)) if large_file_class(&file.raw).is_some() => large(note),
            Ok(Some(file)) => {
                // A tier that knows no bytes takes any reading.
                let taken = match self.vault.note_files().by_id(&note.note_id) {
                    Ok(row) => row.and_then(|row| row.content_hash.or(row.file_hash)),
                    Err(error) => {
                        tracing::warn!(
                            scope = "note_index",
                            note_id = note.note_id,
                            "the row's bytes did not read, retried later: {error}"
                        );
                        return Read::Failed;
                    }
                };
                if taken.is_some_and(|taken| taken != file.hash) {
                    match self.search.note_stats(&note.note_id) {
                        Ok(None) => {}
                        Ok(Some(_)) => {
                            tracing::debug!(
                                scope = "note_index",
                                note_id = note.note_id,
                                "bytes the tier has not taken: left to its fact"
                            );
                            return Read::Skipped;
                        }
                        Err(error) => {
                            tracing::warn!(
                                scope = "note_index",
                                note_id = note.note_id,
                                "the index row did not read, retried later: {error}"
                            );
                            return Read::Failed;
                        }
                    }
                }
                Read::File(MeasuredFile {
                    note_id: note.note_id.clone(),
                    properties: file_properties(&file, types).unwrap_or_default(),
                    file_hash: file.hash,
                    text: file.raw,
                })
            }
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
