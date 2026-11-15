//! The quarantine ledger (Step 17 L3a, #3534): Electron's `QuarantineManager`
//! (`apps/desktop/src/main/sync/engine/quarantine-manager.ts:30-140`), kept
//! in `sync_quarantine` (migration 0031).
//!
//! A pulled record whose signature does not verify is one failure of its
//! `(type, id)`. At [`MAX_ATTEMPTS`] the entry is permanent: the pull skips the
//! item undecoded and the corrupt refetch ([`super::corrupt`]) leaves it out,
//! until [`ENTRY_TTL_MS`] after its last failure, when the entry expires and a
//! still-broken item earns it again in three pulls. Above [`MAX_ENTRIES`] the
//! oldest partial entries are evicted; a permanent one never is, since it is
//! what keeps a forged record out of the vault, so the cap is soft.
//!
//! Each failure is a [`SecurityWarning`] the driver tells its observers. Only
//! a pull built [`crate::sync::pull::PullLoop::with_hardening`] writes here,
//! which `SyncDriver` is and iOS's `sync_now` is not (decision K2).

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

/// `QUARANTINE_MAX_ATTEMPTS` (`sync-context.ts:274`).
pub const MAX_ATTEMPTS: i64 = 3;

/// `QUARANTINE_ENTRY_TTL_MS` (`sync-context.ts:275`): 7 days.
pub const ENTRY_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// `MAX_QUARANTINE_ENTRIES` (`sync-context.ts:288`), soft.
pub const MAX_ENTRIES: i64 = 10_000;

/// One signature failure, as desktop's `SecurityWarningEvent`
/// (`reason: 'signature_verification_failed'`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecurityWarning {
    pub item_type: String,
    pub item_id: String,
    pub signer_device_id: String,
    pub attempt_count: i64,
    pub permanent: bool,
}

/// One live ledger entry, as desktop's `QuarantinedItemInfo`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuarantinedItem {
    pub item_type: String,
    pub item_id: String,
    pub signer_device_id: String,
    pub failed_at: i64,
    pub attempt_count: i64,
    pub last_error: String,
    pub permanent: bool,
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Counts one signature failure of `(item_type, item_id)` at `now_ms`. An
/// expired entry is dropped first, so its count starts again at one.
/// `eviction_logged` is the caller's flag for the cap's one log line
/// ([`evict_overflow`]).
pub(crate) fn record_failure(
    conn: &Connection,
    failure: Failure<'_>,
    now_ms: i64,
    eviction_logged: &AtomicBool,
) -> Result<SecurityWarning, StorageError> {
    let Failure {
        item_type,
        item_id,
        signer_device_id,
        error,
    } = failure;
    conn.execute(
        "DELETE FROM sync_quarantine WHERE failed_at <= ?1",
        params![now_ms - ENTRY_TTL_MS],
    )
    .map_err(failed)?;
    let attempt_count: i64 = conn
        .query_row(
            "INSERT INTO sync_quarantine
               (item_type, item_id, signer_device_id, failed_at, attempt_count, last_error)
             VALUES (?1, ?2, ?3, ?4, 1, ?5)
             ON CONFLICT (item_type, item_id) DO UPDATE SET
               signer_device_id = excluded.signer_device_id,
               failed_at = excluded.failed_at,
               attempt_count = sync_quarantine.attempt_count + 1,
               last_error = excluded.last_error
             RETURNING attempt_count",
            params![item_type, item_id, signer_device_id, now_ms, error],
            |row| row.get(0),
        )
        .map_err(failed)?;
    evict_overflow(conn, eviction_logged)?;
    let permanent = attempt_count >= MAX_ATTEMPTS;
    eprintln!(
        "memry-core: SECURITY_AUDIT: signature verification failed for {item_type} {item_id} \
         signed by {signer_device_id} (attempt {attempt_count}, permanent {permanent})"
    );
    Ok(SecurityWarning {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        signer_device_id: signer_device_id.to_owned(),
        attempt_count,
        permanent,
    })
}

/// One signature failure: the record's key, its signer and the error.
pub(crate) struct Failure<'a> {
    pub item_type: &'a str,
    pub item_id: &'a str,
    pub signer_device_id: &'a str,
    pub error: &'a str,
}

/// Drops the oldest partial entries above [`MAX_ENTRIES`]. Permanent entries
/// stay even when only they are left over the cap. `true` when this call
/// printed the cap's log line, which happens once per `logged` flag.
fn evict_overflow(conn: &Connection, logged: &AtomicBool) -> Result<bool, StorageError> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sync_quarantine", [], |row| row.get(0))
        .map_err(failed)?;
    if count <= MAX_ENTRIES {
        return Ok(false);
    }
    let evicted = conn
        .execute(
            "DELETE FROM sync_quarantine WHERE rowid IN (
               SELECT rowid FROM sync_quarantine WHERE attempt_count < ?1
               ORDER BY failed_at, item_type, item_id LIMIT ?2)",
            params![MAX_ATTEMPTS, count - MAX_ENTRIES],
        )
        .map_err(failed)?;
    // Once per pull loop, as desktop's `evictionLogged` is once per
    // `QuarantineManager` (`quarantine-manager.ts:190-191`): one supervisor
    // per open vault, so a process-wide flag left every later vault silent.
    if logged.swap(true, Ordering::Relaxed) {
        return Ok(false);
    }
    eprintln!(
        "memry-core: the sync quarantine is at its cap of {MAX_ENTRIES}: evicted {evicted} \
         partial entr(ies), {} permanent over the cap",
        count - MAX_ENTRIES - evicted as i64
    );
    Ok(true)
}

/// The `(type, id)` of every permanent entry live at `now_ms`: the items the
/// pull skips undecoded.
pub(crate) fn blocked(
    conn: &Connection,
    now_ms: i64,
) -> Result<BTreeSet<(String, String)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT item_type, item_id FROM sync_quarantine
             WHERE attempt_count >= ?1 AND failed_at > ?2",
        )
        .map_err(failed)?;
    let keys = statement
        .query_map(params![MAX_ATTEMPTS, now_ms - ENTRY_TTL_MS], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    Ok(keys)
}

/// Every entry live at `now_ms`, oldest failure first: the list
/// `sync_get_quarantined_items` returns.
pub fn entries(conn: &Connection, now_ms: i64) -> Result<Vec<QuarantinedItem>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT item_type, item_id, signer_device_id, failed_at, attempt_count, last_error
             FROM sync_quarantine WHERE failed_at > ?1
             ORDER BY failed_at, item_type, item_id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![now_ms - ENTRY_TTL_MS], |row| {
            let attempt_count: i64 = row.get(4)?;
            Ok(QuarantinedItem {
                item_type: row.get(0)?,
                item_id: row.get(1)?,
                signer_device_id: row.get(2)?,
                failed_at: row.get(3)?,
                attempt_count,
                last_error: row.get(5)?,
                permanent: attempt_count >= MAX_ATTEMPTS,
            })
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    Ok(rows)
}

#[cfg(test)]
#[path = "quarantine_tests.rs"]
mod tests;
