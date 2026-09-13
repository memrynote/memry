//! The `sync_items` repository: the one table FR-033 is about
//! (chapter 13 §13.2, data-model §A.1, §A.2).
//!
//! Every write path here obeys the same five rules, and they are quoted rather
//! than paraphrased because desktop breaks four of them today (#2183):
//!
//! 1. persist the decrypted payload bytes **exactly as received**;
//! 2. treat every payload schema as a **reader over a copy**, never as the
//!    storage shape;
//! 3. on a local edit, parse a copy, merge the changed keys into it, serialise
//!    that merged object **with unknown keys intact**, and push the result;
//! 4. **never re-serialise a projection row as the payload**;
//! 5. record a payload that fails its schema as **corrupt or unapplied**,
//!    rather than skipping it and advancing the cursor.
//!
//! Rule 5 is why [`apply_remote`] writes the row even when the read fails: the
//! bytes are kept, the reason is recorded against the row, and a later build
//! that models the offending field rebuilds the projection from them. Skipping
//! the item instead — which is what desktop does at
//! `apply-item.ts:96-109` — loses the edit on every device in the vault, with
//! the cursor already past it.
//!
//! [`push_payload`] is chapter 06 §6.5.2's P2: **a queued push is rebuilt from
//! the live row at send time.** An outbox that froze the payload at enqueue
//! reintroduces the §6.5.1 case-3c divergence *deterministically*, not as a
//! race, so the outbox stores the `(type, id)` key and this function supplies
//! the bytes.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::api::errors::StorageError;

use super::payload::{Change, StoredPayload};
use super::projectors::{self, ItemContext, failed};
use super::schema::{Object, ProjectionError};

/// Metadata arrived, the body has not. The windowed first sync fills these in
/// newest first.
pub const PAYLOAD_STATE_METADATA_ONLY: &str = "metadata-only";
/// The payload is stored.
pub const PAYLOAD_STATE_FULL: &str = "full";

/// A row of `sync_items`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncItemRow {
    pub item_type: String,
    pub item_id: String,
    /// The decrypted payload **exactly as received**, or `None` while the row
    /// is metadata only.
    pub payload: Option<String>,
    pub payload_state: String,
    pub clock: Option<String>,
    pub field_clocks: Option<String>,
    pub server_cursor: Option<i64>,
    pub signer_device_id: Option<String>,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub corrupt_reason: Option<String>,
    pub corrupt_at: Option<i64>,
}

/// A record that arrived on the pull feed, already decrypted and verified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundRecord {
    pub item_type: String,
    pub item_id: String,
    /// The decrypted plaintext as UTF-8. Not a parsed value: what the caller
    /// hands over is the string that gets stored.
    pub payload_json: String,
    pub server_cursor: Option<i64>,
    pub signer_device_id: Option<String>,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

/// What [`apply_remote`] did with an item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// Stored and projected.
    Applied,
    /// Stored, not projected, and flagged. §13.2 rule 5: never a silent skip.
    Corrupt { reason: String },
    /// A `task_activity` row past the 90-day horizon (§13.12). **Not corrupt**:
    /// the row is expired, nothing is written, and the caller still advances
    /// its cursor past it.
    Expired,
}

/// Records that an item exists without its body yet (§A.2).
pub fn upsert_metadata_only(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    updated_at: i64,
    server_cursor: Option<i64>,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO sync_items (
             item_type, item_id, payload, payload_state, server_cursor, updated_at
         ) VALUES (?1, ?2, NULL, ?3, ?4, ?5)
         ON CONFLICT(item_type, item_id) DO UPDATE SET
             server_cursor = excluded.server_cursor,
             updated_at = excluded.updated_at",
        params![
            item_type,
            item_id,
            PAYLOAD_STATE_METADATA_ONLY,
            server_cursor,
            updated_at
        ],
    )
    .map_err(failed)?;
    Ok(())
}

