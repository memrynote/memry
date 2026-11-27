//! A row this device holds live while the server holds it deleted (chapter 05
//! §5.8, §5.12.3, #5406).
//!
//! Two ways an edit of such a row reaches the push wave:
//!
//! - The reconcile kept the row against a marker it could not verify
//!   ([`remember`]). For a clockless marker the server has nothing to compare
//!   and accepts any update, so pushing the edit would reverse the delete on
//!   every device. [`apply_kept_marker`] applies the marker's delete instead,
//!   and the wave sends nothing for the row.
//! - The server answers `SYNC_DELETE_WINS`. The answer is a bare server
//!   string, so it deletes nothing by itself: the wave pulls the id with its
//!   markers, and [`apply_delete_wins`] deletes the row only on a signed
//!   tombstone (applied by that pull), an attested marker, or a remembered
//!   unattested one. Otherwise the row stays live and the edit is acked, as
//!   desktop does.
//!
//! Every delete goes through the pulled-tombstone path ([`apply::apply_page_into`]),
//! so its clock is recorded for a later re-create and a note or journal's text
//! this device never pushed is kept as an inbox copy (§5.8, #3029): the queued
//! edit is still in the outbox when it runs.
//!
//! A remembered marker is one baseline `meta` row per item, so no numbered
//! migration is needed: `sync.unattested_marker\0{type}\0{id}` holding
//! `{deletedAt, serverCursor, clock}` as JSON. An older build never reads it.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use crate::api::errors::StorageError;
use crate::crypto::agent_envelope::AtRestKey;
use crate::storage::nested_tx;
use crate::storage::repositories::sync_items;

use super::apply::{self, ApplyTotals, Pending};
use super::clock::VectorClock;
use super::first_sync_store::{read_meta, write_meta};
use super::outbox::{self, Collapsed};
use super::pull::PullLoop;
use super::purged_markers;

const MARKER_KEY_PREFIX: &str = "sync.unattested_marker\0";

/// A purged marker the reconcile refused for lack of an attestation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeptMarker {
    pub deleted_at: i64,
    pub server_cursor: i64,
    /// `None` for a clockless marker.
    pub clock: Option<VectorClock>,
}

impl KeptMarker {
    fn tombstone(self, item_type: &str, item_id: &str) -> Pending {
        Pending::Tombstone {
            item_type: item_type.to_owned(),
            item_id: item_id.to_owned(),
            deleted_at: self.deleted_at,
            server_cursor: Some(self.server_cursor),
            clock: self.clock,
            body_state_vector: None,
        }
    }

    /// The server wrote nothing to the item after this marker, so it still
    /// stands for a live row held at `held_at`.
    fn stands_over(&self, held_at: Option<i64>) -> bool {
        held_at.is_none_or(|cursor| cursor < self.server_cursor)
    }
}

fn key(item_type: &str, item_id: &str) -> String {
    format!("{MARKER_KEY_PREFIX}{item_type}\0{item_id}")
}

pub(crate) fn remember(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    marker: &KeptMarker,
) -> Result<(), StorageError> {
    let value = serde_json::to_string(marker).map_err(|e| failed(e.to_string()))?;
    write_meta(conn, &key(item_type, item_id), &value)
}

/// The item was deleted, locally or by a pulled delete: the marker has been
/// honoured, and a later re-create of the id is the user's.
pub(crate) fn forget(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<(), StorageError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [key(item_type, item_id)])
        .map_err(|e| failed(e.to_string()))?;
    Ok(())
}

/// The pulled-tombstone path for one delete ([`apply::apply_page_into`]). No
/// vault root: the push holds none, so a note whose body log does not replay
/// keeps only what the log holds, as on iOS.
fn apply_tombstone(
    txn: &Connection,
    tombstone: Pending,
    now_ms: i64,
    clock_device: &str,
    at_rest: &AtRestKey,
) -> Result<ApplyTotals, StorageError> {
    let mut totals = ApplyTotals::default();
    let page = vec![tombstone];
    apply::apply_page_into(
        txn,
        page,
        now_ms,
        Some(clock_device),
        None,
        at_rest,
        &mut totals,
    )?;
    Ok(totals)
}

/// Before the wave seals a queued upsert: when the reconcile kept this row
/// against a marker, applies the marker's delete and acks the item's rows.
/// Answers whether it did, so the wave sends nothing for the row.
///
/// The marker no longer stands for the row when the server wrote the item
/// after it, and is dropped. A clocked marker the live row's clock happens
/// strictly after keeps the row (the §5.8 client rule): the server accepts
/// that write, so it is sent.
pub(crate) fn apply_kept_marker(
    conn: &Connection,
    item: &Collapsed,
    clock_device: &str,
    at_rest: &AtRestKey,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let (item_type, item_id) = (item.row.item_type.as_str(), item.row.item_id.as_str());
    if item.row.op != outbox::OP_UPSERT {
        return Ok(false);
    }
    let Some(marker) = load(conn, item_type, item_id)? else {
        return Ok(false);
    };
    let txn = nested_tx::begin(conn).map_err(sqlite)?;
    let row = sync_items::load(&txn, item_type, item_id)?;
    let stands =
        row.is_some_and(|row| row.deleted_at.is_none() && marker.stands_over(row.server_cursor));
    let deleted = stands && {
        let tombstone = marker.tombstone(item_type, item_id);
        apply_tombstone(&txn, tombstone, now_ms, clock_device, at_rest)?.deleted > 0
    };
    forget(&txn, item_type, item_id)?;
    if deleted {
        outbox::ack(&txn, &item.ids())?;
    }
    txn.commit().map_err(sqlite)?;
    Ok(deleted)
}

