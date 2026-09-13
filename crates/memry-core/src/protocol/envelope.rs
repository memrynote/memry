//! The record envelope, chapter 04.
//!
//! A JSON object with base64 fields, signed over canonical CBOR. The order of
//! operations is fixed in both directions and a client that reorders them is
//! not a conforming client:
//!
//! - **write** (§4.2): compress, wrap a fresh file key under the vault key,
//!   encrypt the frame under the file key, base64 everything, sign the base64
//!   **strings**;
//! - **read** (§4.12): verify the signature, unwrap the file key, decrypt,
//!   decompress, zero the file key.
//!
//! Three facts carry the module and each is the opposite of the reasonable
//! guess:
//!
//! 1. **The signed values are the base64 strings, not the ciphertext bytes**
//!    (§4.8), which is why a flipped ciphertext byte fails as a *signature*
//!    error rather than as an AEAD error.
//! 2. **`cryptoVersion` is signed as the literal `1` and is not a wire field**
//!    (§4.10). The server reconstructs the payload with its own constant, so
//!    there is nothing for a client to declare and nothing to echo back.
//! 3. **An absent key must be absent, never present-with-null** (§4.6). A
//!    canonical CBOR map with a key whose value is an empty map is a different
//!    byte string from the same map with the key missing, so a `null` here is a
//!    `403` there.
//!
//! The same four blob fields are canonicalised **twice, differently**
//! (chapter 05 §5.9), and both live here: [`canonical_blob_json`] with the
//! plain JSON key sort for the R2 object and its `contentHash`, and
//! [`signing_bytes`] with the length-first CBOR sort for the signature. They
//! produce different orders from the same inputs and a client may assume
//! neither.

use std::collections::BTreeMap;

use ciborium::value::Value;
use serde_json::{Map as JsonMap, Value as Json};
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use zeroize::Zeroizing;

use crate::api::errors::{CborError, CompressError, CryptoError};
use crate::crypto::{cbor, keys, sodium};
use crate::protocol::compress;

/// The literal a conforming client signs, chapter 04 §4.10.
///
/// Not a wire field: `PushItem` has no `cryptoVersion`, so the server signs its
/// own constant and the reconstruction is exact only while both sides are `1`.
pub const CRYPTO_VERSION: u64 = 1;

/// A fresh per-item file key, chapter 04 §4.4.
pub const FILE_KEY_BYTES: usize = 32;
/// The XChaCha20-Poly1305 nonce, chapter 04 §4.3.
pub const NONCE_BYTES: usize = 24;
/// 32-byte file key plus a 16-byte tag, chapter 04 §4.4.
pub const WRAPPED_KEY_BYTES: usize = 48;
/// An Ed25519 detached signature, chapter 04 §4.6.
pub const SIGNATURE_BYTES: usize = 64;

/// The per-item ciphertext ceiling, chapter 04 §4.14.
pub const SYNC_ITEM_MAX_ENCRYPT_BYTES: usize = 5 * 1024 * 1024;
/// The plaintext-to-ciphertext estimate the ceiling is applied through.
pub const SYNC_ITEM_ENCRYPT_OVERHEAD: f64 = 1.37;
/// `floor(SYNC_ITEM_MAX_ENCRYPT_BYTES / SYNC_ITEM_ENCRYPT_OVERHEAD)`.
///
/// Spelled as a literal because the division is not const-evaluable; the
/// vector tier asserts it against `record-envelope.json`'s own `sizeCeiling`.
pub const NOTE_SYNC_MAX_BYTES: usize = 3_826_919;
/// The fraction of the ceiling at which a client warns.
pub const NOTE_SYNC_WARN_RATIO: f64 = 0.8;
/// `floor(NOTE_SYNC_MAX_BYTES * NOTE_SYNC_WARN_RATIO)`.
pub const NOTE_SYNC_WARN_BYTES: usize = 3_061_535;

