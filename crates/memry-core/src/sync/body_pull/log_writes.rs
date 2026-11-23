//! The durable writes of [`BodyPull`]: updates and baselines land with their
//! cursors in one transaction per chunk (§7.9, #5231), and an empty log leaves
//! a cursor too.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::crdt::update_log;
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
    pub(super) async fn store_updates(
        &self,
        doc_id: &str,
        updates: Vec<(i64, Vec<u8>)>,
    ) -> Result<(), BodyPullError> {
        let Some(&(last, _)) = updates.last() else {
            return Ok(());
        };
        let doc = doc_id.to_owned();
        let scope = crdt_cursor_scope(doc_id);
        self.db
            .call(move |conn| {
                // Stamped under the writer, not before waiting for it: a body entry's stamp is
                // then later than every read of the body that did not see it, which the
                // desktop write-back's stamp relies on (`domain::note_files::NoteFile::indexed_at`).
                let created_at = now_ms();
                let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
                for (sequence_num, update) in &updates {
                    update_log::append_server_update(&txn, &doc, *sequence_num, update, created_at)
                        .map_err(crdt_failed)?;
                }
                store::write_cursor(&txn, &scope, Some(&last.to_string()), created_at)?;
                txn.commit().map_err(sqlite_failed)
            })
            .await?;
        Ok(())
    }

    /// §7.8: store the snapshot with its sequence number and revision, and
    /// advance the cursor **only if** the snapshot's sequence number is ahead.
    pub(super) async fn store_baseline(
        &self,
        doc_id: &str,
        snapshot: Vec<u8>,
        sequence_num: i64,
        revision: Option<String>,
        cursor: i64,
    ) -> Result<(), BodyPullError> {
        let doc = doc_id.to_owned();
        self.db
            .call(move |conn| {
                // Under the writer, as `store_updates` stamps.
                let now = now_ms();
                let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
                put_baseline(
                    &txn,
                    &doc,
                    &snapshot,
                    sequence_num,
                    revision.as_deref(),
                    Some(cursor),
                    now,
                )?;
                txn.commit().map_err(sqlite_failed)
            })
            .await?;
        Ok(())
    }

    /// A pack chunk's verified baselines, each with its cursor, in one
    /// transaction. Freshness is checked again inside it, so a document that
    /// moved since the caller's read is left alone. Answers, per baseline,
    /// whether it was stored.
    pub(super) async fn store_baselines(
        &self,
        baselines: Vec<Baseline>,
    ) -> Result<Vec<bool>, BodyPullError> {
        let stored = self
            .db
            .call(move |conn| {
                // Under the writer, as `store_updates` stamps.
                let now = now_ms();
                let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
                let mut stored = Vec::with_capacity(baselines.len());
                for baseline in &baselines {
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
    /// one and the record is live, both read inside the transaction; answers
    /// the updates stored per run.
    pub(super) async fn store_pack_runs(
        &self,
        runs: Vec<PackRun>,
    ) -> Result<Vec<usize>, BodyPullError> {
        let stored = self
            .db
            .call(move |conn| {
                // Under the writer, as `store_updates` says why.
                let now = now_ms();
                let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
                let mut stored = Vec::with_capacity(runs.len());
                for (doc_id, updates) in &runs {
                    let scope = crdt_cursor_scope(doc_id);
                    let cursor: i64 = store::read_cursor(&txn, &scope)?
                        .and_then(|text| text.parse().ok())
                        .unwrap_or(0);
                    let Some(&(last, _)) = updates.last() else {
                        stored.push(0);
                        continue;
                    };
                    if updates[0].0 != cursor + 1 || record_gone(&txn, doc_id)? {
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

    /// A `crdt:<docId>` cursor of `0`, unless one is already stored.
    pub(super) async fn hold_empty_body(&self, doc_id: &str) -> Result<(), BodyPullError> {
        let scope = crdt_cursor_scope(doc_id);
        let now = now_ms();
        self.db
            .call(move |conn| match store::read_cursor(conn, &scope)? {
                Some(_) => Ok(()),
                None => store::write_cursor(conn, &scope, Some("0"), now),
            })
            .await?;
        Ok(())
    }
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
    let stored = update_log::server_revision(conn, doc_id)?;
    if stored.as_deref() == Some(revision) {
        return Ok(Freshness::Stale);
    }
    Ok(Freshness::Fresh { cursor })
}

/// §7.15 and §8.10: a document whose record is a tombstone, or that has no
/// live note or journal record at all, takes no packed body.
pub(super) fn record_gone(conn: &Connection, doc_id: &str) -> Result<bool, StorageError> {
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
