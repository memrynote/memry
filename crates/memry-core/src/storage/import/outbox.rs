//! The import's sync bookkeeping: Electron's delete clocks and its queued record pushes. Every
//! queued push reaches the core outbox through [`outbox::enqueue`], the one writer that applies
//! the outbox's rules (collapse, local-only withholding, the calendar hook).

use rusqlite::{Connection, OptionalExtension, params};

use super::{ImportWriter, failed};
use crate::api::errors::StorageError;
use crate::storage::repositories::StoredPayload;
use crate::storage::repositories::projectors::{self, ItemContext};
use crate::storage::repositories::sync_items::PAYLOAD_STATE_FULL;
use crate::sync::clock::VectorClock;
use crate::sync::outbox::{self, Change, RecordOp};

/// One `sync_tombstone_clocks` row: the highest delete clock Electron saw for the id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportTombstoneClock {
    pub item_type: String,
    pub item_id: String,
    pub clock: VectorClock,
    pub updated_at: i64,
}

/// One record push Electron still owes the server, folded over its `sync_queue` rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportQueued {
    pub item_type: String,
    pub item_id: String,
    pub op: RecordOp,
    /// For a delete: its tombstone row, written from the payload Electron froze when the delete
    /// was queued. It replaces a staged row the delete supersedes (a soft-deleted tag category).
    pub tombstone: Option<ImportDeleted>,
    /// For a create or upsert that minted the record's first clock (Electron's seed of unclocked
    /// rows, a never-synced row's create): the live record's payload carrying that clock, written
    /// over the staged one before the row is queued. Its `clock` fills the `clock` column.
    pub minted: Option<String>,
    pub enqueued_at: i64,
}

/// The `sync_items` tombstone of a queued delete. `payload` is the delete body Electron pushes,
/// stored verbatim; `clock` is the clock it carries. The core push retires a delete without a
/// clock, so one is required.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportDeleted {
    pub payload: String,
    pub clock: VectorClock,
    pub deleted_at: i64,
}

impl ImportWriter {
    /// Copies delete clocks in one transaction. An id already holding one keeps the pointwise
    /// maximum, as `record_tombstone_clock` does.
    pub fn put_tombstone_clocks(
        &mut self,
        rows: &[ImportTombstoneClock],
    ) -> Result<(), StorageError> {
        let tx = self.data.transaction().map_err(failed)?;
        for row in rows {
            crate::sync::store::record_tombstone_clock(
                &tx,
                &row.item_type,
                &row.item_id,
                &row.clock,
                row.updated_at,
            )?;
        }
        tx.commit().map_err(failed)
    }

    /// Queues `items` in order, in one transaction. Returns, per item, whether a row was queued:
    /// `false` for a local-only note, which [`outbox::enqueue`] withholds.
    pub fn put_outbox(&mut self, items: &[ImportQueued]) -> Result<Vec<bool>, StorageError> {
        let tx = self.data.transaction().map_err(failed)?;
        let mut queued = Vec::with_capacity(items.len());
        for item in items {
            if let Some(deleted) = &item.tombstone {
                put_deleted(&tx, item, deleted)?;
            }
            if let Some(payload) = &item.minted {
                put_minted(&tx, item, payload)?;
            }
            let change = Change::Record {
                item_type: item.item_type.clone(),
                item_id: item.item_id.clone(),
                op: item.op,
            };
            queued.push(outbox::enqueue(&tx, &change, item.enqueued_at)?.is_some());
        }
        tx.commit().map_err(failed)?;
        Ok(queued)
    }

    /// The first of `types` holding a live (not deleted) record `item_id`.
    pub fn live_record_type(
        &self,
        item_id: &str,
        types: &[&str],
    ) -> Result<Option<String>, StorageError> {
        for item_type in types {
            let live = self
                .data
                .query_row(
                    "SELECT 1 FROM sync_items
                      WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL",
                    [item_type, &item_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(failed)?;
            if live.is_some() {
                return Ok(Some((*item_type).to_owned()));
            }
        }
        Ok(None)
    }

    /// The staged delete clock of `(item_type, item_id)`, which a re-create's first clock absorbs.
    pub fn tombstone_clock(
        &self,
        item_type: &str,
        item_id: &str,
    ) -> Result<Option<VectorClock>, StorageError> {
        crate::sync::store::tombstone_clock(&self.data, item_type, item_id)
    }

    /// `(item_type, item_id, op)` of every staged outbox row, for stage check 4.
    pub fn outbox_rows(&self) -> Result<Vec<(String, String, String)>, StorageError> {
        let mut stmt = self
            .data
            .prepare("SELECT item_type, item_id, op FROM outbox ORDER BY id")
            .map_err(failed)?;
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(failed)?
            .collect::<Result<_, _>>()
            .map_err(failed)
    }

    /// Whether the staged note `id` is local-only, so the outbox withholds its pushes.
    pub fn is_local_only_note(&self, id: &str) -> Result<bool, StorageError> {
        crate::domain::note_files::is_local_only(&self.data, id)
    }
}

/// Writes the minted payload over the live record, its clock into the `clock` column, and
/// projects it again, so the typed tables carry the clock too. A minted record is a local create:
/// it projects at its enqueue time, as a never-synced import record projects at the import time.
/// A payload the type's reader refuses, or no live record, fails the call: a create is never
/// queued for a record the core push would retire.
fn put_minted(tx: &Connection, item: &ImportQueued, payload: &str) -> Result<(), StorageError> {
    let refused = |what: String| StorageError::Failed {
        what: format!("import record {}/{} {what}", item.item_type, item.item_id),
    };
    let parsed =
        StoredPayload::parse(payload).map_err(|e| refused(format!("is unreadable: {e}")))?;
    let view = projectors::read(&item.item_type, parsed.object())
        .map_err(|e| refused(format!("is unreadable: {e}")))?;
    let Some(clock) = projectors::clock_text(&view) else {
        return Err(refused("has no minted clock".into()));
    };
    let updated = tx
        .execute(
            "UPDATE sync_items SET payload = ?3, clock = ?4
              WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL",
            params![item.item_type, item.item_id, payload, clock],
        )
        .map_err(failed)?;
    if updated != 1 {
        return Err(refused("has no live record to mint a clock on".into()));
    }
    projectors::project(
        tx,
        &item.item_type,
        ItemContext {
            item_id: &item.item_id,
            synced_at: item.enqueued_at,
            deleted_at: None,
        },
        &view,
    )
}

/// The tombstone a core delete pushes from: the frozen delete body, its clock and `deleted_at`.
/// A staged row of the id becomes it, and its projection is marked deleted.
fn put_deleted(
    tx: &Connection,
    item: &ImportQueued,
    deleted: &ImportDeleted,
) -> Result<(), StorageError> {
    let clock = serde_json::to_string(&deleted.clock).map_err(|error| StorageError::Failed {
        what: format!("tombstone clock will not serialise: {error}"),
    })?;
    tx.execute(
        "INSERT INTO sync_items (
             item_type, item_id, payload, payload_state, clock, updated_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT (item_type, item_id) DO UPDATE SET
             payload = excluded.payload, payload_state = excluded.payload_state,
             clock = excluded.clock, field_clocks = NULL,
             updated_at = excluded.updated_at, deleted_at = excluded.deleted_at",
        params![
            item.item_type,
            item.item_id,
            deleted.payload,
            PAYLOAD_STATE_FULL,
            clock,
            deleted.deleted_at,
        ],
    )
    .map_err(failed)?;
    projectors::delete(tx, &item.item_type, &item.item_id, deleted.deleted_at)
}
