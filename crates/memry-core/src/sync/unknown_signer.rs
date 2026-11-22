//! Records refused only because their signer was not in the pass's device
//! directory (chapter 01 §1.4.0, #5413).
//!
//! The directory is fetched once, at the start of a pass. A device that
//! registers and writes during the pass signs records this one cannot verify:
//! each is stored corrupt and the feed cursor moves past it, so the feed never
//! serves it again. A refused delete then leaves the row live here, and for a
//! clockless type (settings, a delete stored with no clock) the server accepts
//! a later edit of it and the item comes back on every device.
//!
//! - [`refused`] records the refusal as one `meta` row per `(type, id)`,
//!   which a local edit never touches (an edit clears `corrupt_reason`, so the
//!   reason cannot be the record of it).
//! - [`retry`] re-pulls those ids at the start of every pass, over that pass's
//!   fresh directory, at most [`MAX_RETRIES`] times per refusal.
//! - [`holds`] keeps a queued edit of such a row out of the push meanwhile.
//! - The wait ends when the row resolves: a verified record for it
//!   ([`resolve_verified`]) drops the `meta` row and the row's flag; the last
//!   retry keeps the `meta` row as given up, with the flag.
//!
//! A record whose signature fails for any other reason is never retried: its
//! reason does not end with
//! [`crate::protocol::account::UNKNOWN_SIGNER`].
//!
//! The rows are baseline `meta` rows, so no numbered migration is needed:
//! `sync.unknown_signer_wait:{type}:{id}` holding the passes that re-pulled
//! it. An older build never reads them. Every pass adopts a flag with no
//! `meta` row, which is a refusal an older build recorded only in
//! `corrupt_reason`, also one it recorded after a downgrade.

use rusqlite::{Connection, params};

use crate::api::errors::{ApiError, StorageError};
use crate::storage::Db;
use crate::storage::repositories::sync_items;

use super::apply::Pending;
use super::first_sync_store::{read_meta, write_meta};
use super::pull::{PullError, PullLoop};

/// Passes that re-pull one refusal. A signer still missing after this many
/// fresh directories is not a device of the account; the row stays as it is,
/// and its `meta` row stays at this count, given up.
pub(crate) const MAX_RETRIES: u32 = 5;

const KEY_PREFIX: &str = "sync.unknown_signer_wait:";
/// The first key past every [`KEY_PREFIX`] key (`;` follows `:`).
const KEY_END: &str = "sync.unknown_signer_wait;";
/// Id-only keys of unreleased builds (#5426), moved once by
/// [`migrate_id_only_keys`]. A local edit clears the row's flag, so such a key
/// can be the only record of a hold.
const OLD_KEYS: (&str, &str) = (
    "sync.unknown_signer_retries:",
    "sync.unknown_signer_retries;",
);
const OLD_SEEDED_KEY: &str = "sync.unknown_signer_seeded";
/// Set once the id-only keys are moved (sorts outside [`KEY_PREFIX`]).
const MIGRATED_KEY: &str = "sync.unknown_signer_wait_keyed";

/// Item types hold no `:`, so the first one ends the type.
fn key(item_type: &str, item_id: &str) -> String {
    format!("{KEY_PREFIX}{item_type}:{item_id}")
}

