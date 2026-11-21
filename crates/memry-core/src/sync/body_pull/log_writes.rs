//! The durable writes of [`BodyPull`]: updates and baselines land with their
//! cursors in one transaction per chunk (§7.9, #5231), and an empty log leaves
//! a cursor too. The local reads a pull starts from live here as well.
//!
//! Every write first checks, in its own transaction, that the body it fetched
//! for is still the document's body ([`same_body`], #5356).

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::crdt::epoch;
use crate::crdt::update_log::{self, Namespace};
use crate::storage::nested_tx;
use crate::sync::store;

use super::{BodyPull, BodyPullError, crdt_cursor_scope, now_ms};

/// One document's opened packed updates, in sequence order.
pub(super) type PackRun = (String, Vec<(i64, Vec<u8>)>);

/// One verified baseline from a pack, ready to store.
pub(super) struct Baseline {
    pub(super) doc_id: String,
    pub(super) snapshot: Vec<u8>,
    pub(super) sequence_num: i64,
    pub(super) revision: String,
}

/// Every document's epoch (§7.16) before a pack bootstrap fetched anything,
/// for [`same_body`] at each seed (#5356). Read
/// with [`BodyPull::body_epochs`].
#[derive(Debug, Clone, Default)]
pub struct BodyEpochs(HashMap<String, i64>);

impl BodyEpochs {
    fn of(&self, doc_id: &str) -> i64 {
        self.0.get(doc_id).copied().unwrap_or(0)
    }
}

impl BodyPull {
    /// One page's opened updates, in order, durable **with** the cursor of the
    /// last one. §7.9 asks that no cursor ever lead its rows; one transaction
    /// for the page keeps that and a kill mid-page leaves the cursor at the
    /// previous page, so the page is pulled again and no row is skipped.
    ///
    /// The log rows are stamped with **this device's** clock at apply time,
    /// not the server's `createdAt`: the search index's incremental watermark
    /// compares `yjs_updates.created_at` against its own epoch-ms stamps
    /// (`domain::search::maintenance`), and a server stamp (seconds, or a
    /// remote clock) sat below it, so a pulled body was never re-indexed and
    /// its links never became backlinks.
    ///
    /// Answers `false`, storing nothing, when the body moved off `epoch`.
    pub(super) async fn store_updates(
        &self,
        doc_id: &str,
        epoch: i64,
        updates: Vec<(i64, Vec<u8>)>,
    ) -> Result<bool, BodyPullError> {
        let Some(&(last, _)) = updates.last() else {
            return Ok(true);
        };
        let doc = doc_id.to_owned();
        let scope = crdt_cursor_scope(doc_id);
        let created_at = now_ms();
        let stored = self
            .db
            .call(move |conn| {
                let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
                if !same_body(&txn, &doc, epoch)? {
                    return Ok(false);
                }
                for (sequence_num, update) in &updates {
                    update_log::append_server_update(&txn, &doc, *sequence_num, update, created_at)
                        .map_err(crdt_failed)?;
                }
                store::write_cursor(&txn, &scope, Some(&last.to_string()), created_at)?;
                txn.commit().map_err(sqlite_failed)?;
                Ok(true)
            })
            .await?;
        Ok(stored)
    }

    /// §7.8: store the snapshot with its sequence number and revision, and
    /// advance the cursor **only if** the snapshot's sequence number is ahead.
    /// Answers `false`, storing nothing, when the body moved off `epoch`.
    pub(super) async fn store_baseline(
        &self,
        doc_id: &str,
        epoch: i64,
        snapshot: Vec<u8>,
        sequence_num: i64,
        revision: Option<String>,
        cursor: i64,
    ) -> Result<bool, BodyPullError> {
        let doc = doc_id.to_owned();
        let now = now_ms();
        let stored = self
            .db
            .call(move |conn| {
                let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
                if !same_body(&txn, &doc, epoch)? {
                    return Ok(false);
                }
                put_baseline(
                    &txn,
                    &doc,
                    &snapshot,
                    sequence_num,
                    revision.as_deref(),
                    Some(cursor),
                    now,
                )?;
                txn.commit().map_err(sqlite_failed)?;
                Ok(true)
            })
            .await?;
        Ok(stored)
    }

