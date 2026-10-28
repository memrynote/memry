//! `WriteBackReader`: what the desktop write-back (Step 12e-3) reads from the core for a
//! note's file. Reached from [`crate::api::vault::Vault::write_back`]. Not exported over
//! UniFFI: iOS has no vault files. The rules are in [`crate::domain::write_back`]. Every
//! method blocks; the shell runs them off the async runtime.

use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::domain::write_back::{self, BodyRead};
use crate::markdown::convert::api::Converter;
use crate::storage::Db;

pub struct WriteBackReader {
    db: Db,
}

impl WriteBackReader {
    pub(crate) fn over(db: Db) -> Self {
        Self { db }
    }

    /// [`write_back::body_for_file`].
    pub fn body(
        &self,
        converter: &Converter,
        note_id: &str,
        note_path: &str,
        file_body: &str,
    ) -> Result<BodyRead, CrdtError> {
        self.db
            .call_blocking(move |conn| {
                Ok(write_back::body_for_file(
                    conn, converter, note_id, note_path, file_body,
                ))
            })
            .map_err(CrdtError::from)?
    }

    /// [`write_back::keep_replaced`].
    pub fn keep_replaced(
        &self,
        note_id: &str,
        content: &str,
        body: &str,
    ) -> Result<bool, StorageError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
        self.db.call_blocking(move |conn| {
            Ok(write_back::keep_replaced(conn, note_id, content, body, now))
        })?
    }

    /// [`write_back::title`].
    pub fn title(&self, note_id: &str) -> Result<Option<String>, StorageError> {
        self.db
            .read_blocking(move |conn| write_back::title(conn, note_id))
    }
}