/// Failures of the record envelope, chapter 04.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EnvelopeError {
    /// The payload is over the per-item ceiling (§4.14).
    ///
    /// Raised **before any crypto** and non-retryable, so the batch layers can
    /// tell it from a crypto failure and name the note that stopped syncing.
    #[error("item is {bytes} bytes, over the {max_bytes} byte ceiling")]
    ItemTooLarge { bytes: u64, max_bytes: u64 },

    /// The Ed25519 detached signature did not verify under the signer's key.
    ///
    /// Checked **before** the file key is unwrapped (§4.12), so an item that
    /// fails here is never decrypted.
    #[error("record signature did not verify")]
    SignatureInvalid,

    /// A record arrived routed to a different vault than the one being applied
    /// into (chapter 01 §1.7).
    #[error("record was routed to vault {routed}, not {expected}")]
    VaultMismatch { routed: String, expected: String },

    /// The wire object is not a record envelope.
    #[error("malformed record envelope: {what}")]
    Malformed { what: String },

    #[error("{source}")]
    Crypto {
        #[from]
        source: CryptoError,
    },

    #[error("{source}")]
    Cbor {
        #[from]
        source: CborError,
    },

    #[error("{source}")]
    Compress {
        #[from]
        source: CompressError,
    },
}

/// `SYNC_OPERATIONS`, chapter 00 §0.7.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncOperation {
    Create,
    Update,
    Delete,
}

impl SyncOperation {
    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }

    /// Reads the wire spelling, applying the read side's default.
    ///
    /// Chapter 04 §4.9: **a missing `operation` reads as `update`**, even
    /// though the push schema makes it required and the server uses it
    /// directly. A reader that refuses the absent case cannot verify an item
    /// written by a path that omitted it.
    pub fn from_wire(value: Option<&str>) -> Result<Self, EnvelopeError> {
        match value {
            None | Some("update") => Ok(Self::Update),
            Some("create") => Ok(Self::Create),
            Some("delete") => Ok(Self::Delete),
            Some(other) => Err(EnvelopeError::Malformed {
                what: format!("unknown operation `{other}`"),
            }),
        }
    }
}

/// A signed record envelope: `PushItem`, chapter 04 §4.6.
///
/// `clock`, `state_vector` and `deleted_at` are `Option` because the wire
/// **omits them entirely when absent** and never sends `null`. The distinction
/// is not cosmetic: it changes the signed bytes.
///
/// `cryptoVersion` and `signedAt` are deliberately not modelled. The first is
/// not a wire field (§4.10) and the second is unused (§4.8.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordEnvelope {
    pub id: String,
    pub item_type: String,
    pub operation: SyncOperation,
    pub encrypted_key: String,
    pub key_nonce: String,
    pub encrypted_data: String,
    pub data_nonce: String,
    pub signature: String,
    pub signer_device_id: String,
    pub clock: Option<BTreeMap<String, u64>>,
    pub state_vector: Option<String>,
    /// Epoch milliseconds. Chapter 04 §4.13: a conforming writer MUST NOT sign
    /// a non-integral number, which is why this is an integer type.
    pub deleted_at: Option<i64>,
}

/// The entropy one item consumes, chapter 04 §4.3 and §4.4.
///
/// Separated from the request so a caller can inject it. Production draws
/// [`RecordMaterial::random`]; the vector tier supplies the committed values,
/// because a vector cannot contain a random value and also be reproducible.
pub struct RecordMaterial {
    pub file_key: Zeroizing<Vec<u8>>,
    pub data_nonce: Vec<u8>,
    pub key_nonce: Vec<u8>,
}

impl RecordMaterial {
    /// A fresh file key and two fresh nonces.
    ///
    /// **The nonce is random per operation and is never a counter** (§4.3).
    pub fn random() -> Self {
        Self {
            file_key: Zeroizing::new(sodium::random_bytes(FILE_KEY_BYTES)),
            data_nonce: sodium::random_bytes(NONCE_BYTES),
            key_nonce: sodium::random_bytes(NONCE_BYTES),
        }
    }
}

/// One item to seal.
pub struct RecordRequest<'a> {
    pub id: &'a str,
    pub item_type: &'a str,
    pub operation: SyncOperation,
    /// The plaintext payload: UTF-8 JSON for every record type (chapter 13).
    pub content: &'a [u8],
    pub vault_key: &'a [u8],
    pub signing_secret_key: &'a [u8],
    pub signer_device_id: &'a str,
    pub clock: Option<BTreeMap<String, u64>>,
    pub state_vector: Option<String>,
    pub deleted_at: Option<i64>,
}

/// The sealed envelope and the ciphertext size the size gate is stated in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedRecord {
    pub envelope: RecordEnvelope,
    pub size_bytes: u64,
}

/// The per-item size gate, chapter 04 §4.14.
///
/// Runs before any crypto: the point is to name the note that stopped syncing
/// rather than to report a failure from inside the cipher.
pub fn check_size(content_len: usize) -> Result<(), EnvelopeError> {
    if content_len > NOTE_SYNC_MAX_BYTES {
        return Err(EnvelopeError::ItemTooLarge {
            bytes: content_len as u64,
            max_bytes: NOTE_SYNC_MAX_BYTES as u64,
        });
    }
    Ok(())
}