/// Records a fresh refusal of the item's record: a full retry budget.
pub(crate) fn refused(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<(), StorageError> {
    write_meta(conn, &key(item_type, item_id), "0")
}

/// Ends the wait on every item in `pending`: each arrived verified, applied
/// or skipped, so its signer is known and nothing is left to re-pull.
pub(crate) fn resolve_verified(conn: &Connection, pending: &[Pending]) -> Result<(), StorageError> {
    if pending.is_empty() || recorded(conn)?.is_empty() {
        return Ok(());
    }
    for item in pending {
        drop_refusal(conn, item.item_type(), item.item_id())?;
        sync_items::clear_unknown_signer(conn, item.item_type(), item.item_id())?;
    }
    Ok(())
}

/// Whether a queued edit of this row waits: its last pulled record was
/// refused for an unknown signer and is still being re-pulled. Sending the
/// edit could reverse a delete this device has not verified yet.
pub(crate) fn holds(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<bool, StorageError> {
    Ok(read_meta(conn, &key(item_type, item_id))?
        .is_some_and(|attempts| attempts_of(&attempts) < MAX_RETRIES))
}

/// Re-pulls, by id, every refusal still waiting. The caller built `pull` over
/// the directory it fetched for this pass. A transport failure is logged and
/// counts no attempt; any other failure counts one.
pub(crate) async fn retry(db: &Db, pull: &PullLoop) -> Result<(), StorageError> {
    let due: Vec<_> = db
        .call(|conn| {
            migrate_id_only_keys(conn)?;
            adopt(conn)?;
            recorded(conn)
        })
        .await?
        .into_iter()
        .filter(|(_, _, attempts)| *attempts < MAX_RETRIES)
        .collect();
    if due.is_empty() {
        return Ok(());
    }
    let mut ids: Vec<String> = due.iter().map(|(_, id, _)| id.clone()).collect();
    ids.sort();
    ids.dedup();
    if let Err(error) = pull.fetch_ids(&ids).await {
        eprintln!(
            "memry-core: re-pulling {} record(s) of an unknown signer failed: {error}",
            ids.len()
        );
        if matches!(
            error,
            PullError::Api {
                source: ApiError::Transport { .. }
            }
        ) {
            return Ok(());
        }
    }
    db.call(move |conn| {
        for (item_type, id, attempts) in due {
            let key = key(&item_type, &id);
            // Resolved by the re-pull, or a refusal of it is still recorded:
            // this pass's attempt counts against the budget it had before.
            if read_meta(conn, &key)?.is_none() {
                continue;
            }
            let attempts = attempts + 1;
            if attempts >= MAX_RETRIES {
                eprintln!(
                    "memry-core: {item_type} {id}'s signer is still unknown after {attempts} \
                     directories; no longer re-pulled"
                );
            }
            write_meta(conn, &key, &attempts.to_string())?;
        }
        Ok(())
    })
    .await
}

fn attempts_of(value: &str) -> u32 {
    value.parse().unwrap_or(0)
}

/// Every recorded refusal, waiting or given up, as `(type, id, attempts)`.
fn recorded(conn: &Connection) -> Result<Vec<(String, String, u32)>, StorageError> {
    let mut statement = conn
        .prepare("SELECT key, value FROM meta WHERE key >= ?1 AND key < ?2 ORDER BY key")
        .map_err(failed)?;
    let rows = statement
        .query_map(params![KEY_PREFIX, KEY_END], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    Ok(rows
        .into_iter()
        .filter_map(|(key, value)| {
            let (item_type, id) = key[KEY_PREFIX.len()..].split_once(':')?;
            Some((item_type.to_owned(), id.to_owned(), attempts_of(&value)))
        })
        .collect())
}

fn drop_refusal(conn: &Connection, item_type: &str, item_id: &str) -> Result<(), StorageError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [key(item_type, item_id)])
        .map_err(failed)?;
    Ok(())
}

/// Moves each id-only key to every row with that id, at the same count:
/// holding a sibling of another type a few passes is harmless, dropping a
/// hold can push an edit over an unverified delete (REVIEW-5448). Runs once.
fn migrate_id_only_keys(conn: &Connection) -> Result<(), StorageError> {
    if read_meta(conn, MIGRATED_KEY)?.is_some() {
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value)
         SELECT ?1 || s.item_type || ':' || s.item_id, m.value
         FROM meta m JOIN sync_items s ON s.item_id = substr(m.key, length(?2) + 1)
         WHERE m.key >= ?2 AND m.key < ?3",
        params![KEY_PREFIX, OLD_KEYS.0, OLD_KEYS.1],
    )
    .map_err(failed)?;
    conn.execute(
        "DELETE FROM meta WHERE (key >= ?1 AND key < ?2) OR key = ?3",
        params![OLD_KEYS.0, OLD_KEYS.1, OLD_SEEDED_KEY],
    )
    .map_err(failed)?;
    write_meta(conn, MIGRATED_KEY, "1")
}

/// Adopts every flagged row with no `meta` row: a refusal an older build
/// recorded only in `corrupt_reason`, before or after this build first ran.
/// A row this build resolved has no flag, and one it gave up on keeps its
/// `meta` row, so neither comes back.
fn adopt(conn: &Connection) -> Result<(), StorageError> {
    for (item_type, id) in sync_items::unknown_signer_rows(conn)? {
        conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES (?1, '0')",
            [key(&item_type, &id)],
        )
        .map_err(failed)?;
    }
    Ok(())
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
