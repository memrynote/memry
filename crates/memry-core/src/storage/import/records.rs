//! Record rows of the import: one `sync_items` row per Electron record, its payload the one
//! Electron's handler builds for a push, stored verbatim and projected like a pulled record.
//! Clocks come from the payload, so `sync_items.clock` is the Electron clock re-serialised;
//! stage check 5 compares it with the source text.

use rusqlite::{Connection, OptionalExtension, params};

use super::{ImportWriter, failed};
use crate::api::errors::StorageError;
use crate::storage::repositories::StoredPayload;
use crate::storage::repositories::projectors::{self, ItemContext};
use crate::storage::repositories::sync_items::PAYLOAD_STATE_FULL;
use crate::storage::vault_identity;

/// One Electron record as Electron would push it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportRecord {
    pub item_type: &'static str,
    pub item_id: String,
    /// The JSON text of Electron's `buildPushPayload` for the row.
    pub payload: String,
    /// Electron's `synced_at` in epoch ms; `None` for a row never synced or a table without
    /// the column, which projects with the import time as a local create does.
    pub synced_at: Option<i64>,
}

impl ImportWriter {
    /// Writes `records` in one transaction. A payload the type's reader refuses fails the whole
    /// call with the type and id named: a record is never stored corrupt or dropped.
    pub fn put_records(
        &mut self,
        records: &[ImportRecord],
        now_ms: i64,
    ) -> Result<(), StorageError> {
        let tx = self.data.transaction().map_err(failed)?;
        for record in records {
            put(&tx, record, now_ms)?;
        }
        tx.commit().map_err(failed)
    }

    /// `(item_id, clock)` of every staged record of `item_type`, for stage checks 2 and 5.
    pub fn record_clocks(
        &self,
        item_type: &str,
    ) -> Result<Vec<(String, Option<String>)>, StorageError> {
        let mut stmt = self
            .data
            .prepare("SELECT item_id, clock FROM sync_items WHERE item_type = ?1 ORDER BY item_id")
            .map_err(failed)?;
        stmt.query_map([item_type], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(failed)?
            .collect::<Result<_, _>>()
            .map_err(failed)
    }

    /// The staged payload of one record, for the `sync_unknown_fields` importer.
    pub fn record_payload(
        &self,
        item_type: &str,
        item_id: &str,
    ) -> Result<Option<String>, StorageError> {
        self.data
            .query_row(
                "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                [item_type, item_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(failed)
    }

    /// Stores Electron's `vault_metadata` uuid as the core vault id ([`vault_identity`]).
    pub fn put_vault_id(&mut self, id: &str) -> Result<(), StorageError> {
        vault_identity::write_imported(&self.data, id)
    }

    /// The staged core vault id, for stage check 5.
    pub fn vault_id(&self) -> Result<Option<String>, StorageError> {
        vault_identity::read(&self.data)
    }
}

fn put(tx: &Connection, record: &ImportRecord, now_ms: i64) -> Result<(), StorageError> {
    let refused = |error: crate::storage::repositories::ProjectionError| StorageError::Failed {
        what: format!(
            "import record {}/{} is unreadable: {error}",
            record.item_type, record.item_id
        ),
    };
    let parsed = StoredPayload::parse(&record.payload).map_err(refused)?;
    let view = projectors::read(record.item_type, parsed.object()).map_err(refused)?;
    tx.execute(
        "INSERT INTO sync_items (
             item_type, item_id, payload, payload_state, clock, field_clocks, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            record.item_type,
            record.item_id,
            record.payload,
            PAYLOAD_STATE_FULL,
            projectors::clock_text(&view),
            projectors::field_clocks_text(&view),
            now_ms,
        ],
    )
    .map_err(failed)?;
    projectors::project(
        tx,
        record.item_type,
        ItemContext {
            item_id: &record.item_id,
            synced_at: record.synced_at.unwrap_or(now_ms),
            deleted_at: None,
        },
        &view,
    )
}
