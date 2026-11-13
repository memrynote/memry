//! What `agent_conversation` and `agent_message` share (Step 16, #3533): the
//! error their writes return, reading a record with its sealed keys opened,
//! storing an inbound record sealed, and sealing the records a pull stored
//! while no vault key was installed.
//!
//! The sealed keys are [`crate::crypto::agent_payload`]'s. With a key
//! installed every write seals before its transaction opens, so no plaintext
//! of those keys is written to `sync_items`, `outbox` or a projection column.
//! With none, an inbound record is stored as received and marked
//! sealed-pending in the same transaction ([`set_sealed_pending`]). That mark,
//! never a value's shape, tells a plain value from a sealed one.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::crypto::agent_envelope::{AtRestKey, SealError};
use crate::crypto::agent_payload::{HELD_REASON, open_object, seal_object};
use crate::domain::notes::failed;
use crate::domain::task_merge;
use crate::domain::tasks::Inbound;
use crate::storage::repositories::StoredPayload;
use crate::storage::repositories::projectors::agent::{is_sealed_pending, set_sealed_pending};
use crate::storage::repositories::projectors::{self, ItemContext};
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items::{self, InboundRecord};

/// Why an agent read or write failed.
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    /// No vault key is installed (`Vault::set_at_rest_key`), so nothing can be
    /// sealed or a sealed key opened.
    #[error("the agent store needs the vault key, and none is installed")]
    SealerUnavailable,
    /// A sealed key did not open under the installed key: sealed under
    /// another key, an envelope version this build does not read, altered
    /// bytes, or a value that is not an envelope at all.
    #[error(transparent)]
    Envelope(SealError),
    #[error(transparent)]
    Storage(#[from] StorageError),
}

impl From<SealError> for AgentError {
    fn from(error: SealError) -> Self {
        match error {
            SealError::KeyUnavailable => Self::SealerUnavailable,
            other => Self::Envelope(other),
        }
    }
}

/// The payload of a live `(item_type, item_id)` with its sealed keys opened
/// (as stored when it is sealed-pending), or `None` when there is no live
/// record.
pub(crate) fn opened(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    key: &AtRestKey,
) -> Result<Option<Object>, AgentError> {
    let Some(row) = sync_items::load(conn, item_type, item_id)? else {
        return Ok(None);
    };
    let Some(raw) = row.payload.filter(|_| row.deleted_at.is_none()) else {
        return Ok(None);
    };
    let stored = StoredPayload::parse(&raw).map_err(|error| StorageError::Failed {
        what: format!("{item_type} {item_id} payload does not parse: {error}"),
    })?;
    let mut object = stored.object().clone();
    if !is_sealed_pending(conn, item_type, item_id)? {
        open_object(item_type, &mut object, key)?;
    }
    Ok(Some(object))
}

/// Stores an inbound agent record wholesale (§6.3.1's apply branch) with its
/// sealed keys sealed under the installed key. With no key installed the
/// payload is stored as received and marked sealed-pending in the same
/// transaction, so [`seal_pending`] seals it once a key arrives. A payload
/// that is not a JSON object is an error, so the apply records it corrupt
/// without storing its bytes.
pub(crate) fn store_inbound(
    conn: &Connection,
    record: &InboundRecord,
    key: &AtRestKey,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    let mut object = parse_object(record)?;
    let (stored, pending) = match seal_object(&record.item_type, &mut object, key) {
        Ok(()) => {
            let payload_json = Value::Object(object).to_string();
            let sealed = InboundRecord {
                payload_json,
                ..record.clone()
            };
            (sealed, false)
        }
        Err(SealError::KeyUnavailable) => (record.clone(), true),
        Err(error) => {
            return Err(StorageError::Failed {
                what: format!("{} will not seal: {error}", record.item_type),
            });
        }
    };
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    set_sealed_pending(&transaction, &record.item_type, &record.item_id, pending)?;
    let outcome = sync_items::apply_remote_in(&transaction, &stored, now_ms)?;
    transaction.commit().map_err(failed)?;
    Ok(task_merge::inbound(outcome))
}

