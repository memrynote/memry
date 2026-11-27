//! `attachment_upload_queue`: the durable outbox of attachment uploads
//! (`attachment-outbox.ts`). A row is written before an upload starts and
//! deleted only once the server accepted the file, so an upload that fails or
//! is cut short by quit is retried after a restart instead of lost.
//!
//! Retry rule (`retryOpensAt`, `attachment-outbox.ts:19-24,133-136`): a row
//! that failed `n` times waits `min(1 min * 2^(n-1), 6 h)` after its last
//! write. A row crossing [`STUCK_UPLOAD_ATTEMPTS`] is flagged once by the
//! runner. Rows have no attempt cap: a file that exists keeps trying.
//!
//! Refusals (#5711, Electron #5619 `refuseUpload`, `attachment-outbox.ts:115-152`):
//! a file the uploader refuses for good (empty, over the size limit) is dropped
//! and, while the file on disk still fails the uploader's checks, its size and
//! mtime are remembered under the `meta` key [`REFUSALS_KEY`].
//! [`queue_if_absent`] adds no row for an empty file or for a file whose stamp
//! still matches, so the re-drive no longer queues and drops it every pass.

use std::collections::BTreeMap;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use super::{attempts_of, backoff_ms, failed};
use crate::api::errors::StorageError;
use crate::sync::attachments::queue::{VaultFiles, relative};
use crate::sync::attachments::upload::MAX_ATTACHMENT_SIZE;
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
    /// The vault-relative, `/`-separated path of the file (`attachments/<note>/<file>`), the path
    /// [`files`](super::files) records it under once the server has it.
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
/// its attempts and moves its write time to `now_ms`. It skips the refusal
/// check: production code queues through [`queue_if_absent`], and this seeds
/// rows in tests (the desktop attachments harness among them).
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

/// Queues `disk_path` unless it has a row (a failed row keeps its attempts
/// and its retry window) or the uploader would refuse it as it is
/// (`queueUploadIfAbsent`, `attachment-outbox.ts:150-151`). True when a row
/// was added.
pub fn queue_if_absent(
    conn: &Connection,
    vault: &dyn VaultFiles,
    refusals: &Refusals,
    owner_id: &str,
    disk_path: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    if refusals.refuse_as_it_is(vault, disk_path) {
        return Ok(false);
    }
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

/// The `meta` key of the refusals: a JSON object from a queue row's path to
/// the file's [`FileStamp`] when the uploader refused it. A missing key reads as
/// no refusals. Electron keeps the same object in `sync_state`
/// (`attachmentUploadRefusals`); it is not imported, which costs one more
/// offer and drop per refused file.
pub const REFUSALS_KEY: &str = "attachment_upload.refusals";

/// A file's size and mtime, as the uploader saw it when it refused the file.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct FileStamp {
    size: u64,
    #[serde(rename = "mtimeMs")]
    mtime_ms: f64,
}

impl FileStamp {
    /// Whether the uploader's own checks refuse a file of this size
    /// (`upload_file`: empty, or over [`MAX_ATTACHMENT_SIZE`]).
    fn fails_the_uploader(&self) -> bool {
        self.size == 0 || self.size > MAX_ATTACHMENT_SIZE
    }
}

/// The stamp of the file a queue row names, read through the vault. `None`
/// for a file that cannot be read: a missing file is the drain's to judge,
/// not the refusal check's.
fn stamp_of(vault: &dyn VaultFiles, disk_path: &str) -> Option<FileStamp> {
    let meta = vault
        .open(&relative(vault, disk_path)?)
        .ok()?
        .metadata()
        .ok()?;
    let mtime_ms = match meta.modified().ok()?.duration_since(UNIX_EPOCH) {
        Ok(after) => after.as_secs_f64() * 1000.0,
        Err(before) => -before.duration().as_secs_f64() * 1000.0,
    };
    Some(FileStamp {
        size: meta.len(),
        mtime_ms,
    })
}

/// The recorded refusals, read once per pass with [`refusals`].
#[derive(Debug, Default)]
pub struct Refusals(BTreeMap<String, FileStamp>);

impl Refusals {
    /// Whether the uploader would refuse this file as it is on disk now
    /// (`refusedAsItIs`, `attachment-outbox.ts:137-141`): it is empty, or it
    /// was refused before and no write has changed it since.
    fn refuse_as_it_is(&self, vault: &dyn VaultFiles, disk_path: &str) -> bool {
        stamp_of(vault, disk_path)
            .is_some_and(|stamp| stamp.size == 0 || self.0.get(disk_path) == Some(&stamp))
    }
}

/// The recorded refusals. A corrupt value reads as none, with a warning:
/// forgetting them costs one more offer of each refused file.
pub fn refusals(conn: &Connection) -> Result<Refusals, StorageError> {
    read_refusals(conn).map(Refusals)
}

fn read_refusals(conn: &Connection) -> Result<BTreeMap<String, FileStamp>, StorageError> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![REFUSALS_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    match serde_json::from_str::<BTreeMap<String, serde_json::Value>>(&value) {
        Ok(entries) => Ok(entries
            .into_iter()
            .filter_map(|(path, stamp)| Some((path, serde_json::from_value(stamp).ok()?)))
            .collect()),
        Err(error) => {
            eprintln!(
                "memry-core: attachment upload refusals are corrupt, starting them again: {error}"
            );
            Ok(BTreeMap::new())
        }
    }
}

fn write_refusals(
    conn: &Connection,
    refusals: &BTreeMap<String, FileStamp>,
) -> Result<(), StorageError> {
    if refusals.is_empty() {
        conn.execute("DELETE FROM meta WHERE key = ?1", params![REFUSALS_KEY])
            .map_err(failed)?;
        return Ok(());
    }
    let value = serde_json::to_string(refusals).map_err(|error| StorageError::Failed {
        what: error.to_string(),
    })?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![REFUSALS_KEY, value],
    )
    .map(drop)
    .map_err(failed)
}

/// The uploader refused this file for good (`refuseUpload`,
/// `attachment-outbox.ts:115-129`): drops its row and remembers the file's
/// size and mtime, so it is not queued again until a write changes them.
/// Refusals whose file changed or is gone hold nothing back and are let go.
///
/// The stamp is recorded only while the file on disk still fails the
/// uploader's checks. A save that rewrote it after the uploader looked leaves
/// nothing recorded, so the next backfill offers the new bytes; recording
/// that stamp would hold a good file back until it changes again.
pub fn refuse(
    conn: &Connection,
    vault: &dyn VaultFiles,
    owner_id: &str,
    disk_path: &str,
) -> Result<(), StorageError> {
    clear(conn, owner_id, disk_path)?;
    let mut refusals = read_refusals(conn)?;
    refusals.retain(|file, stamp| stamp_of(vault, file) == Some(*stamp));
    if let Some(stamp) = stamp_of(vault, disk_path).filter(FileStamp::fails_the_uploader) {
        refusals.insert(disk_path.to_owned(), stamp);
    }
    write_refusals(conn, &refusals)
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
