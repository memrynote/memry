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
//! A record whose signature fails for any other reason is never retried: its
//! reason does not end with
//! [`crate::protocol::account::UNKNOWN_SIGNER`].
//!
//! The rows are baseline `meta` rows, so no numbered migration is needed:
//! `sync.unknown_signer_retries:{id}` holding the passes that re-pulled it.
//! An older build never reads them. A refusal recorded only in
//! `corrupt_reason`, by an older build or any other writer, is adopted when
//! [`retry`] runs ([`adopt_unrecorded`]); when its wait ends, its reason gets
//! [`WAIT_ENDED`], which stops it being adopted again.

use std::collections::HashSet;

use rusqlite::{Connection, params};

use crate::api::errors::{ApiError, StorageError};
use crate::protocol::account::UNKNOWN_SIGNER;
use crate::storage::Db;
use crate::storage::repositories::sync_items;

use super::apply::Pending;
use super::first_sync_store::{read_meta, write_meta};
use super::outbox::{self, OutboxRow};
use super::pull::{PullError, PullLoop};

/// Passes that re-pull one refusal. A signer still missing after this many
/// fresh directories is not a device of the account; the row stays as it is.
pub(crate) const MAX_RETRIES: u32 = 5;

const KEY_PREFIX: &str = "sync.unknown_signer_retries:";
/// The first key past every [`KEY_PREFIX`] key (`;` follows `:`).
const KEY_END: &str = "sync.unknown_signer_retries;";
/// Appended to the reason of a refusal whose wait ended unverified, so it no
/// longer ends with [`UNKNOWN_SIGNER`] and is not adopted again.
const WAIT_ENDED: &str = " (no longer re-pulled)";

fn key(item_id: &str) -> String {
    format!("{KEY_PREFIX}{item_id}")
}

/// Records a fresh refusal of `item_id`'s record: a full retry budget.
pub(crate) fn refused(conn: &Connection, item_id: &str) -> Result<(), StorageError> {
    write_meta(conn, &key(item_id), "0")
}

/// Ends the wait on every id in `pending`: each arrived verified, applied or
/// skipped, so its signer is known and nothing is left to re-pull.
pub(crate) fn resolve_verified(conn: &Connection, pending: &[Pending]) -> Result<(), StorageError> {
    if pending.is_empty() {
        return Ok(());
    }
    // Only a waiting id runs `drop_refusal`, whose `sync_items` update scans
    // the table (no index on `item_id`), inside the page's write transaction.
    let waiting: HashSet<String> = waiting(conn)?.into_iter().map(|(id, _)| id).collect();
    for item in pending {
        if waiting.contains(item.item_id()) {
            drop_refusal(conn, item.item_id())?;
        }
    }
    Ok(())
}

/// Whether a queued edit of this row waits: its last pulled record was
/// refused for an unknown signer and is still being re-pulled. Sending the
/// edit could reverse a delete this device has not verified yet.
pub(crate) fn holds(conn: &Connection, item_id: &str) -> Result<bool, StorageError> {
    Ok(read_meta(conn, &key(item_id))?.is_some())
}

/// Why a queued row waits instead of being sent: an upsert of a row
/// [`holds`] keeps. `None` sends it.
pub(crate) async fn held(db: &Db, row: &OutboxRow) -> Result<Option<String>, StorageError> {
    if row.op != outbox::OP_UPSERT {
        return Ok(None);
    }
    let item_id = row.item_id.clone();
    let held = db.call(move |conn| holds(conn, &item_id)).await?;
    Ok(held.then(|| "held: its last pulled record waits on an unknown signer".to_owned()))
}

/// Re-pulls, by id, every refusal still waiting. The caller built `pull` over
/// the directory it fetched for this pass. A transport failure is logged and
/// counts no attempt; any other failure counts one.
pub(crate) async fn retry(db: &Db, pull: &PullLoop) -> Result<(), StorageError> {
    let due = db
        .call(|conn| {
            adopt_unrecorded(conn)?;
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
        if let PullError::Api { source } = &error
            && is_transport(source)
        {
            return Ok(());
        }
    }
    db.call(move |conn| count_attempt(conn, due)).await
}

/// A directory refetch for the re-pull failed. Like a failed re-pull, a
/// transport failure counts no attempt and any other failure counts one for
/// every waiting id, so a directory that never loads cannot hold an edit
/// forever.
pub(crate) async fn directory_failed(db: &Db, error: &ApiError) -> Result<(), StorageError> {
    if is_transport(error) {
        return Ok(());
    }
    db.call(|conn| {
        adopt_unrecorded(conn)?;
        let due = waiting(conn)?;
        count_attempt(conn, due)
    })
    .await
}

fn is_transport(error: &ApiError) -> bool {
    matches!(error, ApiError::Transport { .. })
}

/// Counts this pass's attempt for each of `due`, ending the wait of one whose
/// budget ran out.
fn count_attempt(conn: &Connection, due: Vec<(String, u32)>) -> Result<(), StorageError> {
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
}

/// Whether any refusal waits.
pub(crate) fn any_waiting(conn: &Connection) -> Result<bool, StorageError> {
    Ok(!waiting(conn)?.is_empty())
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
    conn.execute(
        "UPDATE sync_items SET corrupt_reason = corrupt_reason || ?2
         WHERE item_id = ?1 AND substr(corrupt_reason, -length(?3)) = ?3",
        params![item_id, WAIT_ENDED, UNKNOWN_SIGNER],
    )
    .map_err(failed)?;
    Ok(())
}

/// Adopts the refusals recorded only in `corrupt_reason`: by an older build,
/// or by a writer that does not call [`refused`].
fn adopt_unrecorded(conn: &Connection) -> Result<(), StorageError> {
    for id in sync_items::unknown_signer_ids(conn)? {
        if read_meta(conn, &key(&id))?.is_none() {
            refused(conn, &id)?;
        }
    }
    Ok(())
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
