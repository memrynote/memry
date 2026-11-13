//! Per-item validation of one pulled envelope (chapter 05 §5.12, §5.14),
//! split out of [`super::pull`] to keep it under the line ceiling.

use serde_json::Value as Json;

use crate::protocol::envelope::{self, RecordEnvelope, SyncOperation};
use crate::protocol::types::{ArrivingItemType, Declaration};
use crate::storage::repositories::sync_items::InboundRecord;

use super::apply::{DOCUMENT_TYPES, Pending};
use super::pull::{RecordCipher, now_ms};

/// Per-item validation. Every `Err` here is **one** corrupt item.
pub(super) fn decode(
    declaration: &Declaration,
    cipher: &dyn RecordCipher,
    item: &Json,
) -> Result<Pending, String> {
    let envelope =
        envelope::from_json(item).map_err(|error| format!("malformed envelope: {error}"))?;

    // §5.3.1: a type this client did not declare is recorded, not applied.
    // The record feed cannot produce it today; the rule is defensive.
    if declaration.classify(&envelope.item_type) == ArrivingItemType::Undeclared {
        return Err(format!("undeclared item type `{}`", envelope.item_type));
    }

    // §5.12: a present `deletedAt` overrides the declared operation, and
    // the body is never applied, only read for `bodyStateVector` (§5.8).
    let deleted_at = envelope
        .deleted_at
        .or_else(|| (envelope.operation == SyncOperation::Delete).then(now_ms));
    if let Some(deleted_at) = deleted_at {
        return Ok(Pending::Tombstone {
            body_state_vector: tombstone_body_state_vector(cipher, &envelope),
            item_type: envelope.item_type.clone(),
            item_id: envelope.id.clone(),
            deleted_at,
            server_cursor: server_cursor(item),
            clock: envelope.clock.clone(),
        });
    }

    let plaintext = cipher
        .open(&envelope)
        .map_err(|error| format!("could not open the record: {error}"))?;
    let payload_json = String::from_utf8(plaintext)
        .map_err(|_| "the decrypted payload is not UTF-8".to_owned())?;

    Ok(Pending::Record(InboundRecord {
        item_type: envelope.item_type,
        item_id: envelope.id,
        payload_json,
        server_cursor: server_cursor(item),
        signer_device_id: Some(envelope.signer_device_id),
        updated_at: now_ms(),
        deleted_at: None,
    }))
}

/// A note or journal tombstone's `bodyStateVector` (§5.8, #3037). `None`
/// for other types and for a payload that does not open (an old build's
/// delete, a shed marker): the keep rule then decides as before.
fn tombstone_body_state_vector(
    cipher: &dyn RecordCipher,
    envelope: &RecordEnvelope,
) -> Option<String> {
    if !DOCUMENT_TYPES.contains(&envelope.item_type.as_str()) {
        return None;
    }
    let plaintext = cipher.open(envelope).ok()?;
    let payload: Json = serde_json::from_slice(&plaintext).ok()?;
    payload
        .get("bodyStateVector")
        .and_then(Json::as_str)
        .map(str::to_owned)
}

pub(super) fn server_cursor(item: &Json) -> Option<i64> {
    item.get("serverCursor").and_then(Json::as_i64)
}
