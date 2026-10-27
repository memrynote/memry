//! Where a note is, as far as the watcher has told anyone: the reported record first, then the
//! row. Removals, rescans and renames all ask here, so none of them reads a row that a report
//! has already made stale (`reported`).

use std::path::Path;

use memry_core::api::errors::StorageError;
use memry_core::domain::note_files::NoteFile;

use super::reconcile::Reconciler;
use super::rename::Pending;
use super::reported::Reported;
use crate::vault::path_key::folded_key;

/// A note and where it lives now.
#[derive(Debug, Clone)]
pub(super) struct Home {
    pub note_id: String,
    pub path: String,
    /// The content last reported for it, else the row's.
    pub hash: Option<String>,
    /// The row's size and indexed time (a note that moved keeps its old row's).
    pub size: Option<i64>,
    pub indexed_at: i64,
}

impl Home {
    pub fn pending(self) -> Pending {
        Pending {
            note_id: self.note_id,
            path: self.path,
            hash: self.hash,
        }
    }
}

/// `None` when the note was reported removed.
pub(super) fn home_of_row(reported: &Reported, row: &NoteFile) -> Option<Home> {
    if reported.is_removed(row) {
        return None;
    }
    let (path, hash) = match reported.of_note(&row.note_id) {
        Some(seen) => (seen.path.clone(), seen.hash.clone()),
        None => (row.path.clone(), row.content_hash.clone()),
    };
    Some(Home {
        note_id: row.note_id.clone(),
        path,
        hash,
        size: row.file_size,
        indexed_at: row.indexed_at,
    })
}

/// Whether `path`, spelled exactly so, is an entry of its folder. A volume that ignores case or
/// normalization lists only the spelling the file was given.
pub(super) fn spelling_listed(root: &Path, path: &str) -> bool {
    let full = root.join(path);
    let (Some(dir), Some(name)) = (full.parent(), full.file_name()) else {
        return false;
    };
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries
            .filter_map(Result::ok)
            .any(|entry| entry.file_name() == name)
    })
}

impl Reconciler {
    /// Every row, loaded at most once per batch (a vanished folder or a respelled path needs
    /// them all).
    pub(super) fn rows(&mut self) -> Result<&[NoteFile], StorageError> {
        if self.all_rows.is_none() {
            self.all_rows = Some(self.files.list_missing_candidates()?);
        }
        Ok(self.all_rows.as_deref().unwrap_or_default())
    }

    /// The note living at `rel`: what was reported for it, else its row (exact spelling, then
    /// the same file under another case or normalization).
    pub(super) fn home_at(&mut self, rel: &str) -> Result<Option<Home>, StorageError> {
        if let Some(seen) = self.reported.get(rel)
            && let Some(note_id) = &seen.note_id
        {
            return Ok(Some(Home {
                note_id: note_id.clone(),
                path: seen.path.clone(),
                hash: seen.hash.clone(),
                size: None,
                indexed_at: 0,
            }));
        }
        let key = folded_key(rel);
        if let Some(row) = self.files.by_path(rel)?
            && let Some(home) = home_of_row(&self.reported, &row)
            && folded_key(&home.path) == key
        {
            return Ok(Some(home));
        }
        if self.folded.is_none() {
            let mut by_key: std::collections::HashMap<String, Vec<usize>> = Default::default();
            for (at, row) in self.rows()?.iter().enumerate() {
                by_key.entry(folded_key(&row.path)).or_default().push(at);
            }
            self.folded = Some(by_key);
        }
        let rows = self.all_rows.as_deref().unwrap_or_default();
        let found = self
            .folded
            .as_ref()
            .and_then(|by_key| by_key.get(&key))
            .into_iter()
            .flatten()
            .filter_map(|at| home_of_row(&self.reported, &rows[*at]))
            .find(|home| folded_key(&home.path) == key);
        Ok(found)
    }

    /// The notes whose home is below the folder `rel`.
    pub(super) fn homes_under(&mut self, rel: &str) -> Result<Vec<Home>, StorageError> {
        // A name with a supported extension is a file: no folder to look under. Editors' temp
        // files (`a.md.sb-1234`) vanish by the dozen and must not each load the table.
        if crate::vault::file_types::is_supported_path(rel) {
            return Ok(Vec::new());
        }
        self.rows()?;
        let prefix = format!("{rel}/");
        Ok(self
            .all_rows
            .iter()
            .flatten()
            .filter_map(|row| home_of_row(&self.reported, row))
            .filter(|home| home.path.starts_with(&prefix))
            .collect())
    }
}
