//! Device-local rows of the import: Electron's local settings rows into `local_settings` and
//! the two `meta` keys Electron keeps in its settings table. Neither syncs.

use rusqlite::params;

use super::{ImportWriter, failed};
use crate::api::errors::StorageError;
use crate::storage::nested_tx;

/// One Electron `settings` row that stays on the device, under its Electron key and value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportLocalSetting {
    pub key: String,
    pub value: String,
    /// Electron's `modified_at` in epoch ms.
    pub updated_at: i64,
}

impl ImportWriter {
    /// Writes `rows` into `local_settings` verbatim, in one transaction.
    pub fn put_local_settings(&mut self, rows: &[ImportLocalSetting]) -> Result<(), StorageError> {
        let tx = nested_tx::begin(&self.data).map_err(failed)?;
        for row in rows {
            tx.execute(
                "INSERT INTO local_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
                params![row.key, row.value, row.updated_at],
            )
            .map_err(failed)?;
        }
        tx.commit().map_err(failed)
    }

    /// Writes one `meta` row. A staged pair is new, so a key written twice is a defect of the
    /// caller and fails.
    pub fn put_meta(&mut self, key: &str, value: &str) -> Result<(), StorageError> {
        self.data
            .execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                params![key, value],
            )
            .map(drop)
            .map_err(failed)
    }
}