    /// A pack chunk's verified baselines, each with its cursor, in one
    /// transaction. Freshness is checked again inside it, so a document that
    /// moved since the caller's read is left alone. Answers, per baseline,
    /// whether it was stored.
    pub(super) async fn store_baselines(
        &self,
        baselines: Vec<Baseline>,
        epochs: &BodyEpochs,
    ) -> Result<Vec<bool>, BodyPullError> {
        let epochs: Vec<i64> = baselines.iter().map(|b| epochs.of(&b.doc_id)).collect();
        let now = now_ms();
        let stored = self
            .db
            .call(move |conn| {
                let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
                let mut stored = Vec::with_capacity(baselines.len());
                for (baseline, epoch) in baselines.iter().zip(epochs) {
                    if !same_body(&txn, &baseline.doc_id, epoch)? {
                        stored.push(false);
                        continue;
                    }
                    let fresh = pack_freshness(
                        &txn,
                        baseline.sequence_num,
                        &baseline.doc_id,
                        &baseline.revision,
                    )?;
                    let Freshness::Fresh { cursor } = fresh else {
                        stored.push(false);
                        continue;
                    };
                    put_baseline(
                        &txn,
                        &baseline.doc_id,
                        &baseline.snapshot,
                        baseline.sequence_num,
                        Some(&baseline.revision),
                        cursor,
                        now,
                    )?;
                    stored.push(true);
                }
                txn.commit().map_err(sqlite_failed)?;
                Ok(stored)
            })
            .await?;
        Ok(stored)
    }

    /// Opened packed updates, one run per document in sequence order, each
    /// run stored with its cursor in one transaction for the chunk (§7.9).
    /// A run is stored only when its first update is the stored cursor plus
    /// one, the record is live and the body is the one in `epochs`, all read
    /// inside the transaction; answers the updates stored per run.
    pub(super) async fn store_pack_runs(
        &self,
        runs: Vec<PackRun>,
        epochs: &BodyEpochs,
    ) -> Result<Vec<usize>, BodyPullError> {
        let epochs: Vec<i64> = runs.iter().map(|(doc_id, _)| epochs.of(doc_id)).collect();
        let now = now_ms();
        let stored = self
            .db
            .call(move |conn| {
                let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
                let mut stored = Vec::with_capacity(runs.len());
                for ((doc_id, updates), epoch) in runs.iter().zip(epochs) {
                    let scope = crdt_cursor_scope(doc_id);
                    let cursor: i64 = store::read_cursor(&txn, &scope)?
                        .and_then(|text| text.parse().ok())
                        .unwrap_or(0);
                    let Some(&(last, _)) = updates.last() else {
                        stored.push(0);
                        continue;
                    };
                    if updates[0].0 != cursor + 1
                        || record_gone(&txn, doc_id)?
                        || !same_body(&txn, doc_id, epoch)?
                    {
                        stored.push(0);
                        continue;
                    }
                    for (sequence_num, update) in updates {
                        update_log::append_server_update(&txn, doc_id, *sequence_num, update, now)
                            .map_err(crdt_failed)?;
                    }
                    store::write_cursor(&txn, &scope, Some(&last.to_string()), now)?;
                    stored.push(updates.len());
                }
                txn.commit().map_err(sqlite_failed)?;
                Ok(stored)
            })
            .await?;
        Ok(stored)
    }

    /// A `crdt:<docId>` cursor of `0`, unless one is already stored or the
    /// body moved off `epoch`.
    pub(super) async fn hold_empty_body(
        &self,
        doc_id: &str,
        epoch: i64,
    ) -> Result<(), BodyPullError> {
        let doc = doc_id.to_owned();
        let scope = crdt_cursor_scope(doc_id);
        let now = now_ms();
        self.db
            .call(move |conn| {
                let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
                if same_body(&txn, &doc, epoch)? && store::read_cursor(&txn, &scope)?.is_none() {
                    store::write_cursor(&txn, &scope, Some("0"), now)?;
                }
                txn.commit().map_err(sqlite_failed)
            })
            .await?;
        Ok(())
    }

    pub(super) async fn read_cursor(&self, doc_id: &str) -> Result<i64, BodyPullError> {
        Ok(self.stored_cursor(doc_id).await?.unwrap_or(0))
    }

    /// `None` when this device never pulled the document.
    pub(super) async fn stored_cursor(&self, doc_id: &str) -> Result<Option<i64>, BodyPullError> {
        let scope = crdt_cursor_scope(doc_id);
        let stored = self
            .db
            .call(move |conn| store::read_cursor(conn, &scope))
            .await?;
        Ok(stored.and_then(|text| text.parse().ok()))
    }

