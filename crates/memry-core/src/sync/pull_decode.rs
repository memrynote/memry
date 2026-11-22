//! Per-item decoding of pulled records (chapter 05 §5.12, §5.14), split out of
//! [`super::pull`] so the loop stays under the line ceiling.
//!
//! Opening a record is an Ed25519 verify, two AEAD decrypts and an inflate. A
//! page's worth runs on the blocking pool ([`Decoder::decode_all`]), never on
//! the async runtime's worker threads (#5231).

use std::sync::Arc;

use serde_json::Value as Json;

use crate::api::errors::StorageError;
use crate::protocol::envelope::{self, SyncOperation};
use crate::protocol::types::{ArrivingItemType, Declaration};
use crate::storage::repositories::sync_items::InboundRecord;

use super::apply::{DOCUMENT_TYPES, Pending};
use super::pull::RecordCipher;

/// One pulled item: pending, or the reason it is one corrupt item.
pub(super) type Decoded = (Json, Result<Pending, String>);

/// A chunk being decoded by [`Decoder::spawn`].
pub(super) struct Decoding(tokio::task::JoinHandle<Vec<Decoded>>);

impl Decoding {
    pub(super) async fn finish(self) -> Result<Vec<Decoded>, StorageError> {
        self.0.await.map_err(|error| StorageError::Failed {
            what: format!("record decode task did not finish: {error}"),
        })
    }
}

pub(super) struct Decoder {
    pub(super) declaration: Declaration,
    pub(super) cipher: Arc<dyn RecordCipher>,
}

impl Decoder {
    /// Starts decoding `items` on the blocking pool at once, so the next
    /// chunk's request overlaps this one's crypto. [`Decoding::finish`]
    /// answers them in arrival order, each beside its raw item so a corrupt
    /// one can still be recorded against its row.
    pub(super) fn spawn(self: &Arc<Self>, items: Vec<Json>) -> Decoding {
        let decoder = Arc::clone(self);
        Decoding(tokio::task::spawn_blocking(move || {
            items
                .into_iter()
                .map(|item| {
                    let decoded = decoder.decode(&item);
                    (item, decoded)
                })
                .collect()
        }))
    }

    /// Per-item validation. Every `Err` here is **one** corrupt item.
    fn decode(&self, item: &Json) -> Result<Pending, String> {
        let envelope =
            envelope::from_json(item).map_err(|error| format!("malformed envelope: {error}"))?;

        // §5.3.1: a type this client did not declare is recorded, not applied.
        // The record feed cannot produce it today; the rule is defensive.
        if self.declaration.classify(&envelope.item_type) == ArrivingItemType::Undeclared {
            return Err(format!("undeclared item type `{}`", envelope.item_type));
        }

        // §5.14: every item opens before it applies, a delete included. The
        // server is untrusted, so a delete it could forge (no signature, a signer
        // with no key, a signature over other bytes) is one corrupt item and
        // deletes nothing, as Electron's `decryptPullBatch` refuses it
        // (`apps/desktop/src/main/sync/decrypt.ts:79`).
        let plaintext = self
            .cipher
            .open(&envelope)
            .map_err(|error| format!("could not open the record: {error}"))?;

        // §5.12: a present `deletedAt` overrides the declared operation, and
        // the body is never applied, only read for `bodyStateVector` (§5.8).
        let deleted_at = envelope
            .deleted_at
            .or_else(|| (envelope.operation == SyncOperation::Delete).then(now_ms));
        if let Some(deleted_at) = deleted_at {
            return Ok(Pending::Tombstone {
                body_state_vector: tombstone_body_state_vector(&envelope.item_type, &plaintext),
                item_type: envelope.item_type.clone(),
                item_id: envelope.id.clone(),
                deleted_at,
                server_cursor: server_cursor(item),
                clock: envelope.clock.clone(),
            });
        }

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
}

/// A note or journal tombstone's `bodyStateVector` (§5.8, #3037). `None`
/// for other types and for a payload without one (an older build's delete
/// seals an empty payload): the keep rule then decides as before.
fn tombstone_body_state_vector(item_type: &str, plaintext: &[u8]) -> Option<String> {
    if !DOCUMENT_TYPES.contains(&item_type) {
        return None;
    }
    let payload: Json = serde_json::from_slice(plaintext).ok()?;
    payload
        .get("bodyStateVector")
        .and_then(Json::as_str)
        .map(str::to_owned)
}

pub(super) fn server_cursor(item: &Json) -> Option<i64> {
    item.get("serverCursor").and_then(Json::as_i64)
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}