/// Seals one record, chapter 04 §4.2 through §4.8.
pub fn encrypt(
    request: &RecordRequest<'_>,
    material: &RecordMaterial,
) -> Result<EncryptedRecord, EnvelopeError> {
    check_size(request.content.len())?;

    // Compress then encrypt: the flag byte lives **inside** the ciphertext and
    // there is no envelope-level compression field (§4.2).
    let framed = compress::compress(request.content);
    let wrapped_key = sodium::aead_encrypt(
        &material.file_key,
        None,
        &material.key_nonce,
        request.vault_key,
    )?;
    let ciphertext = sodium::aead_encrypt(
        &framed,
        None,
        &material.data_nonce,
        material.file_key.as_slice(),
    )?;
    let size_bytes = ciphertext.len() as u64;

    let mut envelope = RecordEnvelope {
        id: request.id.to_owned(),
        item_type: request.item_type.to_owned(),
        operation: request.operation,
        encrypted_key: keys::base64_encode(&wrapped_key),
        key_nonce: keys::base64_encode(&material.key_nonce),
        encrypted_data: keys::base64_encode(&ciphertext),
        data_nonce: keys::base64_encode(&material.data_nonce),
        // Filled in below. The signature is not one of the signed fields, so
        // the placeholder cannot reach the bytes being signed.
        signature: String::new(),
        signer_device_id: request.signer_device_id.to_owned(),
        clock: request.clock.clone(),
        state_vector: request.state_vector.clone(),
        deleted_at: request.deleted_at,
    };

    let signature = sodium::sign_detached(&signing_bytes(&envelope)?, request.signing_secret_key)?;
    envelope.signature = keys::base64_encode(&signature);

    Ok(EncryptedRecord {
        envelope,
        size_bytes,
    })
}

/// Opens one record, chapter 04 §4.12.
///
/// Verify, unwrap, decrypt, decompress — in that order, so a forged item is
/// never fed to the cipher and a truncated body is never mistaken for an empty
/// one. The file key is zeroed on drop (§4.4).
///
/// **Success proves nothing about which vault this record belongs to.** Every
/// vault on an account shares one key, so a ciphertext from vault A decrypts
/// cleanly under vault B (chapter 01 §1.7). The caller MUST have checked the
/// routing fact with [`check_vault_association`].
pub fn decrypt(
    envelope: &RecordEnvelope,
    vault_key: &[u8],
    signer_public_key: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    verify(envelope, signer_public_key)?;

    let wrapped_key = keys::base64_decode(&envelope.encrypted_key)?;
    let key_nonce = keys::base64_decode(&envelope.key_nonce)?;
    let file_key = sodium::aead_decrypt(&wrapped_key, None, &key_nonce, vault_key)?;

    let ciphertext = keys::base64_decode(&envelope.encrypted_data)?;
    let data_nonce = keys::base64_decode(&envelope.data_nonce)?;
    let framed = sodium::aead_decrypt(&ciphertext, None, &data_nonce, file_key.as_slice())?;

    Ok(compress::decompress(&framed)?)
}

/// Verifies the detached signature over the canonical CBOR payload (§4.8).
pub fn verify(envelope: &RecordEnvelope, signer_public_key: &[u8]) -> Result<(), EnvelopeError> {
    let signature = keys::base64_decode(&envelope.signature)?;
    if signature.len() != SIGNATURE_BYTES {
        return Err(EnvelopeError::SignatureInvalid);
    }
    let message = signing_bytes(envelope)?;
    if sodium::sign_verify_detached(&signature, &message, signer_public_key) {
        Ok(())
    } else {
        Err(EnvelopeError::SignatureInvalid)
    }
}

/// Vault association, chapter 01 §1.7.
///
/// A separate, explicit check because the obvious one does not exist: decryption
/// failure **cannot** detect a mis-routed record. Association is a routing fact
/// carried outside the ciphertext, in `X-Memry-Vault-Id` and the route
/// parameter, and nowhere in the envelope.
pub fn check_vault_association(
    routed_vault_id: &str,
    expected_vault_id: &str,
) -> Result<(), EnvelopeError> {
    if routed_vault_id == expected_vault_id {
        Ok(())
    } else {
        Err(EnvelopeError::VaultMismatch {
            routed: routed_vault_id.to_owned(),
            expected: expected_vault_id.to_owned(),
        })
    }
}

