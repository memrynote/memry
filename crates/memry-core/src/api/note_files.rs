//! `NoteFiles`: path identity and file state of the vault's files, for the
//! desktop vault tier (Step 12). Reached from
//! [`crate::api::vault::Vault::note_files`]. Not exported over UniFFI: iOS keeps
//! no files of its own to track.
//!
//! The rules (path format, no case folding, hash ownership) are in
//! [`crate::domain::note_files`]. Every method blocks; the shell runs them in
//! `spawn_blocking`.

use crate::api::errors::StorageError;
use crate::domain::note_files::{self, NoteFile, NoteFileStat};
use crate::domain::owed_file_body;
use crate::domain::notes::local_only::{self, LocalOnlyChange};
use crate::storage::Db;

pub struct NoteFiles {
    db: Db,
}

impl NoteFiles {
    pub(crate) fn over(db: Db) -> Self {
        Self { db }
    }

    pub fn by_path(&self, path: &str) -> Result<Option<NoteFile>, StorageError> {
        let path = path.to_owned();
        self.db
            .read_blocking(move |conn| note_files::by_path(conn, &path))
    }

    pub fn by_id(&self, note_id: &str) -> Result<Option<NoteFile>, StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .read_blocking(move |conn| note_files::by_id(conn, &note_id))
    }

    pub fn upsert_stat(&self, stat: NoteFileStat) -> Result<(), StorageError> {
        self.db
            .call_blocking(move |conn| note_files::upsert_stat(conn, &stat))
    }

    pub fn set_hash(&self, note_id: &str, content_hash: Option<&str>) -> Result<(), StorageError> {
        let (note_id, hash) = (note_id.to_owned(), content_hash.map(str::to_owned));
        self.db
            .call_blocking(move |conn| note_files::set_hash(conn, &note_id, hash.as_deref()))
    }

    pub fn rename_path(&self, note_id: &str, new_path: &str) -> Result<(), StorageError> {
        let (note_id, new_path) = (note_id.to_owned(), new_path.to_owned());
        self.db
            .call_blocking(move |conn| note_files::rename_path(conn, &note_id, &new_path))
    }

    pub fn rename_prefix(&self, old_dir: &str, new_dir: &str) -> Result<usize, StorageError> {
        let (old_dir, new_dir) = (old_dir.to_owned(), new_dir.to_owned());
        self.db
            .call_blocking(move |conn| note_files::rename_prefix(conn, &old_dir, &new_dir))
    }

    pub fn remove(&self, note_id: &str) -> Result<bool, StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .call_blocking(move |conn| note_files::remove(conn, &note_id))
    }

    /// Whether the note's file holds a body its document has not taken
    /// ([`crate::domain::owed_file_body`]).
    pub fn owes_file_body(&self, note_id: &str) -> Result<bool, StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .read_blocking(move |conn| owed_file_body::owes(conn, &note_id))
    }

    /// Every live note that owes its file body, in id order.
    pub fn owed_file_bodies(&self) -> Result<Vec<String>, StorageError> {
        self.db.read_blocking(owed_file_body::list)
    }

    /// The document took the file (or the file no longer matters): the note no
    /// longer owes it. True when there was a marker.
    pub fn clear_owed_file_body(&self, note_id: &str) -> Result<bool, StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .call_blocking(move |conn| owed_file_body::clear(conn, &note_id))
    }

    pub fn list_missing_candidates(&self) -> Result<Vec<NoteFile>, StorageError> {
        self.db.read_blocking(note_files::list_missing_candidates)
    }

    pub fn list_paths(&self) -> Result<Vec<(String, String)>, StorageError> {
        self.db.read_blocking(note_files::list_paths)
    }

    /// Sets or clears the note's local-only flag and settles its outbox rows
    /// in the same transaction (see [`local_only::set`]).
    pub fn set_local_only(
        &self,
        note_id: &str,
        local_only: bool,
    ) -> Result<LocalOnlyChange, StorageError> {
        let note_id = note_id.to_owned();
        self.db.call_blocking(move |conn| {
            local_only::set(
                conn,
                &note_id,
                local_only,
                crate::api::tasks_write::now_ms(),
            )
        })
    }

    pub fn local_only_count(&self) -> Result<i64, StorageError> {
        self.db.read_blocking(note_files::local_only_count)
    }
}
