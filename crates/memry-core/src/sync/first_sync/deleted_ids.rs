//! The refs pass's queue of `deleted` ids to pull (§5.12.1, C62.1). Split out
//! of [`super`] for the line ceiling.
//!
//! A page's `deleted` ids are queued in the transaction that records its refs
//! and moves the cursor, and pulled `MAX_PULL_IDS` at a time: a full chunk as
//! soon as one is queued, the rest after the last page. The pulls cost
//! `ceil(d / 100)` calls for the `d` ids of the whole feed, not one per page.
//! The queue lives in `meta`, so a run killed between pages pulls the ids of
//! the pages it already read when it resumes; a kill after a pull and before
//! its ids leave the queue pulls them again, which applies nothing twice.

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::storage::nested_tx;

use super::super::feed_restart;
use super::super::first_sync_store::{read_meta, write_meta};
use super::super::pull::MAX_PULL_IDS;
use super::{FirstSync, FirstSyncError, sqlite_failed};

/// The queued ids, a JSON array in feed order. Unset when the queue is empty.
const META_FIRST_SYNC_DELETED_IDS: &str = "first_sync.deleted_ids";

fn queued(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let Some(value) = read_meta(conn, META_FIRST_SYNC_DELETED_IDS)? else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&value).map_err(|error| StorageError::Failed {
        what: format!("{META_FIRST_SYNC_DELETED_IDS}: {error}"),
    })
}

fn store(conn: &Connection, ids: &[String]) -> Result<(), StorageError> {
    if ids.is_empty() {
        conn.execute(
            "DELETE FROM meta WHERE key = ?1",
            [META_FIRST_SYNC_DELETED_IDS],
        )
        .map_err(sqlite_failed)?;
        return Ok(());
    }
    let value = serde_json::to_string(ids).map_err(|error| StorageError::Failed {
        what: format!("{META_FIRST_SYNC_DELETED_IDS}: {error}"),
    })?;
    write_meta(conn, META_FIRST_SYNC_DELETED_IDS, &value)
}

/// Adds a page's `deleted` ids, inside the page's transaction.
pub(super) fn queue(conn: &Connection, deleted: &[String]) -> Result<(), StorageError> {
    if deleted.is_empty() {
        return Ok(());
    }
    let mut ids = queued(conn)?;
    for id in deleted {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    store(conn, &ids)
}

impl FirstSync {
    /// Pulls the queued ids, a full chunk at a time while the feed has more
    /// and every one after the last page. Only the verified typed delete or
    /// attested marker a pull returns deletes; a bare id deletes nothing, as
    /// in Electron (`changes-page.ts:38`). A chunk that was not a pull
    /// envelope reopens the feed re-read, so its deletes are not skipped for
    /// good.
    pub(super) async fn pull_deleted(&self, feed_ended: bool) -> Result<(), FirstSyncError> {
        loop {
            let ids = self.db.call(|conn| queued(conn)).await?;
            if ids.is_empty() || (ids.len() < MAX_PULL_IDS && !feed_ended) {
                return Ok(());
            }
            let chunk = ids[..ids.len().min(MAX_PULL_IDS)].to_vec();
            let pulled = self.pull.fetch_ids(&chunk).await?;
            if pulled.uncovered > 0 {
                eprintln!(
                    "memry-core: first sync: {} deleted id(s) had no verified delete, ignored",
                    pulled.uncovered
                );
            }
            let missed = pulled.dropped_pages > 0;
            self.db
                .call(move |conn| {
                    let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
                    let left: Vec<String> = queued(&txn)?
                        .into_iter()
                        .filter(|id| !chunk.contains(id))
                        .collect();
                    store(&txn, &left)?;
                    if missed {
                        feed_restart::reopen_cursor_skip_repair(&txn)?;
                    }
                    txn.commit().map_err(sqlite_failed)
                })
                .await?;
        }
    }
}
