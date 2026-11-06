//! `LockStore`: the vault's read-only locks ([`crate::domain::vault_locks`]),
//! for the desktop lock guard and commands (Step 14e). Reached from
//! [`crate::api::vault::Vault::locks`]. Not exported over UniFFI: iOS keeps no
//! vault files to lock. Every method blocks; the shell runs them in
//! `spawn_blocking`.

use crate::api::errors::StorageError;
use crate::api::tasks_write::now_ms;
use crate::domain::vault_locks::{self, Baseline, FileMode, LockState, SetOutcome, TargetKind};
use crate::storage::Db;

pub struct LockStore {
    db: Db,
}

impl LockStore {
    pub(crate) fn over(db: Db) -> Self {
        Self { db }
    }

    /// [`vault_locks::set`].
    pub fn set(
        &self,
        kind: TargetKind,
        target: &str,
        locked: bool,
    ) -> Result<SetOutcome, StorageError> {
        let target = target.to_owned();
        self.db
            .call_blocking(move |conn| vault_locks::set(conn, kind, &target, locked, now_ms()))
    }

    /// [`vault_locks::list`].
    pub fn list(&self) -> Result<LockState, StorageError> {
        self.db.read_blocking(vault_locks::list)
    }

    /// [`vault_locks::is_note_locked`].
    pub fn is_note_locked(
        &self,
        note_id: &str,
        note_path: Option<&str>,
    ) -> Result<bool, StorageError> {
        let (note_id, note_path) = (note_id.to_owned(), note_path.map(str::to_owned));
        self.db.read_blocking(move |conn| {
            vault_locks::is_note_locked(conn, &note_id, note_path.as_deref())
        })
    }

    /// [`vault_locks::folder_covering`].
    pub fn folder_covering(&self, relative_path: &str) -> Result<Option<String>, StorageError> {
        let relative_path = relative_path.to_owned();
        self.db
            .read_blocking(move |conn| vault_locks::folder_covering(conn, &relative_path))
    }

    /// [`vault_locks::baseline`].
    pub fn baseline(&self, note_id: &str) -> Result<Option<Baseline>, StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .read_blocking(move |conn| vault_locks::baseline(conn, &note_id))
    }

    /// [`vault_locks::write_baseline`], stamped now.
    pub fn write_baseline(
        &self,
        note_id: &str,
        content: &str,
        content_hash: &str,
    ) -> Result<(), StorageError> {
        let (note_id, content, hash) = (
            note_id.to_owned(),
            content.to_owned(),
            content_hash.to_owned(),
        );
        self.db.call_blocking(move |conn| {
            vault_locks::write_baseline(conn, &note_id, &content, &hash, now_ms())
        })
    }

    /// [`vault_locks::delete_baseline`].
    pub fn delete_baseline(&self, note_id: &str) -> Result<(), StorageError> {
        let note_id = note_id.to_owned();
        self.db
            .call_blocking(move |conn| vault_locks::delete_baseline(conn, &note_id))
    }

    /// [`vault_locks::baseline_note_ids`].
    pub fn baseline_note_ids(&self) -> Result<Vec<String>, StorageError> {
        self.db.read_blocking(vault_locks::baseline_note_ids)
    }

    /// [`vault_locks::file_mode`].
    pub fn file_mode(&self, path: &str) -> Result<Option<FileMode>, StorageError> {
        let path = path.to_owned();
        self.db
            .read_blocking(move |conn| vault_locks::file_mode(conn, &path))
    }

    /// [`vault_locks::record_file_mode`].
    pub fn record_file_mode(
        &self,
        path: &str,
        mode: u32,
        identity: Option<&str>,
    ) -> Result<(), StorageError> {
        let (path, identity) = (path.to_owned(), identity.map(str::to_owned));
        self.db.call_blocking(move |conn| {
            vault_locks::record_file_mode(conn, &path, mode, identity.as_deref())
        })
    }

    /// [`vault_locks::forget_file_mode`].
    pub fn forget_file_mode(&self, path: &str) -> Result<(), StorageError> {
        let path = path.to_owned();
        self.db
            .call_blocking(move |conn| vault_locks::forget_file_mode(conn, &path))
    }

    /// [`vault_locks::file_modes`].
    pub fn file_modes(&self) -> Result<Vec<(String, FileMode)>, StorageError> {
        self.db.read_blocking(vault_locks::file_modes)
    }
}