    /// `doc_id`'s epoch, read before a pull fetches anything for it.
    pub(super) async fn body_epoch(&self, doc_id: &str) -> Result<i64, BodyPullError> {
        let doc = doc_id.to_owned();
        let epoch = self
            .db
            .call(move |conn| epoch::read(conn, &doc).map_err(crdt_failed))
            .await?;
        Ok(epoch)
    }

    /// Every document's epoch, read before a pack bootstrap fetches anything.
    pub async fn body_epochs(&self) -> Result<BodyEpochs, BodyPullError> {
        let epochs = self
            .db
            .call(|conn| epoch::read_all(conn).map_err(crdt_failed))
            .await?;
        Ok(BodyEpochs(epochs))
    }
}

/// §7.15, §7.16 (#5356): whether what a pull fetched for `doc_id` while its
/// body was at `epoch` may still be stored. Every purge moves the epoch: a
/// delete's (§7.15.1 purges in the tombstone's transaction) and a revive's.
/// What was fetched before it belongs to the purged body, and stored after a
/// revive it lands in the new body, where the next edit builds on content the
/// server purged (#5351). Not a record check: the journal day merge pulls a
/// foreign id that has no record row.
pub(super) fn same_body(conn: &Connection, doc_id: &str, epoch: i64) -> Result<bool, StorageError> {
    Ok(epoch::read(conn, doc_id).map_err(crdt_failed)? == epoch)
}

/// Whether a packed snapshot still has anything to give this document.
pub(super) enum Freshness {
    Fresh {
        /// `None` when the document holds no cursor yet.
        cursor: Option<i64>,
    },
    /// The cursor already reaches the snapshot, or the stored revision is
    /// this one (§7.5, equality only).
    Stale,
    /// §7.15, §8.10: the record is a tombstone or absent, so the document's
    /// body is never resurrected.
    Deleted,
}

/// Desktop's `shouldApply` for a pack entry, plus the record check.
pub(super) fn pack_freshness(
    conn: &Connection,
    sequence_num: i64,
    doc_id: &str,
    revision: &str,
) -> Result<Freshness, StorageError> {
    if record_gone(conn, doc_id)? {
        return Ok(Freshness::Deleted);
    }
    // No cursor is no baseline: a snapshot at `sequenceNum` 0 (pushed before
    // any update row) is still the whole body.
    let cursor: Option<i64> =
        store::read_cursor(conn, &crdt_cursor_scope(doc_id))?.and_then(|text| text.parse().ok());
    if cursor.is_some_and(|cursor| cursor >= sequence_num) {
        return Ok(Freshness::Stale);
    }
    let stored: Option<String> = conn
        .prepare_cached("SELECT server_revision FROM yjs_snapshots WHERE doc_id = ?1")
        .and_then(|mut statement| {
            statement
                .query_row(params![Namespace::Server.row_id(doc_id)], |row| row.get(0))
                .optional()
        })
        .map_err(sqlite_failed)?
        .flatten();
    if stored.as_deref() == Some(revision) {
        return Ok(Freshness::Stale);
    }
    Ok(Freshness::Fresh { cursor })
}

/// §7.15 and §8.10: a document whose record is a tombstone, or that has no
/// live note or journal record at all, takes no packed body.
fn record_gone(conn: &Connection, doc_id: &str) -> Result<bool, StorageError> {
    conn.prepare_cached(
        "SELECT NOT EXISTS(SELECT 1 FROM sync_items WHERE item_id = ?1
                             AND item_type IN ('note', 'journal') AND deleted_at IS NULL)
             OR EXISTS(SELECT 1 FROM sync_items WHERE item_id = ?1 AND deleted_at IS NOT NULL)",
    )
    .and_then(|mut statement| statement.query_row(params![doc_id], |row| row.get::<_, bool>(0)))
    .map_err(sqlite_failed)
}

fn put_baseline(
    conn: &Connection,
    doc_id: &str,
    snapshot: &[u8],
    sequence_num: i64,
    revision: Option<&str>,
    cursor: Option<i64>,
    now: i64,
) -> Result<(), StorageError> {
    update_log::put_server_snapshot(conn, doc_id, snapshot, sequence_num, revision, now)
        .map_err(crdt_failed)?;
    if cursor.is_none_or(|cursor| sequence_num > cursor) {
        let scope = crdt_cursor_scope(doc_id);
        store::write_cursor(conn, &scope, Some(&sequence_num.to_string()), now)?;
    }
    Ok(())
}

fn crdt_failed(error: crate::crdt::CrdtError) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn sqlite_failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
