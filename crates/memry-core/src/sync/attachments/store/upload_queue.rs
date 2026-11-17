//! `attachment_upload_queue`: the durable outbox of attachment uploads
//! (`attachment-outbox.ts`). A row is written before an upload starts and
//! deleted only once the server accepted the file, so an upload that fails or
//! is cut short by quit is retried after a restart instead of lost.
//!
//! Retry rule (`retryOpensAt`, `attachment-outbox.ts:19-24,133-136`): a row
//! that failed `n` times waits `min(1 min * 2^(n-1), 6 h)` after its last
//! write. A row crossing [`STUCK_UPLOAD_ATTEMPTS`] is flagged once by the
//! runner. Rows have no attempt cap: a file that exists keeps trying.

use super::{attempts_of, backoff_ms, failed};
use crate::api::errors::StorageError;
use crate::sync::hardening::history::uuid_v4;
use rusqlite::{Connection, OptionalExtension, params};

/// `DRAIN_BATCH_LIMIT`: rows one drain pass takes.
pub const DRAIN_BATCH_LIMIT: usize = 50;
/// `STUCK_UPLOAD_ATTEMPTS`: the failure count at which a row is reported stuck.
pub const STUCK_UPLOAD_ATTEMPTS: u32 = 5;
/// `RETRY_BASE_MS`.
pub const RETRY_BASE_MS: i64 = 60 * 1000;
/// `RETRY_MAX_MS`.
pub const RETRY_MAX_MS: i64 = 6 * 60 * 60 * 1000;

/// One queued upload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingUpload {
    pub owner_id: String,
    /// The absolute path of the file, as the enqueuer gave it.
    pub disk_path: String,
    /// Failed tries so far.
    pub attempts: u32,
    pub updated_at: i64,
}

impl PendingUpload {
    /// When the row may be tried again: 0 for a row that never failed, so it is
    /// due whatever its write time (`retryOpensAt`).
    pub fn retry_opens_at(&self) -> i64 {
        match self.attempts {
            0 => 0,
            n => self
                .updated_at
                .saturating_add(backoff_ms(n, RETRY_BASE_MS, RETRY_MAX_MS)),
        }
    }
}

/// Queues `disk_path` for upload (`enqueueUpload`). A row already there keeps
/// its attempts and moves its write time to `now_ms`.
pub fn enqueue(
    conn: &Connection,
    owner_id: &str,
    disk_path: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO attachment_upload_queue (id, note_id, disk_path, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT (note_id, disk_path) DO UPDATE SET updated_at = excluded.updated_at",
        params![uuid_v4(), owner_id, disk_path, now_ms],
    )
    .map(|_| ())
    .map_err(failed)
}

/// Queues `disk_path` unless it has a row (`queueUploadIfAbsent`): a failed row
/// keeps its attempts and its retry window. True when a row was added.
pub fn queue_if_absent(
    conn: &Connection,
    owner_id: &str,
    disk_path: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    conn.execute(
        "INSERT INTO attachment_upload_queue (id, note_id, disk_path, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT (note_id, disk_path) DO NOTHING",
        params![uuid_v4(), owner_id, disk_path, now_ms],
    )
    .map(|changed| changed > 0)
    .map_err(failed)
}

/// Whether `disk_path` of `owner_id` waits to upload (`hasPendingUpload`).
pub fn has_pending(
    conn: &Connection,
    owner_id: &str,
    disk_path: &str,
) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT 1 FROM attachment_upload_queue WHERE note_id = ?1 AND disk_path = ?2",
        params![owner_id, disk_path],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(failed)
}

/// Whether any file of `owner_id` waits to upload: bytes of it are still on
/// their way up, so none of its references may be pruned.
pub fn owner_has_pending(conn: &Connection, owner_id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT 1 FROM attachment_upload_queue WHERE note_id = ?1 LIMIT 1",
        params![owner_id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(failed)
}

/// Drops the row (`clearUpload`): the server accepted the file, or the file is
/// gone and can never upload.
pub fn clear(conn: &Connection, owner_id: &str, disk_path: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM attachment_upload_queue WHERE note_id = ?1 AND disk_path = ?2",
        params![owner_id, disk_path],
    )
    .map(|_| ())
    .map_err(failed)
}