/// The signature payload v1 field set, chapter 04 §4.8.
///
/// Insertion order here is irrelevant: the encoder sorts length-first (§4.7).
/// What matters is membership — an absent key is absent, not null — and that
/// `metadata` appears only when `clock` or `stateVector` does, carrying only
/// the ones that exist.
///
/// `metadata.fieldClocks` is never set (§4.8.1). The allowlist governs only the
/// top level, so setting it would not be rejected; it would silently change the
/// signed bytes and earn a `403`, because the server reconstructs `metadata`
/// from `clock` and `stateVector` alone.
pub fn signature_payload(envelope: &RecordEnvelope) -> cbor::CanonicalMap {
    let mut payload: cbor::CanonicalMap = vec![
        ("id".to_owned(), Value::Text(envelope.id.clone())),
        ("type".to_owned(), Value::Text(envelope.item_type.clone())),
        (
            "operation".to_owned(),
            Value::Text(envelope.operation.as_str().to_owned()),
        ),
        (
            "cryptoVersion".to_owned(),
            Value::Integer(CRYPTO_VERSION.into()),
        ),
        (
            "encryptedKey".to_owned(),
            Value::Text(envelope.encrypted_key.clone()),
        ),
        (
            "keyNonce".to_owned(),
            Value::Text(envelope.key_nonce.clone()),
        ),
        (
            "encryptedData".to_owned(),
            Value::Text(envelope.encrypted_data.clone()),
        ),
        (
            "dataNonce".to_owned(),
            Value::Text(envelope.data_nonce.clone()),
        ),
    ];

    if let Some(deleted_at) = envelope.deleted_at {
        payload.push(("deletedAt".to_owned(), Value::Integer(deleted_at.into())));
    }

    let mut metadata: Vec<(Value, Value)> = Vec::new();
    if let Some(clock) = &envelope.clock {
        let ticks = clock
            .iter()
            .map(|(device, tick)| (Value::Text(device.clone()), Value::Integer((*tick).into())))
            .collect();
        metadata.push((Value::Text("clock".to_owned()), Value::Map(ticks)));
    }
    if let Some(state_vector) = &envelope.state_vector {
        metadata.push((
            Value::Text("stateVector".to_owned()),
            Value::Text(state_vector.clone()),
        ));
    }
    if !metadata.is_empty() {
        payload.push(("metadata".to_owned(), Value::Map(metadata)));
    }

    payload
}

/// The exact bytes the Ed25519 signature covers, chapter 04 §4.7 and §4.8.
///
/// Canonical CBOR under the `SYNC_ITEM` allowlist. The allowlist decides
/// membership; the **byte order** is RFC 8949 §4.2.3, length-first, applied
/// recursively by the encoder, which is why `clock` precedes `stateVector` and
/// why the encoded order is not the list order.
pub fn signing_bytes(envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
    Ok(cbor::encode(
        cbor::field_order::SYNC_ITEM,
        &signature_payload(envelope),
    )?)
}

/// The general `PushItem` shape, chapter 04 §4.6.
///
/// Absent fields are **omitted**, never `null`.
pub fn to_json(envelope: &RecordEnvelope) -> Json {
    let mut item = JsonMap::new();
    item.insert("id".to_owned(), Json::String(envelope.id.clone()));
    item.insert("type".to_owned(), Json::String(envelope.item_type.clone()));
    item.insert(
        "operation".to_owned(),
        Json::String(envelope.operation.as_str().to_owned()),
    );
    item.insert(
        "encryptedKey".to_owned(),
        Json::String(envelope.encrypted_key.clone()),
    );
    item.insert(
        "keyNonce".to_owned(),
        Json::String(envelope.key_nonce.clone()),
    );
    item.insert(
        "encryptedData".to_owned(),
        Json::String(envelope.encrypted_data.clone()),
    );
    item.insert(
        "dataNonce".to_owned(),
        Json::String(envelope.data_nonce.clone()),
    );
    item.insert(
        "signature".to_owned(),
        Json::String(envelope.signature.clone()),
    );
    item.insert(
        "signerDeviceId".to_owned(),
        Json::String(envelope.signer_device_id.clone()),
    );
    if let Some(clock) = &envelope.clock {
        let ticks: JsonMap<String, Json> = clock
            .iter()
            .map(|(device, tick)| (device.clone(), Json::from(*tick)))
            .collect();
        item.insert("clock".to_owned(), Json::Object(ticks));
    }
    if let Some(state_vector) = &envelope.state_vector {
        item.insert("stateVector".to_owned(), Json::String(state_vector.clone()));
    }
    if let Some(deleted_at) = envelope.deleted_at {
        item.insert("deletedAt".to_owned(), Json::from(deleted_at));
    }
    Json::Object(item)
}

