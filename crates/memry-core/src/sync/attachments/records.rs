//! What a finished transfer writes locally (#3535): Electron's tail of
//! `onSaved` (`ipc/sync-attachment-handlers.ts:540-552`,
//! `sync/note-attachment-metadata.ts:10-60`) and of an interactive download
//! (`:460-466`).

use rusqlite::{Connection, OptionalExtension, params};

use super::store::{download_failures, files, upload_queue};
use crate::api::errors::StorageError;
use crate::domain::notes;

/// Records an upload of the vault file `path` (vault-relative) of `owner_id`
/// that the server now holds as `attachment_id`.
///
/// When the owner is a live note, the id joins the note's
/// `attachmentReferences` as a union, in one transaction with the note's
/// outbox row (`notes::add_attachment_reference`): no id another device added
/// is dropped, and the push tells every other device. Then the file record,
/// the cleared download failure and the dropped queue row, in one more
/// transaction. A crash between the two leaves the queue row; its retry finds
/// the id among the note's references and reuses it.
///
/// Returns whether a note recorded the reference. `false` is an owner with no
/// live note row (a canvas or home page records its own), which the caller
/// logs: the reference will not sync from here.
pub fn record_uploaded(
    conn: &Connection,
    owner_id: &str,
    path: &str,
    attachment_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let referenced = note_is_live(conn, owner_id)?;
    if referenced {
        notes::add_attachment_reference(conn, owner_id, attachment_id, device_id, now_ms)?;
    }
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    download_failures::clear(&transaction, owner_id, attachment_id)?;
    files::record(&transaction, owner_id, path, attachment_id, now_ms)?;
    upload_queue::clear(&transaction, owner_id, path)?;
    transaction.commit().map_err(failed)?;
    Ok(referenced)
}

/// Records a download that landed at the vault file `path` of `owner_id`, so
/// the backfill does not read it as a new file (`recordFile`), and forgets its
/// failures (`markDownloadSucceeded`).
pub fn record_downloaded(
    conn: &Connection,
    owner_id: &str,
    path: &str,
    attachment_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    files::record(&transaction, owner_id, path, attachment_id, now_ms)?;
    download_failures::clear(&transaction, owner_id, attachment_id)?;
    transaction.commit().map_err(failed)
}

fn note_is_live(conn: &Connection, note_id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NULL",
        params![note_id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(failed)
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