/// `SYNC_DELETE_WINS` for a queued upsert, after the wave pulled the id with
/// its markers (`entries`). A signed tombstone that pull returned has already
/// applied. Otherwise the live row is deleted by an attested marker, else by
/// the marker the reconcile remembered for it unless the server wrote the
/// item after that marker, each with its clock through the §5.8 client rule;
/// with neither the row stays live. The remembered marker is dropped and the
/// item's rows are acked either way. Answers whether the row is deleted now.
pub(crate) fn apply_delete_wins(
    conn: &Connection,
    item: &Collapsed,
    entries: &[Json],
    pull: Option<&PullLoop>,
    clock_device: &str,
    at_rest: &AtRestKey,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let (item_type, item_id) = (item.row.item_type.as_str(), item.row.item_id.as_str());
    let txn = nested_tx::begin(conn).map_err(sqlite)?;
    let live = sync_items::load(&txn, item_type, item_id)?.filter(|row| row.deleted_at.is_none());
    if let Some(row) = live {
        let held_at = row.server_cursor.unwrap_or(0);
        let tombstone = match pull
            .and_then(|pull| purged_markers::attested(entries, item_type, item_id, held_at, pull))
        {
            Some(tombstone) => Some(tombstone),
            None => load(&txn, item_type, item_id)?
                .filter(|marker| marker.stands_over(row.server_cursor))
                .map(|marker| marker.tombstone(item_type, item_id)),
        };
        forget(&txn, item_type, item_id)?;
        match tombstone {
            Some(tombstone) => {
                apply_tombstone(&txn, tombstone, now_ms, clock_device, at_rest)?;
            }
            None => eprintln!(
                "memry-core: push: {item_type}:{item_id} answered {} with no signed delete or attested marker, kept",
                super::push::REASON_DELETE_WINS
            ),
        }
    }
    outbox::ack(&txn, &item.ids())?;
    let deleted =
        sync_items::load(&txn, item_type, item_id)?.is_some_and(|row| row.deleted_at.is_some());
    txn.commit().map_err(sqlite)?;
    Ok(deleted)
}

fn load(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Option<KeptMarker>, StorageError> {
    read_meta(conn, &key(item_type, item_id))?
        .map(|text| serde_json::from_str::<KeptMarker>(&text))
        .transpose()
        .map_err(|e| failed(format!("unattested marker for {item_type}:{item_id}: {e}")))
}

fn sqlite(error: rusqlite::Error) -> StorageError {
    failed(error.to_string())
}

fn failed(what: String) -> StorageError {
    StorageError::Failed { what }
}

/// The remembered-marker fallback of [`apply_delete_wins`]. A wave reaches it
/// only when the reconcile remembers a marker after [`apply_kept_marker`] ran
/// for the item, so it is driven here directly.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{Db, open_data, test_support::temp_dir};
    use crate::sync::outbox::Change;

    /// A live task `t1` held at `cursor`, edited locally, and a clockless
    /// marker at cursor 9 the reconcile remembered for it.
    fn kept_row(label: &str, cursor: i64) -> (Db, crate::storage::test_support::TempDir) {
        let dir = temp_dir(label);
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        db.call_blocking(move |conn| {
            conn.execute(
                "INSERT INTO sync_items (item_type, item_id, payload, payload_state, server_cursor,
                                         clock, updated_at)
                 VALUES ('task', 't1', '{}', 'full', ?1, '{\"device-b\":3}', 1)",
                [cursor],
            )
            .map_err(sqlite)?;
            outbox::commit(conn, &Change::upsert("task", "t1"), 1, |_| Ok(()))?;
            let marker = KeptMarker {
                deleted_at: 1_700_000_000_000,
                server_cursor: 9,
                clock: None,
            };
            remember(conn, "task", "t1", &marker)
        })
        .expect("seed the kept row");
        (db, dir)
    }

    /// `SYNC_DELETE_WINS` for `t1` with no attested marker in the by-id pull.
    fn delete_wins_without_evidence(db: &Db) -> bool {
        db.call_blocking(|conn| {
            let rows = outbox::claim(conn, 2, 10, &[], &[])?;
            let item = outbox::collapse_records(rows).remove(0);
            apply_delete_wins(conn, &item, &[], None, "device-b", &AtRestKey::default(), 2)
        })
        .expect("settle the delete-wins")
    }

    fn remembered(db: &Db) -> Option<KeptMarker> {
        db.call_blocking(|conn| load(conn, "task", "t1"))
            .expect("read the marker")
    }

    #[test]
    fn a_remembered_marker_deletes_the_row_it_stands_for() {
        let (db, _dir) = kept_row("delete-wins-kept", 5);
        assert!(delete_wins_without_evidence(&db));
        assert_eq!(remembered(&db), None);
    }

    /// C78.1: the server wrote the item after the marker (a re-create), so
    /// the marker no longer stands for the row, as in [`apply_kept_marker`].
    #[test]
    fn a_remembered_marker_older_than_the_row_keeps_it_and_is_dropped() {
        let (db, _dir) = kept_row("delete-wins-stale", 12);
        assert!(
            !delete_wins_without_evidence(&db),
            "the newer row stays live"
        );
        assert_eq!(remembered(&db), None);
    }
}
