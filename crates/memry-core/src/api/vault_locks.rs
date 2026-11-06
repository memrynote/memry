//! `LockStore`: the vault's read-only locks ([`crate::domain::vault_locks`]),
//! for the desktop lock guard and commands (Step 14e). Reached from
//! [`crate::api::vault::Vault::locks`]. Not exported over UniFFI: iOS keeps no
//! vault files to lock. Every method blocks; the shell runs them in
//! `spawn_blocking`.

use crate::api::errors::StorageError;
use crate::api::tasks_write::now_ms;
use crate::domain::vault_locks::{self, LockState, SetOutcome, TargetKind};
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
}
