//! What `agent_conversation` and `agent_message` share (Step 16, #3533): the
//! error their writes return, reading a record with its sealed keys opened,
//! sealing an inbound record before it is stored, and sealing the records a
//! pull stored while no vault key was installed.
//!
//! The sealed keys are [`crate::crypto::agent_payload`]'s. Every write seals
//! before its transaction opens, so no plaintext of those keys is written to
//! `sync_items`, `outbox` or a projection column while a key is installed.

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::crypto::agent_envelope::{AtRestKey, SealError};
use crate::crypto::agent_payload::{HELD_REASON, open_object, seal_object, seal_unsealed};
use crate::domain::notes::failed;
use crate::storage::repositories::StoredPayload;
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
    /// A sealed key did not open: another key, or altered bytes.
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

/// The payload of a live `(item_type, item_id)` with its sealed keys opened,
/// or `None` when there is no live record.
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
    open_object(item_type, &mut object, key)?;
    Ok(Some(object))
}

/// `record` with its sealed keys sealed, when a key is installed. Without one
/// the record is returned as it came, and it projects as `sealed_pending`
/// until [`seal_pending`] runs. A payload that is not a JSON object is an
/// error, so the apply records it corrupt without storing its bytes.
pub(crate) fn seal_inbound(
    record: &InboundRecord,
    key: &AtRestKey,
) -> Result<InboundRecord, StorageError> {
    let mut object = parse_object(record)?;
    match seal_object(&record.item_type, &mut object, key) {
        Ok(()) => Ok(InboundRecord {
            payload_json: Value::Object(object).to_string(),
            ..record.clone()
        }),
        Err(SealError::KeyUnavailable) => Ok(record.clone()),
        Err(error) => Err(StorageError::Failed {
            what: format!("{} will not seal: {error}", record.item_type),
        }),
    }
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

/// Seals every stored agent record whose sealed keys do not open under `key`
/// (a record a pull stored while no key was installed), in its `sync_items`
/// payload and its projection row, in one transaction, and releases the agent
/// rows a push held back for want of a key. Returns how many records it
/// sealed. Nothing is queued: the opened payload a push sends is the same
/// either way.
///
/// It reads every agent row rather than the projection's `sealed_pending`
/// flag, because that flag is a guess from shape (a plain title can look like
/// an envelope). A row that will not seal or read is flagged corrupt and the
/// others still seal. `secure_delete` is on for the transaction and the WAL is
/// truncated after it, so the plain cells it replaces leave the file.
pub(crate) fn seal_pending(
    conn: &Connection,
    key: &AtRestKey,
    now_ms: i64,
) -> Result<usize, AgentError> {
    let previous: i64 = conn
        .query_row("PRAGMA secure_delete", [], |row| row.get(0))
        .map_err(failed)?;
    conn.execute_batch("PRAGMA secure_delete = ON")
        .map_err(failed)?;
    let sealed = seal_rows(conn, key, now_ms);
    conn.execute_batch(&format!("PRAGMA secure_delete = {previous}"))
        .map_err(failed)?;
    let sealed = sealed?;
    if sealed > 0 {
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .map_err(failed)?;
    }
    Ok(sealed)
}

fn seal_rows(conn: &Connection, key: &AtRestKey, now_ms: i64) -> Result<usize, AgentError> {
    let rows: Vec<(String, String, String, Option<i64>)> = {
        let mut statement = conn
            .prepare(
                "SELECT item_type, item_id, payload, deleted_at FROM sync_items
                 WHERE item_type IN ('agent_conversation', 'agent_message')
                   AND payload IS NOT NULL",
            )
            .map_err(failed)?;
        statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(failed)?
            .collect::<Result<_, _>>()
            .map_err(failed)?
    };
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    let mut sealed = 0;
    for (item_type, item_id, raw, deleted_at) in rows {
        let (object, view) = match seal_row(&item_type, &raw, key) {
            Ok(Some(sealed_row)) => sealed_row,
            Ok(None) => continue,
            Err(reason) => {
                sync_items::mark_corrupt(&transaction, &item_type, &item_id, &reason, now_ms)?;
                continue;
            }
        };
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
    // A push that found these rows sealed and no key held them back off
    // (`sync::push`); with the key installed they can go on the next pass.
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

/// One stored row sealed and read for its projection, `None` when it has
/// nothing to seal, or why it cannot be sealed.
fn seal_row(
    item_type: &str,
    raw: &str,
    key: &AtRestKey,
) -> Result<Option<(Object, Object)>, String> {
    let mut object = StoredPayload::parse(raw)
        .map_err(|error| format!("{item_type} payload does not parse: {error}"))?
        .object()
        .clone();
    if !seal_unsealed(item_type, &mut object, key)
        .map_err(|error| format!("{item_type} will not seal: {error}"))?
    {
        return Ok(None);
    }
    let view = projectors::read(item_type, &object)
        .map_err(|error| format!("{item_type} no longer reads: {error}"))?;
    Ok(Some((object, view)))
}
