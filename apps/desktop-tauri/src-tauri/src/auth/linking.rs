//! Device linking primitives: ephemeral X25519 keypairs, six-digit
//! short-authentication-string (SAS) derivation, sealed-master-key
//! transport, and a memory-only registry of pending linking sessions.
//!
//! The flow these primitives support:
//!
//! 1. The new device generates an ephemeral X25519 keypair and posts
//!    its public key to `/auth/linking/initiate`. The server returns a
//!    session id plus a `linking_secret`.
//! 2. The new device renders a QR payload via `encode_qr_payload`.
//! 3. The approver scans the QR, computes the same SAS via
//!    `generate_sas_code`, and confirms.
//! 4. On approval, the approver seals its master key for the new
//!    device's ephemeral public key via `seal_master_key_for_new_device`
//!    and posts the sealed payload to `/auth/linking/approve`.
//! 5. The new device opens the sealed payload via
//!    `open_master_key_for_new_device` and persists the recovered
//!    master key.
//!
//! All X25519/curve25519 work uses dryoc `crypto_scalarmult` and the
//! sealed payload uses XChaCha20-Poly1305 from the M4 primitives, so we
//! do not introduce a new crypto crate (`x25519-dalek`) for linking.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use dryoc::classic::{
    crypto_core::{crypto_scalarmult, crypto_scalarmult_base},
    crypto_generichash::crypto_generichash,
};
use serde::{Deserialize, Serialize};

use crate::crypto::primitives::{decrypt_blob, encrypt_blob, KEY_LENGTH};
use crate::error::{AppError, AppResult};
use crate::sync::auth_client;

const SAS_LENGTH: usize = 6;

/// Ephemeral X25519 keypair held only for the lifetime of one linking
/// session. Both keys are 32 bytes.
#[derive(Debug, Clone)]
pub struct EphemeralKeyPair {
    pub public_key: [u8; KEY_LENGTH],
    pub secret_key: [u8; KEY_LENGTH],
}

/// QR payload that the new device encodes and the approver scans.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkingQrPayload {
    pub session_id: String,
    pub linking_secret: String,
    pub ephemeral_public_key: String,
}

/// Sealed master key produced by the approver. The receiver opens it
/// via `open_master_key_for_new_device` using its ephemeral secret key
/// and the approver's ephemeral public key.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkingApprovePayload {
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub approver_ephemeral_public_key: Vec<u8>,
}

/// In-flight linking session held in memory only. Production code must
/// drop this after completion (or after a short timeout); the registry
/// below uses `take` semantics so a successful complete cannot be
/// replayed.
#[derive(Debug, Clone)]
pub struct PendingLinkingSession {
    pub session_id: String,
    pub ephemeral_secret_key: Vec<u8>,
    pub ephemeral_public_key: Vec<u8>,
    pub linking_secret: Vec<u8>,
}

/// Process-local registry of pending linking sessions. Linking sessions
/// are deliberately memory-only (the auth server is authoritative for
/// session state); this registry only holds the local-side ephemeral
/// secret key so a follow-up command can derive the shared secret.
pub struct PendingLinkingRegistry {
    inner: Mutex<HashMap<String, PendingLinkingSession>>,
}

impl Default for PendingLinkingRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl PendingLinkingRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub fn insert(&self, session: PendingLinkingSession) {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.insert(session.session_id.clone(), session);
    }

    /// Removes and returns the session with the given id. Returns
    /// `None` if no such session exists. Using `take` semantics
    /// prevents a successful complete from being replayed.
    pub fn take(&self, session_id: &str) -> Option<PendingLinkingSession> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.remove(session_id)
    }
}

/// Generates a fresh X25519 ephemeral keypair. The secret key is a
/// random 32-byte scalar; the public key is `base * secret`.
pub fn generate_ephemeral_keypair() -> EphemeralKeyPair {
    use chacha20poly1305::aead::{rand_core::RngCore, OsRng};
    let mut secret_key = [0u8; KEY_LENGTH];
    OsRng.fill_bytes(&mut secret_key);
    let mut public_key = [0u8; KEY_LENGTH];
    crypto_scalarmult_base(&mut public_key, &secret_key);
    EphemeralKeyPair {
        public_key,
        secret_key,
    }
}