/// Stores an inbound record verbatim and refreshes its projection.
pub fn apply_remote(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<ApplyOutcome, StorageError> {
    let prepared = StoredPayload::parse(&record.payload_json).and_then(|payload| {
        let view = projectors::read(&record.item_type, payload.object())?;
        Ok((payload, view))
    });

    let transaction = conn.unchecked_transaction().map_err(failed)?;
    let outcome = match prepared {
        Err(error) => {
            let reason = error.to_string();
            write_payload(&transaction, record, None, Some(&reason), now_ms)?;
            ApplyOutcome::Corrupt { reason }
        }
        Ok((_, view)) => {
            if record.item_type == "task_activity"
                && projectors::tasks::is_beyond_retention(
                    view.get("createdAt").and_then(Value::as_str),
                    now_ms,
                )
            {
                return Ok(ApplyOutcome::Expired);
            }
            write_payload(&transaction, record, Some(&view), None, now_ms)?;
            projectors::project(
                &transaction,
                &record.item_type,
                ItemContext {
                    item_id: &record.item_id,
                    synced_at: now_ms,
                    deleted_at: record.deleted_at,
                },
                &view,
            )?;
            ApplyOutcome::Applied
        }
    };
    transaction.commit().map_err(failed)?;
    Ok(outcome)
}

/// §13.2 rule 3: a local edit merges into the parsed copy and stores **that**.
///
/// Returns the payload string the push will carry, which is also the string now
/// in the column: there is one set of bytes, and the projection is downstream
/// of it rather than upstream.
pub fn apply_local_edit(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    changes: &[(&str, Change)],
    now_ms: i64,
) -> Result<String, StorageError> {
    let Some(row) = load(conn, item_type, item_id)? else {
        return Err(StorageError::Failed {
            what: format!("no sync item {item_type}/{item_id} to edit"),
        });
    };
    let Some(stored) = row.payload else {
        return Err(StorageError::Failed {
            what: format!("sync item {item_type}/{item_id} has no payload to merge into"),
        });
    };

    let merged = StoredPayload::parse(&stored)
        .map_err(refuse(item_type, item_id))?
        .merge(changes);
    let reparsed = StoredPayload::parse(&merged).map_err(refuse(item_type, item_id))?;
    let view =
        projectors::read(item_type, reparsed.object()).map_err(refuse(item_type, item_id))?;

    let transaction = conn.unchecked_transaction().map_err(failed)?;
    transaction
        .execute(
            "UPDATE sync_items SET
                 payload = ?3,
                 payload_state = ?4,
                 clock = ?5,
                 field_clocks = ?6,
                 updated_at = ?7,
                 corrupt_reason = NULL,
                 corrupt_at = NULL
             WHERE item_type = ?1 AND item_id = ?2",
            params![
                item_type,
                item_id,
                merged,
                PAYLOAD_STATE_FULL,
                projectors::clock_text(&view),
                projectors::field_clocks_text(&view),
                now_ms,
            ],
        )
        .map_err(failed)?;
    projectors::project(
        &transaction,
        item_type,
        ItemContext {
            item_id,
            synced_at: now_ms,
            deleted_at: row.deleted_at,
        },
        &view,
    )?;
    transaction.commit().map_err(failed)?;

    Ok(merged)
}

/// Chapter 06 §6.5.2 P2: the payload a push sends, read from the live row at
/// send time.
pub fn push_payload(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Option<String>, StorageError> {
    conn.query_row(
        "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
        params![item_type, item_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(failed)
    .map(Option::flatten)
}

/// Flags a row without touching its payload (§13.2 rule 5).
pub fn mark_corrupt(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    reason: &str,
    at_ms: i64,
) -> Result<(), StorageError> {
    conn.execute(
        "UPDATE sync_items SET corrupt_reason = ?3, corrupt_at = ?4
         WHERE item_type = ?1 AND item_id = ?2",
        params![item_type, item_id, reason, at_ms],
    )
    .map_err(failed)?;
    Ok(())
}

/// Reads one row.
pub fn load(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Option<SyncItemRow>, StorageError> {
    conn.query_row(
        "SELECT item_type, item_id, payload, payload_state, clock, field_clocks,
                server_cursor, signer_device_id, updated_at, deleted_at,
                corrupt_reason, corrupt_at
         FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
        params![item_type, item_id],
        |row| {
            Ok(SyncItemRow {
                item_type: row.get(0)?,
                item_id: row.get(1)?,
                payload: row.get(2)?,
                payload_state: row.get(3)?,
                clock: row.get(4)?,
                field_clocks: row.get(5)?,
                server_cursor: row.get(6)?,
                signer_device_id: row.get(7)?,
                updated_at: row.get(8)?,
                deleted_at: row.get(9)?,
                corrupt_reason: row.get(10)?,
                corrupt_at: row.get(11)?,
            })
        },
    )
    .optional()
    .map_err(failed)
}

/// Replays every stored payload through its projector (§A.1).
///
/// Dropping the tables of migration `0002` and calling this is a supported
/// recovery, and it is the operation that makes "a projection column is a cache
/// of a parse" true rather than aspirational. Returns how many rows projected.
/// A row that fails its reader is flagged and passed over, not retried.
pub fn rebuild_projections(conn: &Connection, now_ms: i64) -> Result<usize, StorageError> {
    let rows: Vec<(String, String, String, Option<i64>)> = {
        let mut statement = conn
            .prepare(
                "SELECT item_type, item_id, payload, deleted_at FROM sync_items
                 WHERE payload IS NOT NULL",
            )
            .map_err(failed)?;
        let mapped = statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(failed)?;
        mapped.collect::<Result<_, _>>().map_err(failed)?
    };

    let mut projected = 0;
    for (item_type, item_id, stored, deleted_at) in rows {
        let read = StoredPayload::parse(&stored)
            .and_then(|payload| projectors::read(&item_type, payload.object()));
        match read {
            Ok(view) => {
                projectors::project(
                    conn,
                    &item_type,
                    ItemContext {
                        item_id: &item_id,
                        synced_at: now_ms,
                        deleted_at,
                    },
                    &view,
                )?;
                projected += 1;
            }
            Err(error) => mark_corrupt(conn, &item_type, &item_id, &error.to_string(), now_ms)?,
        }
    }
    Ok(projected)
}

/// Writes the payload column and the bookkeeping around it.
fn write_payload(
    conn: &Connection,
    record: &InboundRecord,
    view: Option<&Object>,
    corrupt_reason: Option<&str>,
    now_ms: i64,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO sync_items (
             item_type, item_id, payload, payload_state, clock, field_clocks,
             server_cursor, signer_device_id, updated_at, deleted_at,
             corrupt_reason, corrupt_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(item_type, item_id) DO UPDATE SET
             payload = excluded.payload,
             payload_state = excluded.payload_state,
             clock = excluded.clock,
             field_clocks = excluded.field_clocks,
             server_cursor = excluded.server_cursor,
             signer_device_id = excluded.signer_device_id,
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             corrupt_reason = excluded.corrupt_reason,
             corrupt_at = excluded.corrupt_at",
        params![
            record.item_type,
            record.item_id,
            // Rule 1. The string the caller handed over, not a re-encoding of
            // anything parsed from it.
            record.payload_json,
            PAYLOAD_STATE_FULL,
            view.and_then(projectors::clock_text),
            view.and_then(projectors::field_clocks_text),
            record.server_cursor,
            record.signer_device_id,
            record.updated_at,
            record.deleted_at,
            corrupt_reason,
            corrupt_reason.map(|_| now_ms),
        ],
    )
    .map_err(failed)?;
    Ok(())
}

/// A local edit that cannot be read back is a bug in this build, not a remote's
/// problem, so it fails loudly instead of writing an unreadable payload.
fn refuse(item_type: &str, item_id: &str) -> impl FnOnce(ProjectionError) -> StorageError {
    let item_type = item_type.to_owned();
    let item_id = item_id.to_owned();
    move |error| StorageError::Failed {
        what: format!("local edit to {item_type}/{item_id} would not read back: {error}"),
    }
}