/// The inbound payload as an object, or the error that refuses it.
pub(crate) fn parse_object(record: &InboundRecord) -> Result<Object, StorageError> {
    StoredPayload::parse(&record.payload_json)
        .map(|payload| payload.object().clone())
        .map_err(|error| StorageError::Failed {
            what: format!("{} payload is not an object: {error}", record.item_type),
        })
}

/// Whether Electron's schema refuses an inbound agent payload: a value of the
/// wrong type for its key, or `null` for a key in `not_null` (a key the schema
/// does not mark `.nullable()`). The merge skips such a remote before the
/// clock gate and writes nothing, as the other desktop-only types do (chapter
/// 13 §13.2.3): storing it would put an unsealed payload in `sync_items` and
/// let a malformed remote replace a good local record.
pub(crate) fn refuses(item_type: &str, remote: &Object, not_null: &[&str]) -> bool {
    not_null
        .iter()
        .any(|key| remote.get(*key).is_some_and(Value::is_null))
        || projectors::read(item_type, remote).is_err()
}

/// Refuses a vault key whose verifier (`candidate`) does not match the one
/// stored in `meta.vault.crypto.verifier.v1` (chapter 01 §1.4.2). A vault
/// with no stored verifier accepts any key.
pub(crate) fn check_verifier(conn: &Connection, candidate: &str) -> Result<(), StorageError> {
    let stored = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'vault.crypto.verifier.v1'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| StorageError::Failed {
            what: format!("the vault key verifier will not read: {error}"),
        })?;
    if stored.is_some_and(|stored| {
        !crate::crypto::sodium::memcmp(stored.as_bytes(), candidate.as_bytes())
    }) {
        return Err(StorageError::Invalid {
            what: "the vault key does not match this vault's key verifier".to_owned(),
        });
    }
    Ok(())
}

/// What installing a vault key did to the stored agent records.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Sealed {
    /// How many sealed-pending records it sealed.
    pub records: usize,
    /// A reader kept the WAL from being truncated after the seal, so
    /// `data.db-wal` may still hold the plain pages the seal replaced until a
    /// later checkpoint overwrites them. The shell logs it.
    pub wal_kept: bool,
}

/// Seals every sealed-pending agent record (one a pull stored while no key
/// was installed) under `key`, in its `sync_items` payload and its projection
/// row, in one transaction, and releases the agent rows a push held back.
/// Nothing is queued: the payload a push sends is the same either way.
///
/// It visits only the marked records and seals their sealed keys
/// unconditionally: they were stored plain. A record already flagged corrupt
/// is passed over and stays sealed-pending, since its payload may not read; a
/// later write that replaces it decides again. A record that will not seal or
/// read is flagged corrupt, stays sealed-pending, and the others still seal.
/// With nothing marked and nothing held it opens no write transaction.
///
/// `secure_delete` is on for the transaction, so SQLite zeroes the cells the
/// seal frees, and the WAL is truncated after it ([`Sealed::wal_kept`] when a
/// reader prevents that). Neither reaches copies SQLite made earlier, while
/// `secure_delete` was off: a page split or an earlier free can leave the
/// plain bytes on a freelist page until it is reused or the file is vacuumed.
pub(crate) fn seal_pending(
    conn: &Connection,
    key: &AtRestKey,
    now_ms: i64,
) -> Result<Sealed, AgentError> {
    let rows = pending_rows(conn)?;
    let held: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM outbox
             WHERE item_type IN ('agent_conversation', 'agent_message')
               AND last_error LIKE ?1 || '%')",
            params![HELD_REASON],
            |row| row.get(0),
        )
        .map_err(failed)?;
    if rows.is_empty() && !held {
        return Ok(Sealed::default());
    }
    let previous: i64 = conn
        .query_row("PRAGMA secure_delete", [], |row| row.get(0))
        .map_err(failed)?;
    conn.execute_batch("PRAGMA secure_delete = ON")
        .map_err(failed)?;
    let records = seal_rows(conn, rows, key, now_ms);
    let restore = match previous {
        0 => "OFF",
        2 => "FAST",
        _ => "ON",
    };
    conn.execute_batch(&format!("PRAGMA secure_delete = {restore}"))
        .map_err(failed)?;
    let records = records?;
    let wal_kept = records > 0 && !truncate_wal(conn)?;
    Ok(Sealed { records, wal_kept })
}

