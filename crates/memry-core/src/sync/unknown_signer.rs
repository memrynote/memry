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
//! - [`retry`] re-pulls those records by id at the start of every pass, over
//!   that pass's fresh directory, at most [`MAX_RETRIES`] times per item.
//! - [`holds`] keeps a queued edit of such a row out of the push meanwhile.
//!
//! A record whose signature fails for any other reason is never retried: its
//! reason does not end with [`UNKNOWN_SIGNER`].
//!
//! The retry count is one baseline `meta` row per item, so no numbered
//! migration is needed: `sync.unknown_signer_retries\0{id}` holding the count.
//! An older build never reads it.

use rusqlite::{Connection, OptionalExtension};

use crate::api::errors::StorageError;
use crate::protocol::account::UNKNOWN_SIGNER;
use crate::storage::Db;
use crate::storage::repositories::sync_items;

use super::first_sync_store::{read_meta, write_meta};
use super::pull::PullLoop;

/// Passes that re-pull one item. A signer still missing after this many fresh
/// directories is not a device of the account; the row stays as it is.
pub(crate) const MAX_RETRIES: u32 = 5;

const RETRY_KEY_PREFIX: &str = "sync.unknown_signer_retries\0";

fn key(item_id: &str) -> String {
    format!("{RETRY_KEY_PREFIX}{item_id}")
}

fn retries(conn: &Connection, item_id: &str) -> Result<u32, StorageError> {
    Ok(read_meta(conn, &key(item_id))?
        .and_then(|count| count.parse().ok())
        .unwrap_or(0))
}

/// Re-pulls, by id, every record still refused for an unknown signer and
/// under its retry budget. The caller built `pull` over the directory it
/// fetched for this pass. A failed re-pull is logged and counts no attempt.
pub(crate) async fn retry(db: &Db, pull: &PullLoop) -> Result<(), StorageError> {
    let due = db
        .call(|conn| {
            let mut due = Vec::new();
            for id in sync_items::unknown_signer_ids(conn)? {
                if retries(conn, &id)? < MAX_RETRIES {
                    due.push(id);
                }
            }
            Ok(due)
        })
        .await?;
    if due.is_empty() {
        return Ok(());
    }
    if let Err(error) = pull.fetch_ids(&due).await {
        eprintln!(
            "memry-core: re-pulling {} record(s) of an unknown signer failed: {error}",
            due.len()
        );
        return Ok(());
    }
    db.call(move |conn| {
        let still = sync_items::unknown_signer_ids(conn)?;
        for id in due {
            if !still.contains(&id) {
                conn.execute("DELETE FROM meta WHERE key = ?1", [key(&id)])
                    .map_err(failed)?;
                continue;
            }
            let attempts = retries(conn, &id)? + 1;
            write_meta(conn, &key(&id), &attempts.to_string())?;
            if attempts == MAX_RETRIES {
                eprintln!(
                    "memry-core: {id}'s signer is still unknown after {attempts} directories; \
                     no longer re-pulled"
                );
            }
        }
        Ok(())
    })
    .await
}

/// Whether a queued edit of this row waits: the row's last pulled record was
/// refused for an unknown signer and is still being re-pulled. Sending the
/// edit could reverse a delete this device has not verified yet.
pub(crate) fn holds(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<bool, StorageError> {
    let reason: Option<String> = conn
        .query_row(
            "SELECT corrupt_reason FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
            [item_type, item_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?
        .flatten();
    if !reason.is_some_and(|reason| reason.ends_with(UNKNOWN_SIGNER)) {
        return Ok(false);
    }
    Ok(retries(conn, item_id)? < MAX_RETRIES)
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
