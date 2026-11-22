//! A row this device holds live while the server holds it deleted (chapter 05
//! §5.8, §5.12.3, #5406).
//!
//! Two ways an edit of such a row reaches the push wave:
//!
//! - The server answers `SYNC_DELETE_WINS`. §5.8 makes that terminal, and the
//!   recovery it names is applying the delete locally. Desktop leaves that to
//!   its next pull, but a row the first-sync reconcile kept against an
//!   unattested marker never gets its delete from a pull, so an ack alone left
//!   the edit gone and the item live here. [`apply_delete_wins`] applies it.
//! - The reconcile kept the row against a marker it could not verify
//!   ([`remember`]). For a clockless marker the server has nothing to compare
//!   and accepts any update, so pushing the edit would reverse the delete on
//!   every device. [`apply_kept_marker`] applies the marker's delete instead,
//!   and the wave sends nothing for the row.
//!
//! Both go through the pulled-tombstone path ([`apply::apply_page`]), so a
//! note or journal's text this device never pushed is kept as an inbox copy
//! (§5.8, #3029): the queued edit is still in the outbox when it runs.

use rusqlite::{Connection, OptionalExtension, params};

use crate::api::errors::StorageError;
use crate::storage::nested_tx;
use crate::storage::repositories::sync_items;

use super::apply::{self, Pending};
use super::clock::VectorClock;
use super::outbox::{self, Collapsed};

/// A purged marker the reconcile refused for lack of an attestation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct KeptMarker {
    pub deleted_at: i64,
    pub server_cursor: i64,
    /// `None` for a clockless marker.
    pub clock: Option<VectorClock>,
}

pub(crate) fn remember(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    marker: &KeptMarker,
    now_ms: i64,
) -> Result<(), StorageError> {
    let clock = marker
        .clock
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| failed(e.to_string()))?;
    conn.execute(
        "INSERT INTO sync_unattested_markers
             (item_type, item_id, deleted_at, server_cursor, clock, recorded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(item_type, item_id) DO UPDATE SET
             deleted_at = excluded.deleted_at, server_cursor = excluded.server_cursor,
             clock = excluded.clock, recorded_at = excluded.recorded_at",
        params![
            item_type,
            item_id,
            marker.deleted_at,
            marker.server_cursor,
            clock,
            now_ms
        ],
    )
    .map_err(sqlite)?;
    Ok(())
}

/// The item was deleted, locally or by a pulled delete: the marker has been
/// honoured, and a later re-create of the id is the user's.
pub(crate) fn forget(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM sync_unattested_markers WHERE item_type = ?1 AND item_id = ?2",
        params![item_type, item_id],
    )
    .map_err(sqlite)?;
    Ok(())
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
    clock_device: Option<&str>,
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
    let stands = row.is_some_and(|row| {
        row.deleted_at.is_none()
            && row
                .server_cursor
                .is_none_or(|cursor| cursor < marker.server_cursor)
    });
    let deleted = stands && {
        let tombstone = Pending::Tombstone {
            item_type: item_type.to_owned(),
            item_id: item_id.to_owned(),
            deleted_at: marker.deleted_at,
            server_cursor: Some(marker.server_cursor),
            clock: marker.clock,
            body_state_vector: None,
        };
        apply::apply_page(&txn, vec![tombstone], Vec::new(), now_ms, clock_device)?.deleted > 0
    };
    forget(&txn, item_type, item_id)?;
    if deleted {
        outbox::ack(&txn, &item.ids())?;
    }
    txn.commit().map_err(sqlite)?;
    Ok(deleted)
}

/// `SYNC_DELETE_WINS` for a queued upsert: applies the server's delete to the
/// live row, then acks the item's rows. The answer carries no clock or cursor,
/// so the delete applies unconditionally, as a clockless tombstone does; the
/// tombstone a later pull brings overwrites `deleted_at` and records its clock.
pub(crate) fn apply_delete_wins(
    conn: &Connection,
    item: &Collapsed,
    clock_device: Option<&str>,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let (item_type, item_id) = (item.row.item_type.as_str(), item.row.item_id.as_str());
    let txn = nested_tx::begin(conn).map_err(sqlite)?;
    let live =
        sync_items::load(&txn, item_type, item_id)?.is_some_and(|row| row.deleted_at.is_none());
    if live {
        let tombstone = Pending::Tombstone {
            item_type: item_type.to_owned(),
            item_id: item_id.to_owned(),
            deleted_at: now_ms,
            server_cursor: None,
            clock: None,
            body_state_vector: None,
        };
        apply::apply_page(&txn, vec![tombstone], Vec::new(), now_ms, clock_device)?;
    }
    outbox::ack(&txn, &item.ids())?;
    txn.commit().map_err(sqlite)?;
    Ok(live)
}

fn load(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Option<KeptMarker>, StorageError> {
    let row: Option<(i64, i64, Option<String>)> = conn
        .query_row(
            "SELECT deleted_at, server_cursor, clock FROM sync_unattested_markers
              WHERE item_type = ?1 AND item_id = ?2",
            params![item_type, item_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(sqlite)?;
    let Some((deleted_at, server_cursor, clock)) = row else {
        return Ok(None);
    };
    let clock = clock
        .map(|text| serde_json::from_str::<VectorClock>(&text))
        .transpose()
        .map_err(|e| {
            failed(format!(
                "unattested marker clock for {item_type}:{item_id}: {e}"
            ))
        })?;
    Ok(Some(KeptMarker {
        deleted_at,
        server_cursor,
        clock,
    }))
}

fn sqlite(error: rusqlite::Error) -> StorageError {
    failed(error.to_string())
}

fn failed(what: String) -> StorageError {
    StorageError::Failed { what }
}
