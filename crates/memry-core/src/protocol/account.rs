//! The three account-scoped reads a client makes between registering a device
//! and pulling a vault, and the record cipher built out of two of them.
//!
//! | Route                  | Chapter          | What it answers                        |
//! | ---------------------- | ---------------- | -------------------------------------- |
//! | `GET /auth/key-verifier` | 02 §2.1, §2.1.1 | `{ kdfSalt, keyVerifier }` for unlock  |
//! | `GET /sync/vaults`       | 05 §5.1         | the vault registry                     |
//! | `GET /auth/devices`      | 01 §1.4.0       | the signer key directory               |
//!
//! They live here rather than in [`crate::protocol::auth`] or
//! [`crate::sync::pull`] because none of them belongs to the session machine or
//! to one page of the feed, and because [`AccountCipher`] needs two of them at
//! once: chapter 01 §1.4.0 resolves `signerDeviceId` through `GET /auth/devices`
//! and §1.7 opens the record with the one vault key of the account.
//!
//! **Shapes no chapter writes out are read leniently.** Chapter 02 §2.1.1
//! writes `{ kdfSalt, keyVerifier }` out in full and the reader below takes
//! exactly that. Chapter 05 §5.1 names `/sync/vaults` in its route table
//! without a body, and chapter 01 §1.4.0 names `devices[].signingPublicKey`
//! "alongside the device id" without spelling the id's key, so those two
//! readers accept the spellings the prose leaves open and report a
//! `MalformedResponse` when they find none of them, rather than silently
//! returning an empty list that reads as "this account has no vaults".

use std::collections::HashMap;

use serde_json::Value as Json;
use zeroize::Zeroizing;

use crate::api::errors::ApiError;
use crate::crypto::keys;
use crate::protocol::envelope::{self, EnvelopeError, RecordEnvelope};
use crate::protocol::http::{ApiRequest, Auth, HttpClient};
use crate::sync::pull::RecordCipher;

mod seal;

pub use seal::{
    AccountSealer, DeviceSigner, MAX_UPDATE_BASE64_BYTES, MAX_UPDATE_BYTES, RandomEntropy,
    SIGNING_SECRET_KEY_BYTES, SealEntropy,
};

const KEY_VERIFIER_PATH: &str = "/auth/key-verifier";
const SETUP_PATH: &str = "/auth/setup";
const VAULTS_PATH: &str = "/sync/vaults";
const DEVICES_PATH: &str = "/auth/devices";

/// `{ kdfSalt, keyVerifier }`, chapter 02 §2.1.1: both required, and the salt
/// is base64 with the standard alphabet and padding (chapter 01 §1.1).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct KeyMaterial {
    pub kdf_salt: String,
    pub key_verifier: String,
}

/// One row of the vault registry.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct VaultSummary {
    pub id: String,
    /// Absent rather than empty when the registry row carries no name.
    ///
    /// **Never the ciphertext.** The server holds a vault's name encrypted
    /// under the vault key (`vault-name-crypto.ts`), and until this was split
    /// out the encrypted base64 was reported here as the name and drawn on
    /// screen. The sealed form travels in [`Self::encrypted_name`] instead,
    /// and [`crate::api::crypto::decrypt_vault_name`] opens it.
    pub name: Option<String>,
    /// The name as the server holds it: XChaCha20-Poly1305 under the vault
    /// key, base64, with `vault-name-v1:<vaultUuid>` as associated data.
    #[uniffi(default = None)]
    pub encrypted_name: Option<String>,
    /// The nonce `encrypted_name` was sealed with, base64.
    #[uniffi(default = None)]
    pub name_nonce: Option<String>,
}

/// The signer key directory of chapter 01 §1.4.0.
///
/// A snapshot, not a live view: a `signerDeviceId` it cannot resolve means the
/// list is older than the device that signed, and the caller refetches.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeviceDirectory {
    keys: HashMap<String, Vec<u8>>,
}

