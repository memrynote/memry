//! `attachment_download_failures`: the attachment downloads that did not
//! succeed (`attachment-download-state.ts`, #1588). A row is written from the
//! download's outcome and deleted when the download succeeds or this device
//! uploads the attachment itself, so the table holds only live failures. The
//! session state (requests in flight, successes this run) is the runner's.
//!
//! Retry rule, `next_attempt_at` (`markDownloadFailed`):
//!
//! - **missing** (the server answered 404 or 410, or the manifest signature
//!   does not verify): probed again after 24 h, at most
//!   [`MISSING_PROBE_LIMIT`] times, then `NULL`: no automatic retry. Ids are
//!   minted per upload, so re-adding the file gets a new id with no row.
//! - **transient** (anything else): `min(1 min * 2^(n-1), 6 h)`, no cap.
//!
//! Attempts count per reason: a spell of 5xx does not spend the 404 budget.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, params};

use super::{attempts_of, backoff_ms, failed, upload_queue};
use crate::api::errors::StorageError;

/// `MISSING_RETRY_MS`: a 404 is probed again at most this often.
pub const MISSING_RETRY_MS: i64 = 24 * 60 * 60 * 1000;
/// `MISSING_PROBE_LIMIT`: separate 404s before the reference reads as gone.
pub const MISSING_PROBE_LIMIT: u32 = 3;
/// `TRANSIENT_BASE_MS`.
pub const TRANSIENT_BASE_MS: i64 = 60 * 1000;
/// `TRANSIENT_MAX_MS`.
pub const TRANSIENT_MAX_MS: i64 = 6 * 60 * 60 * 1000;

/// Why a download failed, the `reason` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureReason {
    /// The server does not have the attachment and never will.
    Missing,
    /// A blip on the way to a blob that may well exist.
    Transient,
}

impl FailureReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Transient => "transient",
        }
    }

    /// A value no build writes reads as transient: it keeps retrying and never
    /// counts as proof that the attachment is gone.
    fn parse(raw: &str) -> Self {
        if raw == Self::Missing.as_str() {
            Self::Missing
        } else {
            Self::Transient
        }
    }
}

/// A row's retry state after a failure was recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordedFailure {
    pub reason: FailureReason,
    pub attempts: u32,
    /// `None`: no automatic retry left.
    pub next_attempt_at: Option<i64>,
}

/// One failure the re-driver may try again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedrivableFailure {
    pub owner_id: String,
    pub attachment_id: String,
    pub reason: FailureReason,
    pub attempts: u32,
}

/// `${ownerId}::${attachmentId}`, the row id, so an upsert needs no lookup.
pub fn key(owner_id: &str, attachment_id: &str) -> String {
    format!("{owner_id}::{attachment_id}")
}

