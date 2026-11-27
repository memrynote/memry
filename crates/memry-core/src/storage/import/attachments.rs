//! Electron's attachment sync state: the four device-local tables of data migration 0034
//! (`attachment_files`, `attachment_upload_queue`, `attachment_download_failures`,
//! `deleted_asset_releases`). They keep Electron's shapes, so each row lands with its ids,
//! counts and instants unchanged and `sync::attachments::store` reads it as Electron's runners
//! read it. The store's own writers mint ids and stamp the current time, which an import must
//! not do, so the rows are inserted here.

use rusqlite::{Connection, Statement, params};

use super::{ImportWriter, failed};
use crate::api::errors::StorageError;
use crate::storage::nested_tx;

/// One `attachment_files` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportAttachmentFile {
    pub note_id: String,
    pub path: String,
    pub attachment_id: Option<String>,
    pub recorded_at: i64,
}

/// One `attachment_upload_queue` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportAttachmentUpload {
    pub id: String,
    pub note_id: String,
    pub disk_path: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One `attachment_download_failures` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportDownloadFailure {
    pub id: String,
    pub owner_id: String,
    pub attachment_id: String,
    pub reason: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub next_attempt_at: Option<i64>,
    pub updated_at: i64,
}

/// One `deleted_asset_releases` row; `attachment_ids` is the JSON text as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportAssetRelease {
    pub item_type: String,
    pub item_id: String,
    pub deleted_at: i64,
    pub attachment_ids: Option<String>,
}

impl ImportWriter {
    pub fn put_attachment_files(
        &mut self,
        rows: &[ImportAttachmentFile],
    ) -> Result<(), StorageError> {
        insert_all(
            &self.data,
            "INSERT INTO attachment_files (note_id, path, attachment_id, recorded_at)
             VALUES (?1, ?2, ?3, ?4)",
            rows,
            |stmt, r| stmt.execute(params![r.note_id, r.path, r.attachment_id, r.recorded_at]),
        )
    }

    pub fn put_attachment_uploads(
        &mut self,
        rows: &[ImportAttachmentUpload],
    ) -> Result<(), StorageError> {
        insert_all(
            &self.data,
            "INSERT INTO attachment_upload_queue
               (id, note_id, disk_path, attempts, last_error, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rows,
            |stmt, r| {
                stmt.execute(params![
                    r.id,
                    r.note_id,
                    r.disk_path,
                    r.attempts,
                    r.last_error,
                    r.created_at,
                    r.updated_at
                ])
            },
        )
    }

    pub fn put_download_failures(
        &mut self,
        rows: &[ImportDownloadFailure],
    ) -> Result<(), StorageError> {
        insert_all(
            &self.data,
            "INSERT INTO attachment_download_failures
               (id, owner_id, attachment_id, reason, attempts, last_error, next_attempt_at,
                updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rows,
            |stmt, r| {
                stmt.execute(params![
                    r.id,
                    r.owner_id,
                    r.attachment_id,
                    r.reason,
                    r.attempts,
                    r.last_error,
                    r.next_attempt_at,
                    r.updated_at
                ])
            },
        )
    }

    pub fn put_asset_releases(&mut self, rows: &[ImportAssetRelease]) -> Result<(), StorageError> {
        insert_all(
            &self.data,
            "INSERT INTO deleted_asset_releases (item_type, item_id, deleted_at, attachment_ids)
             VALUES (?1, ?2, ?3, ?4)",
            rows,
            |stmt, r| {
                stmt.execute(params![
                    r.item_type,
                    r.item_id,
                    r.deleted_at,
                    r.attachment_ids
                ])
            },
        )
    }
}

/// Inserts `rows` through one prepared statement in one transaction.
fn insert_all<T>(
    conn: &Connection,
    sql: &str,
    rows: &[T],
    insert: impl Fn(&mut Statement<'_>, &T) -> rusqlite::Result<usize>,
) -> Result<(), StorageError> {
    let tx = nested_tx::begin(conn).map_err(failed)?;
    {
        let mut stmt = tx.prepare(sql).map_err(failed)?;
        for row in rows {
            insert(&mut stmt, row).map_err(failed)?;
        }
    }
    tx.commit().map_err(failed)
}
