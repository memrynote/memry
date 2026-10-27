//! Which vault paths name the same file on a case-insensitive or normalization-insensitive
//! file system (APFS and NTFS by default).
//!
//! `note_files.path` is a binary-compared unique key and the core folds nothing, so
//! `Note.md`, `note.md` and an NFC and an NFD spelling of `café.md` are four rows to it. On
//! such a volume they are one file, and two rows for one file means a write-back that
//! overwrites another note. The vault tier therefore asks [`PathIndex::check`] before every
//! `upsert_stat` and `rename_path`, on every platform: a vault is copied between volumes.
//!
//! The key is NFC, then lowercase. That is the common denominator of APFS (normalization
//! insensitive, case insensitive by default) and NTFS (case insensitive by the upcase
//! table); it can call two files on a case-sensitive Linux volume a collision, and then the
//! second is refused instead of risking an overwrite elsewhere.

use std::collections::HashMap;

use memry_core::api::errors::StorageError;
use memry_core::api::note_files::NoteFiles;
use unicode_normalization::UnicodeNormalization;

/// The comparison key of a vault-relative path.
pub fn folded_key(path: &str) -> String {
    path.nfc().collect::<String>().to_lowercase()
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("path {wanted:?} names the same file as {existing:?} of another note")]
pub struct PathCollision {
    pub wanted: String,
    pub existing: String,
    pub existing_note_id: String,
}

/// One row of the table, as the index holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Holder {
    note_id: String,
    path: String,
}

/// Two notes whose paths share a key: found when the index was loaded from a table that
/// already holds both (rows from before this check, a vault copied from a case-sensitive
/// volume). Both stay in the index, so neither can be taken over silently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownCollision {
    pub note_ids: Vec<String>,
}

/// Every path of the vault by folded key. Load it once per session and keep it in step with
/// the table; a lookup is one hash probe.
#[derive(Debug, Default)]
pub struct PathIndex {
    /// folded key -> every note holding a path with that key (one, unless the table already
    /// held a collision)
    by_key: HashMap<String, Vec<Holder>>,
    /// note id -> its folded key, so a move costs two probes, not a scan.
    by_note: HashMap<String, String>,
}

impl PathIndex {
    pub fn load(files: &NoteFiles) -> Result<Self, StorageError> {
        let mut index = Self::default();
        for (note_id, path) in files.list_paths()? {
            index.insert(&note_id, &path);
        }
        for collision in index.collisions() {
            // Note ids only: a path is derived from what the person wrote.
            tracing::warn!(
                scope = "path_key",
                "notes {} hold paths that are one file on a case- or normalization-insensitive volume",
                collision.note_ids.join(", ")
            );
        }
        Ok(index)
    }

    /// The keys that more than one note holds.
    pub fn collisions(&self) -> Vec<KnownCollision> {
        let mut found: Vec<_> = self
            .by_key
            .values()
            .filter(|holders| holders.len() > 1)
            .map(|holders| KnownCollision {
                note_ids: holders.iter().map(|h| h.note_id.clone()).collect(),
            })
            .collect();
        found.sort_by(|a, b| a.note_ids.cmp(&b.note_ids));
        found
    }

    /// `Ok` when `path` is free for `note_id`: no other note holds a path with the same key.
    /// A note moving to a different spelling of its own path (a case-only rename) is free.
    pub fn check(&self, note_id: &str, path: &str) -> Result<(), PathCollision> {
        let other = self
            .by_key
            .get(&folded_key(path))
            .and_then(|holders| holders.iter().find(|h| h.note_id != note_id));
        match other {
            Some(holder) => Err(PathCollision {
                wanted: path.to_owned(),
                existing: holder.path.clone(),
                existing_note_id: holder.note_id.clone(),
            }),
            None => Ok(()),
        }
    }

    /// Records `path` for `note_id` after the table accepted it. The note's earlier path is
    /// forgotten; another note's entry under the same key is kept.
    pub fn insert(&mut self, note_id: &str, path: &str) {
        self.remove_note(note_id);
        let key = folded_key(path);
        self.by_note.insert(note_id.to_owned(), key.clone());
        self.by_key.entry(key).or_default().push(Holder {
            note_id: note_id.to_owned(),
            path: path.to_owned(),
        });
    }

    /// Forgets `note_id` and only `note_id`.
    pub fn remove_note(&mut self, note_id: &str) {
        let Some(key) = self.by_note.remove(note_id) else {
            return;
        };
        if let Some(holders) = self.by_key.get_mut(&key) {
            holders.retain(|h| h.note_id != note_id);
            if holders.is_empty() {
                self.by_key.remove(&key);
            }
        }
    }

    /// Number of notes in the index.
    pub fn len(&self) -> usize {
        self.by_note.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_note.is_empty()
    }
}