/// The `POST /sync/push` body for one record, chapter 04 §4.6.
///
/// [`to_json`] minus `stateVector`: `RecordPushItemSchema` omits the field
/// entirely, so a conforming client MUST NOT send it on a record push even
/// though it exists on the general shape and inside the signature payload.
pub fn to_record_push_json(envelope: &RecordEnvelope) -> Json {
    let mut item = to_json(envelope);
    if let Some(fields) = item.as_object_mut() {
        fields.remove("stateVector");
    }
    item
}

/// Reads a wire envelope, chapter 04 §4.6 and §4.9.
///
/// Unknown keys are ignored rather than rejected: `cryptoVersion` and
/// `signedAt` both appear on read paths and neither is signed (§4.8.2, §4.10),
/// and chapter 13 §13.2.2 permits ignoring envelope keys a client does not
/// know. It never relaxes the same rule for payload keys.
pub fn from_json(value: &Json) -> Result<RecordEnvelope, EnvelopeError> {
    let fields = value.as_object().ok_or_else(|| EnvelopeError::Malformed {
        what: "not a JSON object".to_owned(),
    })?;

    let text = |key: &str| -> Result<String, EnvelopeError> {
        fields
            .get(key)
            .and_then(Json::as_str)
            .map(str::to_owned)
            .ok_or_else(|| EnvelopeError::Malformed {
                what: format!("missing string field `{key}`"),
            })
    };

    let clock = match fields.get("clock") {
        None | Some(Json::Null) => None,
        Some(Json::Object(ticks)) => {
            let mut parsed = BTreeMap::new();
            for (device, tick) in ticks {
                let tick = tick.as_u64().ok_or_else(|| EnvelopeError::Malformed {
                    what: format!("clock tick for `{device}` is not a non-negative integer"),
                })?;
                parsed.insert(device.clone(), tick);
            }
            Some(parsed)
        }
        Some(_) => {
            return Err(EnvelopeError::Malformed {
                what: "`clock` is not an object".to_owned(),
            });
        }
    };

    let deleted_at = match fields.get("deletedAt") {
        None | Some(Json::Null) => None,
        Some(number) => Some(number.as_i64().ok_or_else(|| EnvelopeError::Malformed {
            what: "`deletedAt` is not an integer".to_owned(),
        })?),
    };

    Ok(RecordEnvelope {
        id: text("id")?,
        item_type: text("type")?,
        operation: SyncOperation::from_wire(fields.get("operation").and_then(Json::as_str))?,
        encrypted_key: text("encryptedKey")?,
        key_nonce: text("keyNonce")?,
        encrypted_data: text("encryptedData")?,
        data_nonce: text("dataNonce")?,
        signature: text("signature")?,
        signer_device_id: text("signerDeviceId")?,
        clock,
        state_vector: fields
            .get("stateVector")
            .and_then(Json::as_str)
            .map(str::to_owned),
        deleted_at,
    })
}

/// The server's canonical JSON over the four blob fields, chapter 05 §5.9 A.
///
/// `JSON.stringify(payload, Object.keys(payload).sort())` with no whitespace,
/// which gives `dataNonce, encryptedData, encryptedKey, keyNonce` — a
/// **different** order from the CBOR sort in §5.9 B over the same four fields.
/// These bytes are the R2 object itself.
///
/// No client needs this today. It is implemented so a future pack or manifest
/// consumer does not have to rediscover which of the two orders it is.
pub fn canonical_blob_json(envelope: &RecordEnvelope) -> String {
    format!(
        "{{\"dataNonce\":{},\"encryptedData\":{},\"encryptedKey\":{},\"keyNonce\":{}}}",
        json_string(&envelope.data_nonce),
        json_string(&envelope.encrypted_data),
        json_string(&envelope.encrypted_key),
        json_string(&envelope.key_nonce),
    )
}

/// `contentHash`: lowercase hex SHA-256 of [`canonical_blob_json`]'s bytes
/// (chapter 05 §5.9 A).
pub fn content_hash(envelope: &RecordEnvelope) -> String {
    hex::encode(Sha256::digest(canonical_blob_json(envelope).as_bytes()))
}

fn json_string(value: &str) -> String {
    Json::String(value.to_owned()).to_string()
}