/// Derives the X25519 shared secret between `secret_key` and
/// `peer_public_key`. Returns 32 bytes.
pub fn derive_shared_secret(
    secret_key: &[u8],
    peer_public_key: &[u8],
) -> AppResult<[u8; KEY_LENGTH]> {
    let sk: &[u8; KEY_LENGTH] = secret_key.try_into().map_err(|_| {
        AppError::Crypto(format!(
            "secret key must be {KEY_LENGTH} bytes, got {}",
            secret_key.len()
        ))
    })?;
    let pk: &[u8; KEY_LENGTH] = peer_public_key.try_into().map_err(|_| {
        AppError::Crypto(format!(
            "peer public key must be {KEY_LENGTH} bytes, got {}",
            peer_public_key.len()
        ))
    })?;
    let mut shared = [0u8; KEY_LENGTH];
    crypto_scalarmult(&mut shared, sk, pk);
    Ok(shared)
}

/// Derives a six-digit decimal SAS from the shared linking secret.
/// Stable for a fixed input so both sides display the same code.
///
/// libsodium's BLAKE2b minimum output is 16 bytes; the first 8 bytes
/// are then folded into a `u64` modulo 1e6.
pub fn generate_sas_code(shared_secret: &[u8]) -> AppResult<String> {
    let mut digest = [0u8; 16];
    crypto_generichash(&mut digest, shared_secret, Some(b"memry-linking-sas"))
        .map_err(|err| AppError::Crypto(format!("blake2b sas hash failed: {err}")))?;
    let mut head = [0u8; 8];
    head.copy_from_slice(&digest[..8]);
    let n = u64::from_be_bytes(head);
    Ok(format!("{:0width$}", n % 1_000_000, width = SAS_LENGTH))
}

/// Approver-side: seals the local master key for the new device's
/// ephemeral public key. Computes a fresh ephemeral keypair on the
/// approver side, derives the X25519 shared secret with the new
/// device's public key, and uses it as the AEAD key.
pub fn seal_master_key_for_new_device(
    master_key: &[u8],
    new_device_public_key: &[u8],
) -> AppResult<LinkingApprovePayload> {
    let approver = generate_ephemeral_keypair();
    let shared = derive_shared_secret(&approver.secret_key, new_device_public_key)?;
    let sealed = encrypt_blob(master_key, &shared, None)?;
    Ok(LinkingApprovePayload {
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce.to_vec(),
        approver_ephemeral_public_key: approver.public_key.to_vec(),
    })
}

/// New-device side: opens the sealed master key using the new device's
/// ephemeral secret key and the approver's ephemeral public key
/// (carried in `payload`).
pub fn open_master_key_for_new_device(
    payload: &LinkingApprovePayload,
    new_device_secret_key: &[u8],
) -> AppResult<Vec<u8>> {
    let shared =
        derive_shared_secret(new_device_secret_key, &payload.approver_ephemeral_public_key)?;
    decrypt_blob(&payload.ciphertext, &payload.nonce, &shared, None)
}

pub fn encode_qr_payload(payload: &LinkingQrPayload) -> AppResult<String> {
    Ok(serde_json::to_string(payload)?)
}

pub fn decode_qr_payload(json: &str) -> AppResult<LinkingQrPayload> {
    Ok(serde_json::from_str(json)?)
}

/// Helper to encode an X25519 public key as base64 for the QR payload.
pub fn encode_b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

/// Helper to decode an X25519 public key from a base64 QR field.
pub fn decode_b64(value: &str) -> AppResult<Vec<u8>> {
    B64.decode(value)
        .map_err(|err| AppError::Crypto(format!("invalid base64 in linking payload: {err}")))
}

