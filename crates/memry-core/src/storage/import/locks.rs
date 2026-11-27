//! The vault lock baselines and file modes of the import, written through their owner
//! ([`vault_locks`]). Device-local and never synced; desktop only, as the locks are.

use super::{ImportWriter, failed};
use crate::api::errors::StorageError;
use crate::domain::vault_locks;
use crate::storage::nested_tx;

/// One `vault_lock_baselines` row: a locked note's text as Electron last wrote or accepted it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportLockBaseline {
    pub note_id: String,
    pub content: String,
    /// Electron's `generateContentHash`, the hash the desktop lock guard computes.
    pub content_hash: String,
    /// Electron's `updated_at` in epoch ms.
    pub updated_at: i64,
}

/// One `vault_lock_file_modes` row: the bits a file had before a lock made it read-only.
///
/// It is written with no identity, as Electron's older rows are: Electron's `ino:birthtimeMs`
/// is not the desktop lock guard's `ino:birth_nanos`, and reads as a replaced file whose
/// read-only bits replace `mode`. With none, the guard binds the file it finds at the next open
/// and keeps `mode`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportFileMode {
    pub path: String,
    pub mode: u32,
}

impl ImportWriter {
    /// Writes the lock baselines and file modes through [`vault_locks`], in one transaction.
    pub fn put_lock_state(
        &mut self,
        baselines: &[ImportLockBaseline],
        modes: &[ImportFileMode],
    ) -> Result<(), StorageError> {
        let tx = nested_tx::begin(&self.data).map_err(failed)?;
        for row in baselines {
            vault_locks::write_baseline(
                &tx,
                &row.note_id,
                &row.content,
                &row.content_hash,
                row.updated_at,
            )?;
        }
        for row in modes {
            vault_locks::record_file_mode(&tx, &row.path, row.mode, None)?;
        }
        tx.commit().map_err(failed)
    }
}
