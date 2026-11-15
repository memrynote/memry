//! The corrupt-row refetch (Step 17 L3a, #3534): Electron's
//! `CorruptItemTracker` (`apps/desktop/src/main/sync/engine/
//! corrupt-item-tracker.ts`), over the `sync_items.corrupt_reason` and
//! `corrupt_at` the pull already writes (§5.14, chapter 13 §13.2 rule 5).
//!
//! The record cursor moves past a corrupt item, so without a refetch a row
//! that failed once (a key the directory did not hold yet, a server blob since
//! repaired) stays corrupt for good. At the start of a run the pull asks for
//! every row marked corrupt more than [`RETRY_COOLDOWN_MS`] ago, through the
//! refused-items refetch ([`crate::sync::pull::PullLoop::pull_first_page`]):
//! one mechanism for both ledgers. Taking a row stamps `corrupt_at`, so one
//! that fails again, or that the server no longer returns, waits another hour.
//! A permanently quarantined item ([`super::quarantine`]) is left out.
//!
//! Only a pull built [`crate::sync::pull::PullLoop::with_hardening`] runs it
//! (decision K2: iOS's `sync_now` is unchanged).

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

use super::quarantine::{ENTRY_TTL_MS, MAX_ATTEMPTS};

/// `CORRUPT_ITEM_COOLDOWN_MS` (`sync-context.ts:261`): 1 hour.
pub const RETRY_COOLDOWN_MS: i64 = 3_600_000;

/// `MAX_CORRUPT_ITEMS` (`sync-context.ts:273`): the most rows one run
/// refetches, oldest first; the rest wait for the next run.
pub const MAX_PER_RUN: i64 = 5_000;

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// The `(type, id)` of every row marked corrupt at or before `now_ms -`
/// [`RETRY_COOLDOWN_MS`] and not permanently quarantined, oldest first, at
/// most [`MAX_PER_RUN`], each stamped as tried at `now_ms`.
pub(crate) fn take_retryable(
    conn: &Connection,
    now_ms: i64,
) -> Result<Vec<(String, String)>, StorageError> {
    let mut statement = conn
        .prepare(
            "UPDATE sync_items SET corrupt_at = ?2
             WHERE (item_type, item_id) IN (
               SELECT item.item_type, item.item_id FROM sync_items AS item
               WHERE item.corrupt_at IS NOT NULL AND item.corrupt_at <= ?1
                 AND NOT EXISTS (
                   SELECT 1 FROM sync_quarantine AS q
                   WHERE q.item_type = item.item_type AND q.item_id = item.item_id
                     AND q.attempt_count >= ?3 AND q.failed_at > ?4)
               ORDER BY item.corrupt_at, item.item_type, item.item_id
               LIMIT ?5)
             RETURNING item_type, item_id",
        )
        .map_err(failed)?;
    let mut pairs = statement
        .query_map(
            params![
                now_ms - RETRY_COOLDOWN_MS,
                now_ms,
                MAX_ATTEMPTS,
                now_ms - ENTRY_TTL_MS,
                MAX_PER_RUN
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(failed)?
        .collect::<Result<Vec<(String, String)>, _>>()
        .map_err(failed)?;
    pairs.sort();
    Ok(pairs)
}
