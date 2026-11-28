//! Why an attachment would not download, and when the re-drive asks for it
//! again (`attachment_download_failures`, data migration 0019).
//!
//! Desktop is the reference (`packages/sync-client/src/attachment-download-state.ts`,
//! #1588). Before this table the re-drive asked again on every sync pass and
//! path change, so an attachment the server answers 404 for failed on every
//! trigger, forever, and 25 of them filled the re-drive's batch so nothing
//! behind them was ever asked for.
//!
//! **Two kinds of failure, two schedules.** A 404 or 410 means the server
//! does not have this attachment, and ids are minted per upload, so it never
//! will; a manifest no vault device signed is refused the same way on every
//! fetch. Each is probed again a day later, and after [`MISSING_PROBE_LIMIT`]
//! answers the re-drive stops asking. Anything else answered about the
//! attachment, a corrupt chunk among them (chapter 14 §14.7 says a refusal of
//! the manifest's id is not the server saying the attachment is gone), backs
//! off from a minute to six hours and is never given up on.
//!
//! **A failure of this device is not the attachment's.** No connection or a
//! key store that will not answer fails every attachment the same way, so it
//! is counted and not recorded, and the next trigger asks again as before.
//!
//! Opening the note does not wait for any of this: the user asked for it now.
//! A download that lands, by either path, deletes the row.

use rusqlite::{Connection, OptionalExtension as _};

use crate::api::errors::{ApiError, StorageError, SyncError};

/// A 404 is probed again this long after the last one.
const MISSING_RETRY_MS: i64 = 24 * 60 * 60 * 1000;

/// Separate 404s, a day apart, after which the re-drive stops asking.
pub const MISSING_PROBE_LIMIT: i64 = 3;

const TRANSIENT_BASE_MS: i64 = 60 * 1000;
const TRANSIENT_MAX_MS: i64 = 6 * 60 * 60 * 1000;

/// Why one download failed, as a stable code a shell can log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum AttachmentFailureReason {
    /// The server answered 404 or 410 for the manifest or a chunk.
    NotFound,
    /// The manifest's signer could not be placed, or its signature failed.
    Unverified,
    /// The manifest or the bytes did not open or did not match.
    Corrupt,
    /// The server asked this device to slow down.
    RateLimited,
    /// A 5xx or a response that would not parse.
    Server,
    /// Any other refusal: a 4xx, an expired session, a revoked device.
    Refused,
    /// No connection: the request never got an answer.
    Network,
    /// The secure store would not hand over the key.
    KeyStore,
    /// The local database or disk failed.
    Storage,
    Other,
}

impl AttachmentFailureReason {
    /// Classifies the error one download ended with.
    pub fn of(error: &SyncError) -> Self {
        match error {
            SyncError::Api { source } => match source {
                ApiError::Status {
                    status: 404 | 410, ..
                } => Self::NotFound,
                ApiError::Status { status: 429, .. } | ApiError::RateLimited { .. } => {
                    Self::RateLimited
                }
                ApiError::Status { status, .. } if *status >= 500 => Self::Server,
                ApiError::MalformedResponse { .. } => Self::Server,
                ApiError::Transport { .. } => Self::Network,
                ApiError::Storage { .. } => Self::Storage,
                ApiError::NoMasterKey => Self::KeyStore,
                _ => Self::Refused,
            },
            SyncError::AttachmentUnverified { .. } => Self::Unverified,
            SyncError::AttachmentCorrupt { .. } | SyncError::Crypto { .. } => Self::Corrupt,
            SyncError::SecureStore { .. } | SyncError::Locked => Self::KeyStore,
            SyncError::Storage { .. } => Self::Storage,
            SyncError::Auth { .. } => Self::Refused,
            SyncError::UnknownNote { .. } => Self::Other,
        }
    }

    /// Whether this failure says something about the attachment rather than
    /// about this device, and so earns the attachment its own schedule.
    fn is_the_attachments(self) -> bool {
        !matches!(self, Self::Network | Self::KeyStore)
    }

    /// The server will not have it on the next ask either.
    fn is_permanent(self) -> bool {
        matches!(self, Self::NotFound | Self::Unverified)
    }