// ---------------------------------------------------------------------
// HTTP-using flow functions
// ---------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InitiateLinkingBody {
    ephemeral_public_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitiateLinkingResponse {
    session_id: String,
    linking_secret: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanLinkingBody {
    session_id: String,
    ephemeral_public_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApproveLinkingBody {
    session_id: String,
    ciphertext: String,
    nonce: String,
    approver_ephemeral_public_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompleteLinkingBody {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteLinkingResponse {
    ciphertext: String,
    nonce: String,
    approver_ephemeral_public_key: String,
    device_id: String,
}

/// Result returned from `link_via_qr_with_base`. The SAS code is what
/// the approver presents to the user for confirmation against the new
/// device.
#[derive(Debug, Clone)]
pub struct LinkingScanResult {
    pub session_id: String,
    pub sas_code: String,
}

/// Result returned from `complete_linking_with_base`. The caller is
/// responsible for persisting the recovered master key into the
/// keychain - the linking module deliberately does not touch
/// keychain storage so the caller controls when the new master key
/// becomes the canonical one.
#[derive(Debug, Clone)]
pub struct CompleteLinkingResult {
    pub device_id: String,
    pub master_key: Vec<u8>,
}

/// New device side: generates an ephemeral keypair, calls
/// `/auth/linking/initiate` with the public key and the supplied setup
/// token, registers a pending session in the registry, and returns the
/// QR payload for display.
pub async fn generate_linking_qr_with_base(
    base_url: &str,
    registry: &PendingLinkingRegistry,
    setup_token: &str,
) -> AppResult<LinkingQrPayload> {
    let kp = generate_ephemeral_keypair();
    let public_key_b64 = B64.encode(kp.public_key);

    let body = InitiateLinkingBody {
        ephemeral_public_key: public_key_b64.clone(),
    };
    let resp: InitiateLinkingResponse =
        auth_client::initiate_linking_with_base(base_url, &body, setup_token).await?;

    let linking_secret_bytes = decode_b64(&resp.linking_secret)?;
    registry.insert(PendingLinkingSession {
        session_id: resp.session_id.clone(),
        ephemeral_secret_key: kp.secret_key.to_vec(),
        ephemeral_public_key: kp.public_key.to_vec(),
        linking_secret: linking_secret_bytes,
    });

    Ok(LinkingQrPayload {
        session_id: resp.session_id,
        linking_secret: resp.linking_secret,
        ephemeral_public_key: public_key_b64,
    })
}

/// Approver side: parses a QR payload (validating its shape and the
/// embedded ephemeral public key length), calls `/auth/linking/scan`,
/// and returns the matching SAS code so the approver can confirm the
/// new device. The shared secret used for the SAS is the QR-side
/// `linking_secret` so both ends compute the same code without a
/// curve operation.
pub async fn link_via_qr_with_base(
    base_url: &str,
    qr_json: &str,
    access_token: &str,
) -> AppResult<LinkingScanResult> {
    let qr = decode_qr_payload(qr_json)?;
    let pk_bytes = decode_b64(&qr.ephemeral_public_key)?;
    if pk_bytes.len() != KEY_LENGTH {
        return Err(AppError::Validation(format!(
            "ephemeral public key must be {KEY_LENGTH} bytes, got {}",
            pk_bytes.len(),
        )));
    }
    let secret_bytes = decode_b64(&qr.linking_secret)?;

    let body = ScanLinkingBody {
        session_id: qr.session_id.clone(),
        ephemeral_public_key: qr.ephemeral_public_key.clone(),
    };
    let _: serde_json::Value =
        auth_client::scan_linking_with_base(base_url, &body, Some(access_token)).await?;

    let sas_code = generate_sas_code(&secret_bytes)?;
    Ok(LinkingScanResult {
        session_id: qr.session_id,
        sas_code,
    })
}

/// Approver side: seals the supplied `master_key` for the new
/// device's ephemeral public key and posts the sealed payload to
/// `/auth/linking/approve`.
pub async fn approve_linking_with_base(
    base_url: &str,
    session_id: &str,
    master_key: &[u8],
    new_device_public_key: &[u8],
    access_token: &str,
) -> AppResult<()> {
    let payload = seal_master_key_for_new_device(master_key, new_device_public_key)?;
    let body = ApproveLinkingBody {
        session_id: session_id.to_string(),
        ciphertext: B64.encode(&payload.ciphertext),
        nonce: B64.encode(&payload.nonce),
        approver_ephemeral_public_key: B64.encode(&payload.approver_ephemeral_public_key),
    };
    let _: serde_json::Value =
        auth_client::approve_linking_with_base(base_url, &body, access_token).await?;
    Ok(())
}

/// New device side: looks up the pending session in the registry,
/// fetches the sealed master key from `/auth/linking/complete`,
/// decrypts it, and returns the recovered master key plus the
/// canonical device id assigned by the server. The session is
/// consumed from the registry on success.
pub async fn complete_linking_with_base(
    base_url: &str,
    registry: &PendingLinkingRegistry,
    session_id: &str,
) -> AppResult<CompleteLinkingResult> {
    let session = registry
        .take(session_id)
        .ok_or_else(|| AppError::Auth(format!("no pending linking session: {session_id}")))?;

    let body = CompleteLinkingBody {
        session_id: session_id.to_string(),
    };
    let resp: CompleteLinkingResponse =
        auth_client::complete_linking_with_base(base_url, &body).await?;

    let payload = LinkingApprovePayload {
        ciphertext: decode_b64(&resp.ciphertext)?,
        nonce: decode_b64(&resp.nonce)?,
        approver_ephemeral_public_key: decode_b64(&resp.approver_ephemeral_public_key)?,
    };
    let master_key = open_master_key_for_new_device(&payload, &session.ephemeral_secret_key)?;

    Ok(CompleteLinkingResult {
        device_id: resp.device_id,
        master_key,
    })
}
