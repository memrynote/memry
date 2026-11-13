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
use crate::crypto::agent_payload::{HELD_REASON, open_object, seal_object};
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
    let Ok(stored) = StoredPayload::parse(&raw) else {
        return Ok(None);
    };
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

/// Seals every agent record a pull stored while no key was installed, in its
/// `sync_items` payload and its projection row, in one transaction, and
/// releases the agent rows a push held back for want of a key. Returns how
/// many records it sealed. Nothing is queued: the opened payload a push sends
/// is the same either way.
pub(crate) fn seal_pending(
    conn: &Connection,
    key: &AtRestKey,
    now_ms: i64,
) -> Result<usize, AgentError> {
    let pending: Vec<(String, String)> = {
        let mut statement = conn
            .prepare(
                "SELECT 'agent_conversation', id FROM agent_conversations WHERE sealed_pending = 1
                 UNION ALL
                 SELECT 'agent_message', id FROM agent_messages WHERE sealed_pending = 1",
            )
            .map_err(failed)?;
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(failed)?
            .collect::<Result<_, _>>()
            .map_err(failed)?
    };
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    let mut sealed = 0;
    for (item_type, item_id) in pending {
        let Some(row) = sync_items::load(&transaction, &item_type, &item_id)? else {
            continue;
        };
        let Some(stored) = row.payload.and_then(|raw| StoredPayload::parse(&raw).ok()) else {
            continue;
        };
        let mut object = stored.object().clone();
        seal_object(&item_type, &mut object, key)?;
        let view = projectors::read(&item_type, &object).map_err(|error| StorageError::Failed {
            what: format!("{item_type} {item_id} no longer reads: {error}"),
        })?;
        transaction
            .execute(
                "UPDATE sync_items SET payload = ?3 WHERE item_type = ?1 AND item_id = ?2",
                params![item_type, item_id, Value::Object(object).to_string()],
            )
            .map_err(failed)?;
        let item = ItemContext {
            item_id: &item_id,
            synced_at: now_ms,
            deleted_at: row.deleted_at,
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