/// Counts one failed try (`markUploadFailed`), adding the row if it went
/// missing meanwhile, and returns the attempts the row now holds. The runner
/// reports the row stuck when this equals [`STUCK_UPLOAD_ATTEMPTS`].
pub fn mark_failed(
    conn: &Connection,
    owner_id: &str,
    disk_path: &str,
    error: &str,
    now_ms: i64,
) -> Result<u32, StorageError> {
    conn.query_row(
        "INSERT INTO attachment_upload_queue
           (id, note_id, disk_path, attempts, last_error, created_at, updated_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?5, ?5)
         ON CONFLICT (note_id, disk_path) DO UPDATE SET
           attempts = attempts + 1,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at
         RETURNING attempts",
        params![uuid_v4(), owner_id, disk_path, error, now_ms],
        |row| row.get::<_, i64>(0),
    )
    .map(attempts_of)
    .map_err(failed)
}

/// The oldest rows, at most `limit` (`listPendingUploads`), whatever their
/// retry window.
pub fn list_pending(conn: &Connection, limit: usize) -> Result<Vec<PendingUpload>, StorageError> {
    let mut rows = Vec::new();
    if limit == 0 {
        return Ok(rows);
    }
    for_each_oldest_first(conn, |row| {
        rows.push(row);
        rows.len() < limit
    })?;
    Ok(rows)
}

/// The oldest rows whose retry window is open at `now_ms`, at most
/// [`DRAIN_BATCH_LIMIT`] (`listDueUploads`). A local-only note's rows stay on
/// the device and never count toward the batch, so they cannot hold back the
/// rows behind them; they upload once the flag is cleared.
pub fn list_due(conn: &Connection, now_ms: i64) -> Result<Vec<PendingUpload>, StorageError> {
    let mut local_only = conn
        .prepare("SELECT 1 FROM note_files WHERE note_id = ?1 AND local_only != 0")
        .map_err(failed)?;
    let mut due = Vec::new();
    let mut error = None;
    for_each_oldest_first(conn, |row| {
        if row.retry_opens_at() > now_ms {
            return true;
        }
        match local_only.exists(params![row.owner_id]) {
            Ok(true) => {}
            Ok(false) => due.push(row),
            Err(err) => {
                error = Some(failed(err));
                return false;
            }
        }
        due.len() < DRAIN_BATCH_LIMIT
    })?;
    error.map_or(Ok(due), Err)
}

/// Every row, as `(owner id, disk path)`: the sweep that drops rows whose file
/// was deleted (`dropUploadsWithoutFile`).
pub fn list_all(conn: &Connection) -> Result<Vec<(String, String)>, StorageError> {
    let mut statement = conn
        .prepare("SELECT note_id, disk_path FROM attachment_upload_queue ORDER BY updated_at, id")
        .map_err(failed)?;
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// Walks the rows oldest write first, until `visit` returns false. The rows
/// are read one at a time, so a long queue is never held in memory.
fn for_each_oldest_first(
    conn: &Connection,
    mut visit: impl FnMut(PendingUpload) -> bool,
) -> Result<(), StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT note_id, disk_path, attempts, updated_at FROM attachment_upload_queue
             ORDER BY updated_at, id",
        )
        .map_err(failed)?;
    let mut rows = statement.query([]).map_err(failed)?;
    while let Some(row) = rows.next().map_err(failed)? {
        let pending = PendingUpload {
            owner_id: row.get(0).map_err(failed)?,
            disk_path: row.get(1).map_err(failed)?,
            attempts: attempts_of(row.get(2).map_err(failed)?),
            updated_at: row.get(3).map_err(failed)?,
        };
        if !visit(pending) {
            break;
        }
    }
    Ok(())
}