impl DeviceDirectory {
    pub fn signing_key(&self, device_id: &str) -> Option<&[u8]> {
        self.keys.get(device_id).map(Vec::as_slice)
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

/// The account's key material, for a client that already has a session.
///
/// Chapter 02 §2.7.1: on this route the account is known, so a verifier
/// mismatch does mean "wrong recovery phrase" — unlike `GET /auth/recovery`,
/// where a dummy answer makes a wrong email indistinguishable from one.
pub async fn key_material(http: &HttpClient) -> Result<KeyMaterial, ApiError> {
    let body: Json = http
        .send_json(ApiRequest::get(KEY_VERIFIER_PATH).auth(Auth::Session))
        .await?;
    read_key_material(&body).ok_or_else(|| ApiError::MalformedResponse {
        path: KEY_VERIFIER_PATH.to_string(),
        what: "expected { kdfSalt, keyVerifier }".to_string(),
    })
}

/// The same read, with "this account has no keys yet" as an **answer** rather
/// than an error.
///
/// Chapter 02 §2.1.1 describes the route for an established account. An account
/// that has never completed first-device setup has no `kdfSalt` at all, and the
/// route answers `400` for that and for nothing else — a missing user is `404`
/// and an unusable token is `401`, and both still cross as errors.
///
/// A separate function rather than a changed [`key_material`], because the two
/// callers want opposite things: a device about to unlock wants the failure,
/// and a device deciding *which screen to show* wants the answer. Folding them
/// would make "this account has no keys" indistinguishable from "the request
/// failed", which is how a phone with a bad connection ends up being offered a
/// brand-new recovery phrase for an account that already has one.
pub async fn key_material_if_configured(
    http: &HttpClient,
) -> Result<Option<KeyMaterial>, ApiError> {
    match key_material(http).await {
        Ok(material) => Ok(Some(material)),
        Err(ApiError::Status { status: 400, .. }) => Ok(None),
        Err(other) => Err(other),
    }
}

/// `POST /auth/setup`: the first device publishes the account's
/// `{ kdfSalt, keyVerifier }`.
///
/// **Once per account, and the server enforces it.** The update is conditional
/// on `kdf_salt IS NULL`, so a second device that raced here is refused with
/// `409` rather than overwriting the salt every existing key on the account was
/// derived from. That refusal crosses unchanged: a client that read it as
/// success would hold a master key nothing else on the account can read.
pub async fn complete_setup(
    http: &HttpClient,
    kdf_salt_base64: &str,
    key_verifier: &str,
) -> Result<(), ApiError> {
    let request = serde_json::json!({
        "kdfSalt": kdf_salt_base64,
        "keyVerifier": key_verifier,
    });
    let _: Json = http
        .send_json(
            ApiRequest::post(SETUP_PATH)
                .auth(Auth::Session)
                .json(&request),
        )
        .await?;
    Ok(())
}

/// The vault registry. FR-021's "choose one and route to it" is this plus the
/// `X-Memry-Vault-Id` header (chapter 01 §1.7).
pub async fn vaults(http: &HttpClient) -> Result<Vec<VaultSummary>, ApiError> {
    let body: Json = http
        .send_json(ApiRequest::get(VAULTS_PATH).auth(Auth::Session))
        .await?;
    read_vaults(&body).ok_or_else(|| ApiError::MalformedResponse {
        path: VAULTS_PATH.to_string(),
        what: "expected an array of vaults, or an object carrying one".to_string(),
    })
}

/// The signer key directory, chapter 01 §1.4.0. "That list is the only source."
pub async fn device_directory(http: &HttpClient) -> Result<DeviceDirectory, ApiError> {
    let body: Json = http
        .send_json(ApiRequest::get(DEVICES_PATH).auth(Auth::Session))
        .await?;
    read_directory(&body).ok_or_else(|| ApiError::MalformedResponse {
        path: DEVICES_PATH.to_string(),
        what: "expected an array of devices, or an object carrying one".to_string(),
    })
}

fn read_key_material(body: &Json) -> Option<KeyMaterial> {
    Some(KeyMaterial {
        kdf_salt: body.get("kdfSalt")?.as_str()?.to_string(),
        key_verifier: body.get("keyVerifier")?.as_str()?.to_string(),
    })
}

/// The rows of a list response, whether the body is the array itself or an
/// object carrying it under `key`.
fn rows<'a>(body: &'a Json, key: &str) -> Option<&'a Vec<Json>> {
    body.as_array()
        .or_else(|| body.get(key).and_then(Json::as_array))
}