    fn code(self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::Unverified => "unverified",
            Self::Corrupt => "corrupt",
            Self::RateLimited => "rate_limited",
            Self::Server => "server",
            Self::Refused => "refused",
            Self::Network => "network",
            Self::KeyStore => "key_store",
            Self::Storage => "storage",
            Self::Other => "other",
        }
    }
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Records a failed re-drive of `attachment_id` at `now` and schedules the
/// next ask. A failure of this device records nothing.
///
/// Attempts count per kind, as desktop's do: a spell of 5xx does not spend
/// the 404 probes, and a 404 after them starts its own count.
pub fn record(
    conn: &Connection,
    attachment_id: &str,
    reason: AttachmentFailureReason,
    now: i64,
) -> Result<(), StorageError> {
    if !reason.is_the_attachments() {
        return Ok(());
    }
    let previous: Option<(String, i64)> = conn
        .query_row(
            "SELECT reason, attempts FROM attachment_download_failures WHERE attachment_id = ?1",
            [attachment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(failed)?;
    let permanent = reason.is_permanent();
    let attempts = match previous {
        Some((code, attempts)) if code_is_permanent(&code) == permanent => attempts + 1,
        _ => 1,
    };
    let next_attempt_at = if permanent {
        (attempts < MISSING_PROBE_LIMIT).then_some(now + MISSING_RETRY_MS)
    } else {
        let doublings = (attempts - 1).clamp(0, 20) as u32;
        Some(now + (TRANSIENT_BASE_MS << doublings).min(TRANSIENT_MAX_MS))
    };
    conn.execute(
        "INSERT INTO attachment_download_failures \
           (attachment_id, reason, attempts, next_attempt_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(attachment_id) DO UPDATE SET \
           reason = excluded.reason, attempts = excluded.attempts, \
           next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at",
        rusqlite::params![attachment_id, reason.code(), attempts, next_attempt_at, now],
    )
    .map_err(failed)?;
    Ok(())
}

fn code_is_permanent(code: &str) -> bool {
    matches!(code, "not_found" | "unverified")
}

/// The bytes landed: the attachment is asked for on the usual terms again.
pub fn clear(conn: &Connection, attachment_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM attachment_download_failures WHERE attachment_id = ?1",
        [attachment_id],
    )
    .map_err(failed)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Db;
    use crate::storage::migrations::{DATA_MIGRATIONS, run};

    const ID: &str = "0123456789abcdef0123456789abcdef";
    const DAY: i64 = MISSING_RETRY_MS;

    /// The next attempt the row holds, `None` when no row, `Some(None)` when
    /// none is left.
    fn next_attempt(db: &Db) -> Option<Option<i64>> {
        db.call_blocking(|conn| {
            conn.query_row(
                "SELECT next_attempt_at FROM attachment_download_failures WHERE attachment_id = ?1",
                [ID],
                |row| row.get(0),
            )
            .optional()
            .map_err(failed)
        })
        .expect("read")
    }

    fn record_at(db: &Db, reason: AttachmentFailureReason, now: i64) {
        db.call_blocking(move |conn| record(conn, ID, reason, now))
            .expect("record");
    }

    fn migrated() -> Db {
        let db = Db::open_in_memory().expect("open");
        db.call_blocking(|conn| run(conn, DATA_MIGRATIONS))
            .expect("migrate");
        db
    }

    #[test]
    fn a_404_is_probed_once_a_day_and_given_up_after_the_limit() {
        let db = migrated();
        record_at(&db, AttachmentFailureReason::NotFound, 0);
        assert_eq!(next_attempt(&db), Some(Some(DAY)));
        record_at(&db, AttachmentFailureReason::NotFound, DAY);
        assert_eq!(next_attempt(&db), Some(Some(2 * DAY)));
        record_at(&db, AttachmentFailureReason::NotFound, 2 * DAY);
        assert_eq!(next_attempt(&db), Some(None), "no automatic retry left");
    }

    #[test]
    fn a_transient_failure_backs_off_from_a_minute_to_six_hours() {
        let db = migrated();
        let mut waits = Vec::new();
        for _ in 0..12 {
            record_at(&db, AttachmentFailureReason::Server, 0);
            waits.push(next_attempt(&db).flatten().expect("a next attempt"));
        }
        assert_eq!(&waits[..4], &[60_000, 120_000, 240_000, 480_000]);
        assert_eq!(waits[11], TRANSIENT_MAX_MS, "capped, never given up");
    }

    #[test]
    fn a_blip_does_not_spend_the_404_probes() {
        let db = migrated();
        record_at(&db, AttachmentFailureReason::NotFound, 0);
        record_at(&db, AttachmentFailureReason::NotFound, DAY);
        record_at(&db, AttachmentFailureReason::RateLimited, 2 * DAY);
        record_at(&db, AttachmentFailureReason::NotFound, 3 * DAY);
        assert_eq!(next_attempt(&db), Some(Some(4 * DAY)), "a first 404 again");
    }

    #[test]
    fn a_failure_of_this_device_records_nothing_and_a_landing_clears() {
        let db = migrated();
        record_at(&db, AttachmentFailureReason::Network, 0);
        record_at(&db, AttachmentFailureReason::KeyStore, 0);
        assert_eq!(next_attempt(&db), None);
        record_at(&db, AttachmentFailureReason::Corrupt, 0);
        db.call_blocking(|conn| clear(conn, ID)).expect("clear");
        assert_eq!(next_attempt(&db), None);
    }
}