/// Whether the recorded failures allow a download of `attachment_id` for
/// `owner_id` at `now_ms` (the persistent half of `shouldAttemptDownload`). No
/// row: yes. A read error is an `Err`; the caller fails open, as Electron does,
/// so an unreadable table never stops downloads.
pub fn may_attempt(
    conn: &Connection,
    owner_id: &str,
    attachment_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let next = conn
        .query_row(
            "SELECT next_attempt_at FROM attachment_download_failures WHERE id = ?1",
            params![key(owner_id, attachment_id)],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(match next {
        None => true,
        Some(None) => false,
        Some(Some(at)) => now_ms >= at,
    })
}

/// Records one failed download and returns the row's new retry state.
pub fn record_failure(
    conn: &Connection,
    owner_id: &str,
    attachment_id: &str,
    reason: FailureReason,
    error: &str,
    now_ms: i64,
) -> Result<RecordedFailure, StorageError> {
    let id = key(owner_id, attachment_id);
    let previous = conn
        .query_row(
            "SELECT reason, attempts FROM attachment_download_failures WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(failed)?;
    // The stored text, not its parse: a reason no build writes restarts the
    // count, as `previous?.reason === reason` does.
    let attempts = match previous {
        Some((raw, attempts)) if raw == reason.as_str() => attempts_of(attempts).saturating_add(1),
        _ => 1,
    };
    let next_attempt_at = match reason {
        FailureReason::Missing if attempts >= MISSING_PROBE_LIMIT => None,
        FailureReason::Missing => Some(now_ms.saturating_add(MISSING_RETRY_MS)),
        FailureReason::Transient => {
            Some(now_ms.saturating_add(backoff_ms(attempts, TRANSIENT_BASE_MS, TRANSIENT_MAX_MS)))
        }
    };
    conn.execute(
        "INSERT INTO attachment_download_failures
           (id, owner_id, attachment_id, reason, attempts, last_error, next_attempt_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (id) DO UPDATE SET
           reason = excluded.reason,
           attempts = excluded.attempts,
           last_error = excluded.last_error,
           next_attempt_at = excluded.next_attempt_at,
           updated_at = excluded.updated_at",
        params![
            id,
            owner_id,
            attachment_id,
            reason.as_str(),
            i64::from(attempts),
            error,
            next_attempt_at,
            now_ms
        ],
    )
    .map_err(failed)?;
    Ok(RecordedFailure {
        reason,
        attempts,
        next_attempt_at,
    })
}

/// Forgets every failure of `attachment_id` for `owner_id`: the download
/// succeeded (`markDownloadSucceeded`), or this device uploaded it
/// (`clearAttachmentDownloadFailure`), which is the way back for a reference
/// it had given up on.
pub fn clear(conn: &Connection, owner_id: &str, attachment_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM attachment_download_failures WHERE id = ?1",
        params![key(owner_id, attachment_id)],
    )
    .map(|_| ())
    .map_err(failed)
}

/// Failures whose retry window has opened at `now_ms`, oldest write first, at
/// most `limit` (`listRedrivableDownloadFailures`). A `NULL` window never
/// opens.
pub fn list_redrivable(
    conn: &Connection,
    now_ms: i64,
    limit: usize,
) -> Result<Vec<RedrivableFailure>, StorageError> {
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let mut statement = conn
        .prepare(
            "SELECT owner_id, attachment_id, reason, attempts FROM attachment_download_failures
             WHERE next_attempt_at IS NOT NULL AND next_attempt_at <= ?1
             ORDER BY updated_at, id
             LIMIT ?2",
        )
        .map_err(failed)?;
    statement
        .query_map(params![now_ms, limit], |row| {
            Ok(RedrivableFailure {
                owner_id: row.get(0)?,
                attachment_id: row.get(1)?,
                reason: FailureReason::parse(&row.get::<_, String>(2)?),
                attempts: attempts_of(row.get(3)?),
            })
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// The ids among `references` of `owner_id` that are proven gone, the
/// positive evidence `pruneUnresolvableReferences` drops a reference on: the
/// server answered 404 on [`MISSING_PROBE_LIMIT`] separate days (reason
/// missing, no retry left), and the owner owes the server no upload. An id
/// never probed has no row and is never returned.
pub fn proven_gone(
    conn: &Connection,
    owner_id: &str,
    references: &[String],
) -> Result<BTreeSet<String>, StorageError> {
    if references.is_empty() || upload_queue::owner_has_pending(conn, owner_id)? {
        return Ok(BTreeSet::new());
    }
    // The owner's given-up rows, matched here rather than bound one parameter
    // per reference: a peer's note can carry more references than SQLite binds.
    let mut statement = conn
        .prepare(
            "SELECT attachment_id FROM attachment_download_failures
             WHERE owner_id = ?1 AND reason = ?2 AND next_attempt_at IS NULL",
        )
        .map_err(failed)?;
    let given_up = statement
        .query_map(params![owner_id, FailureReason::Missing.as_str()], |row| {
            row.get::<_, String>(0)
        })
        .map_err(failed)?
        .collect::<Result<BTreeSet<_>, _>>()
        .map_err(failed)?;
    Ok(references
        .iter()
        .filter(|id| given_up.contains(*id))
        .cloned()
        .collect())
}