fn read_vaults(body: &Json) -> Option<Vec<VaultSummary>> {
    let mut vaults = Vec::new();
    for row in rows(body, "vaults")? {
        // `vaultUuid` first, because that is what the server actually sends
        // (chapter 05 §5.11.1). The other two are tolerated rather than
        // expected.
        //
        // A row whose id cannot be read is a **malformed response**, not a
        // vault that does not exist: returning `None` here propagates to
        // `ApiError::MalformedResponse`. Filtering it out instead — which this
        // function used to do — turned a field-name mismatch into "this
        // account has no vaults" against an account holding four of them, and
        // the CLI reported it as cheerfully as if it were true. It is the same
        // rule FR-032 states for a zero-row first page: an empty result on an
        // account known to hold data is a failure to report, never an empty
        // account.
        vaults.push(VaultSummary {
            id: text(row, &["vaultUuid", "vaultId", "id"])?,
            name: text(row, &["name"]),
            encrypted_name: text(row, &["encryptedName"]),
            name_nonce: text(row, &["nameNonce"]),
        });
    }
    Some(vaults)
}

fn read_directory(body: &Json) -> Option<DeviceDirectory> {
    let mut keys = HashMap::new();
    for row in rows(body, "devices")? {
        let (Some(id), Some(encoded)) = (
            text(row, &["id", "deviceId"]),
            text(row, &["signingPublicKey"]),
        ) else {
            continue;
        };
        // A key that is not base64 is one unusable device, not an unusable
        // directory: the other devices' records still verify.
        if let Ok(public_key) = keys::base64_decode(&encoded) {
            keys.insert(id, public_key);
        }
    }
    Some(DeviceDirectory { keys })
}

fn text(row: &Json, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| row.get(*name).and_then(Json::as_str))
        .map(str::to_string)
}

/// Opens pulled records with the account's vault key and this directory.
///
/// Chapter 01 §1.7: one key opens every vault on the account, so a successful
/// decrypt proves nothing about routing — the pull loop checks that separately.
pub struct AccountCipher {
    vault_key: Zeroizing<Vec<u8>>,
    directory: DeviceDirectory,
}

impl AccountCipher {
    pub fn new(vault_key: Vec<u8>, directory: DeviceDirectory) -> Self {
        Self {
            vault_key: Zeroizing::new(vault_key),
            directory,
        }
    }
}

impl RecordCipher for AccountCipher {
    fn open(&self, envelope: &RecordEnvelope) -> Result<Vec<u8>, EnvelopeError> {
        // Chapter 01 §1.4.0: a signer that cannot be resolved leaves the record
        // **unverified, not invalid**. The caller records it unapplied and
        // refetches the directory; it is never dropped and never treated as an
        // attack, because a device registered since the last fetch is the
        // ordinary case.
        let signer = self
            .directory
            .signing_key(&envelope.signer_device_id)
            .ok_or_else(|| EnvelopeError::Malformed {
                what: format!(
                    "signer device `{}` is not in the directory from GET /auth/devices",
                    envelope.signer_device_id
                ),
            })?;
        envelope::decrypt(envelope, &self.vault_key, signer)
    }
}

