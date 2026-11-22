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
//! - [`refused`] records the refusal as one `meta` row per item id, which a
//!   local edit never touches (an edit clears `corrupt_reason`, so the reason
//!   cannot be the record of it).
//! - [`retry`] re-pulls those ids at the start of every pass, over that pass's
//!   fresh directory, at most [`MAX_RETRIES`] times per refusal.
//! - [`holds`] keeps a queued edit of such a row out of the push meanwhile.
//! - The row goes when the id resolves: any verified record for it
//!   ([`resolve_verified`]), or the last retry.
//!
//! The settings item reuses the hold (#5433): an edit over a deleted
//! payload-less settings row ([`crate::domain::settings::apply`]) records a
//! refusal of `synced_settings`, so the server copy is re-pulled and merged
//! before the edit pushes.
//!
//! A record whose signature fails for any other reason is never retried: its
//! reason does not end with
//! [`crate::protocol::account::UNKNOWN_SIGNER`].
//!
//! The rows are baseline `meta` rows, so no numbered migration is needed:
//! `sync.unknown_signer_retries:{id}` holding the passes that re-pulled it.
//! An older build never reads them. Refusals an older build recorded only in
//! `corrupt_reason` are adopted once ([`SEEDED_KEY`]).

use rusqlite::{Connection, params};

use crate::api::errors::{ApiError, StorageError};
use crate::storage::Db;
use crate::storage::repositories::sync_items;

use super::apply::Pending;
use super::first_sync_store::{read_meta, write_meta};
use super::pull::{PullError, PullLoop};

/// Passes that re-pull one refusal. A signer still missing after this many
/// fresh directories is not a device of the account; the row stays as it is.
pub(crate) const MAX_RETRIES: u32 = 5;

const KEY_PREFIX: &str = "sync.unknown_signer_retries:";
/// The first key past every [`KEY_PREFIX`] key (`;` follows `:`).
const KEY_END: &str = "sync.unknown_signer_retries;";
/// Set once the refusals older builds left in `corrupt_reason` are adopted.
const SEEDED_KEY: &str = "sync.unknown_signer_seeded";

fn key(item_id: &str) -> String {
    format!("{KEY_PREFIX}{item_id}")
}

/// Records a fresh refusal of `item_id`'s record: a full retry budget.
pub(crate) fn refused(conn: &Connection, item_id: &str) -> Result<(), StorageError> {
    write_meta(conn, &key(item_id), "0")
}

/// Ends the wait on every id in `pending`: each arrived verified, applied or
/// skipped, so its signer is known and nothing is left to re-pull. A skipped
/// record (a settings delete, an older record) leaves the row's unknown-signer
/// flag behind, so it is cleared here too.
pub(crate) fn resolve_verified(conn: &Connection, pending: &[Pending]) -> Result<(), StorageError> {
    if pending.is_empty() || waiting(conn)?.is_empty() {
        return Ok(());
    }
    for item in pending {
        drop_refusal(conn, item.item_id())?;
        sync_items::clear_unknown_signer(conn, item.item_type(), item.item_id())?;
    }
    Ok(())
}

/// Whether a queued edit of this row waits: its last pulled record was
/// refused for an unknown signer and is still being re-pulled. Sending the
/// edit could reverse a delete this device has not verified yet.
pub(crate) fn holds(conn: &Connection, item_id: &str) -> Result<bool, StorageError> {
    Ok(read_meta(conn, &key(item_id))?.is_some())
}

/// Re-pulls, by id, every refusal still waiting. The caller built `pull` over
/// the directory it fetched for this pass. A transport failure is logged and
/// counts no attempt; any other failure counts one.
pub(crate) async fn retry(db: &Db, pull: &PullLoop) -> Result<(), StorageError> {
    let due = db
        .call(|conn| {
            seed_legacy(conn)?;
            waiting(conn)
        })
        .await?;
    if due.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = due.iter().map(|(id, _)| id.clone()).collect();
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
        for (id, attempts) in due {
            // Resolved by the re-pull, or a refusal of it is still recorded:
            // this pass's attempt counts against the budget it had before.
            if read_meta(conn, &key(&id))?.is_none() {
                continue;
            }
            let attempts = attempts + 1;
            if attempts < MAX_RETRIES {
                write_meta(conn, &key(&id), &attempts.to_string())?;
                continue;
            }
            eprintln!(
                "memry-core: {id}'s signer is still unknown after {attempts} directories; \
                 no longer re-pulled"
            );
            drop_refusal(conn, &id)?;
        }
        Ok(())
    })
    .await
}

/// The waiting ids with the passes that re-pulled each.
fn waiting(conn: &Connection) -> Result<Vec<(String, u32)>, StorageError> {
    let mut statement = conn
        .prepare("SELECT key, value FROM meta WHERE key >= ?1 AND key < ?2 ORDER BY key")
        .map_err(failed)?;
    statement
        .query_map(params![KEY_PREFIX, KEY_END], |row| {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            Ok((
                key[KEY_PREFIX.len()..].to_owned(),
                value.parse().unwrap_or(0),
            ))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)
}

fn drop_refusal(conn: &Connection, item_id: &str) -> Result<(), StorageError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [key(item_id)])
        .map_err(failed)?;
    Ok(())
}

/// Adopts, once, the refusals an older build recorded only in
/// `corrupt_reason`.
fn seed_legacy(conn: &Connection) -> Result<(), StorageError> {
    if read_meta(conn, SEEDED_KEY)?.is_some() {
        return Ok(());
    }
    for id in sync_items::unknown_signer_ids(conn)? {
        refused(conn, &id)?;
    }
    write_meta(conn, SEEDED_KEY, "1")
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
