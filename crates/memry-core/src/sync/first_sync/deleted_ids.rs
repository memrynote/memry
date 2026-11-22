//! The refs pass's queue of `deleted` ids to pull (§5.12.1, C62.1). Split out
//! of [`super`] for the line ceiling.
//!
//! Each page's `deleted` ids join the queue left by earlier pages, in memory.
//! Every full chunk of `MAX_PULL_IDS` is pulled, and on the last page the
//! rest too. Only the remainder is written back, in the transaction that
//! records the page's refs and moves its cursor. The pulls cost
//! `ceil(d / 100)` calls for the `d` ids of the whole feed, not one per page.
//! The queue lives in `meta`, so a run killed between pages pulls the ids of
//! the pages it already read when it resumes. A kill after a pull and before
//! that transaction re-reads the page and pulls again, which applies nothing
//! twice.

use std::collections::HashSet;

use rusqlite::Connection;

use crate::api::errors::StorageError;

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

/// Writes back what [`FirstSync::pull_deleted`] left, inside the page's
/// transaction. An empty queue unsets the key.
pub(super) fn keep(conn: &Connection, ids: &[String]) -> Result<(), StorageError> {
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

impl FirstSync {
    /// Pulls the queue plus a page's `deleted` ids, a full chunk at a time
    /// while the feed has more and every one after the last page, and returns
    /// what is left to [`keep`] and whether a chunk was not a pull envelope.
    /// Only the verified typed delete or attested marker a pull returns
    /// deletes; a bare id deletes nothing, as in Electron
    /// (`changes-page.ts:38`). A chunk that was not a pull envelope reopens
    /// the feed re-read in the page's transaction, so its deletes are not
    /// skipped for good.
    pub(super) async fn pull_deleted(
        &self,
        deleted: Vec<String>,
        feed_ended: bool,
    ) -> Result<(Vec<String>, bool), FirstSyncError> {
        let mut ids = self.db.call(|conn| queued(conn)).await?;
        // A set, so a hostile page of many ids costs linear time.
        let mut seen: HashSet<String> = ids.iter().cloned().collect();
        ids.extend(deleted.into_iter().filter(|id| seen.insert(id.clone())));
        let mut missed = false;
        let mut start = 0;
        while ids.len() - start >= MAX_PULL_IDS || (feed_ended && start < ids.len()) {
            let end = ids.len().min(start + MAX_PULL_IDS);
            let pulled = self.pull.fetch_ids(&ids[start..end]).await?;
            if pulled.uncovered > 0 {
                eprintln!(
                    "memry-core: first sync: {} deleted id(s) had no verified delete, ignored",
                    pulled.uncovered
                );
            }
            missed |= pulled.dropped_pages > 0;
            start = end;
        }
        Ok((ids.split_off(start), missed))
    }
}