impl crate::sync::body_pull::CrdtCipher for AccountCipher {
    fn open(
        &self,
        update: &crate::sync::body_pull::PackedUpdate<'_>,
    ) -> Result<Vec<u8>, EnvelopeError> {
        // Same directory, same §1.4.0 rule as the record path: an
        // unresolvable signer is unverified, not invalid.
        let device_id = update
            .signer_device_id
            .ok_or_else(|| EnvelopeError::Malformed {
                what: format!("update for `{}` advertised no signer", update.doc_id),
            })?;
        let signer =
            self.directory
                .signing_key(device_id)
                .ok_or_else(|| EnvelopeError::Malformed {
                    what: format!(
                        "signer device `{device_id}` is not in the directory from GET /auth/devices"
                    ),
                })?;
        crate::protocol::crdt_envelope::unpack(
            update.packed,
            update.doc_id,
            &self.vault_key,
            signer,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn key_material_reads_the_chapter_02_shape() {
        let body = json!({ "kdfSalt": "c2FsdA==", "keyVerifier": "dmVyaWZpZXI=" });
        assert_eq!(
            read_key_material(&body),
            Some(KeyMaterial {
                kdf_salt: "c2FsdA==".to_string(),
                key_verifier: "dmVyaWZpZXI=".to_string(),
            })
        );
        // Both are required, so a half-answer is not a key material.
        assert_eq!(read_key_material(&json!({ "kdfSalt": "c2FsdA==" })), None);
    }

    #[test]
    fn the_vault_registry_is_read_as_an_array_or_as_a_wrapper() {
        let bare = json!([{ "id": "v1", "name": "Work" }, { "vaultId": "v2" }]);
        let wrapped = json!({ "vaults": [{ "id": "v1", "name": "Work" }, { "vaultId": "v2" }] });
        let expected = vec![
            VaultSummary {
                id: "v1".to_string(),
                name: Some("Work".to_string()),
                encrypted_name: None,
                name_nonce: None,
            },
            VaultSummary {
                id: "v2".to_string(),
                name: None,
                encrypted_name: None,
                name_nonce: None,
            },
        ];
        assert_eq!(read_vaults(&bare).as_deref(), Some(expected.as_slice()));
        assert_eq!(read_vaults(&wrapped).as_deref(), Some(expected.as_slice()));
        // A body that is neither is a malformed response, not an empty account.
        assert_eq!(read_vaults(&json!({ "ok": true })), None);
    }

    #[test]
    fn the_directory_keeps_the_decodable_keys_and_skips_the_rest() {
        let body = json!({
            "devices": [
                { "id": "device-a", "signingPublicKey": "AAEC" },
                { "deviceId": "device-b", "signingPublicKey": "not base64!" },
                { "id": "device-c" },
            ]
        });
        let directory = read_directory(&body).expect("a directory");
        assert_eq!(
            directory.signing_key("device-a"),
            Some([0, 1, 2].as_slice())
        );
        assert_eq!(directory.signing_key("device-b"), None);
        assert_eq!(directory.len(), 1);
    }

    #[test]
    fn an_unresolvable_signer_is_reported_as_such_and_never_as_a_bad_signature() {
        let cipher = AccountCipher::new(vec![0u8; 32], DeviceDirectory::default());
        let envelope = RecordEnvelope {
            id: "note-1".to_string(),
            item_type: "note".to_string(),
            operation: envelope::SyncOperation::Update,
            encrypted_key: String::new(),
            key_nonce: String::new(),
            encrypted_data: String::new(),
            data_nonce: String::new(),
            signature: String::new(),
            signer_device_id: "device-z".to_string(),
            clock: None,
            state_vector: None,
            deleted_at: None,
        };
        match cipher.open(&envelope) {
            Err(EnvelopeError::Malformed { what }) => assert!(what.contains("device-z")),
            other => panic!("expected an unresolved signer, got {other:?}"),
        }
    }
}