/// `(item_type, item_id, payload, deleted_at)` of a sealed-pending record.
type PendingRow = (String, String, String, Option<i64>);

/// The sealed-pending records with a payload and no corrupt flag.
fn pending_rows(conn: &Connection) -> Result<Vec<PendingRow>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT s.item_type, s.item_id, s.payload, s.deleted_at
             FROM agent_sealed_pending p
             JOIN sync_items s ON s.item_type = p.item_type AND s.item_id = p.item_id
             WHERE s.payload IS NOT NULL AND s.corrupt_reason IS NULL",
        )
        .map_err(failed)?;
    statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

fn seal_rows(
    conn: &Connection,
    rows: Vec<PendingRow>,
    key: &AtRestKey,
    now_ms: i64,
) -> Result<usize, AgentError> {
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    let mut sealed = 0;
    for (item_type, item_id, raw, deleted_at) in rows {
        let (object, view) = match seal_row(&item_type, &raw, key) {
            Ok(sealed_row) => sealed_row,
            Err(reason) => {
                sync_items::mark_corrupt(&transaction, &item_type, &item_id, &reason, now_ms)?;
                continue;
            }
        };
        set_sealed_pending(&transaction, &item_type, &item_id, false)?;
        transaction
            .execute(
                "UPDATE sync_items SET payload = ?3 WHERE item_type = ?1 AND item_id = ?2",
                params![item_type, item_id, Value::Object(object).to_string()],
            )
            .map_err(failed)?;
        let item = ItemContext {
            item_id: &item_id,
            synced_at: now_ms,
            deleted_at,
        };
        projectors::project(&transaction, &item_type, item, &view)?;
        sealed += 1;
    }
    // A push that could not open these rows held them back off
    // (`sync::push`); with a key installed they can go on the next pass.
    transaction
        .execute(
            "UPDATE outbox SET next_attempt_at = NULL
             WHERE item_type IN ('agent_conversation', 'agent_message')
               AND last_error LIKE ?1 || '%'",
            params![HELD_REASON],
        )
        .map_err(failed)?;
    transaction.commit().map_err(failed)?;
    Ok(sealed)
}

/// One sealed-pending row sealed and read for its projection, or why it
/// cannot be.
fn seal_row(item_type: &str, raw: &str, key: &AtRestKey) -> Result<(Object, Object), String> {
    let mut object = StoredPayload::parse(raw)
        .map_err(|error| format!("{item_type} payload does not parse: {error}"))?
        .object()
        .clone();
    seal_object(item_type, &mut object, key)
        .map_err(|error| format!("{item_type} will not seal: {error}"))?;
    let view = projectors::read(item_type, &object)
        .map_err(|error| format!("{item_type} no longer reads: {error}"))?;
    Ok((object, view))
}

/// `PRAGMA wal_checkpoint(TRUNCATE)`, and whether it truncated. The
/// connection's busy handler retries while a reader holds the WAL
/// (`busy_timeout`, `storage::pragmas`); the pragma's first column is 1 when
/// it still could not finish.
fn truncate_wal(conn: &Connection) -> Result<bool, StorageError> {
    let busy: i64 = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
        .map_err(failed)?;
    Ok(busy == 0)
}

#[cfg(test)]
#[path = "agent_records_tests.rs"]
mod tests;
