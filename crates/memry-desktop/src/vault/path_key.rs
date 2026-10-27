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

/// Every path of the vault by folded key. Load it once per session and keep it in step with
/// the table; a lookup is one hash probe.
#[derive(Debug, Default)]
pub struct PathIndex {
    /// folded key -> (note id, exact path)
    by_key: HashMap<String, (String, String)>,
    /// note id -> its folded key, so a move costs two probes, not a scan.
    by_note: HashMap<String, String>,
}

impl PathIndex {
    pub fn load(files: &NoteFiles) -> Result<Self, StorageError> {
        let mut index = Self::default();
        for (note_id, path) in files.list_paths()? {
            index.insert(&note_id, &path);
        }
        Ok(index)
    }

    /// `Ok` when `path` is free for `note_id`: no other note holds a path with the same key.
    /// A note moving to a different spelling of its own path (a case-only rename) is free.
    pub fn check(&self, note_id: &str, path: &str) -> Result<(), PathCollision> {
        match self.by_key.get(&folded_key(path)) {
            Some((holder, existing)) if holder != note_id => Err(PathCollision {
                wanted: path.to_owned(),
                existing: existing.clone(),
                existing_note_id: holder.clone(),
            }),
            _ => Ok(()),
        }
    }

    /// Records `path` for `note_id` after the table accepted it.
    pub fn insert(&mut self, note_id: &str, path: &str) {
        self.remove_note(note_id);
        let key = folded_key(path);
        self.by_note.insert(note_id.to_owned(), key.clone());
        self.by_key
            .insert(key, (note_id.to_owned(), path.to_owned()));
    }

    pub fn remove_note(&mut self, note_id: &str) {
        if let Some(key) = self.by_note.remove(note_id) {
            self.by_key.remove(&key);
        }
    }

    pub fn len(&self) -> usize {
        self.by_key.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_key.is_empty()
    }
}
