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
    crypto_auth::{crypto_auth, Key as AuthKey, Mac as AuthMac},
    crypto_core::{crypto_scalarmult, crypto_scalarmult_base},
    crypto_generichash::crypto_generichash,
    crypto_kdf::crypto_kdf_derive_from_key,
};
use dryoc::constants::CRYPTO_AUTH_KEYBYTES;
use serde::{Deserialize, Serialize};

use crate::crypto::primitives::{decrypt_blob, encrypt_blob, KEY_LENGTH};
use crate::error::{AppError, AppResult};
use crate::sync::auth_client;

// libsodium key-derivation parameters that **must match** Electron's
// `KDF_CONTEXT_MAP` in `apps/desktop/src/main/crypto/keys.ts`. Drift
// here means the two clients derive different (encKey, macKey) and the
// HMAC proofs no longer verify against each other or the server.
const LINKING_KDF_ENC_ID: u64 = 5;
const LINKING_KDF_ENC_CTX: &[u8; 8] = b"memrylnk";
const LINKING_KDF_MAC_ID: u64 = 6;
const LINKING_KDF_MAC_CTX: &[u8; 8] = b"memrymac";

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

/// In-flight linking session held in memory only. Production code must
/// drop this after completion (or after a short timeout); the registry
/// below uses `take` semantics so a successful complete cannot be
/// replayed.
///
/// `peer_public_key` is `Some` only on the new-device side after a
/// successful QR scan; the initiator does not see the new device's
/// public key until the server delivers it via `/auth/linking/scan`.
#[derive(Debug, Clone)]
pub struct PendingLinkingSession {
    pub session_id: String,
    pub ephemeral_secret_key: Vec<u8>,
    pub ephemeral_public_key: Vec<u8>,
    pub linking_secret: Vec<u8>,
    pub peer_public_key: Option<Vec<u8>>,
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

    /// Returns a clone of the session if one exists, leaving the
    /// registry entry in place so a follow-up retry can reuse the
    /// ephemeral secret key.
    pub fn peek(&self, session_id: &str) -> Option<PendingLinkingSession> {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.get(session_id).cloned()
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
    // libsodium / dryoc do NOT return an error for low-order peer keys;
    // they happily write an all-zero shared secret. Accepting that would
    // give a malicious peer predictable derived (encKey, macKey) for the
    // sealed master key, so we reject it in constant time.
    let mut diff: u8 = 0;
    for &b in &shared {
        diff |= b;
    }
    if diff == 0 {
        return Err(AppError::Crypto(
            "x25519 produced an all-zero shared secret (low-order peer public key)".into(),
        ));
    }
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

/// Sealed master key produced by the approver. Carries everything the
/// new device needs to recover the master key once it has computed the
/// matching X25519 shared secret with the approver's ephemeral public
/// key (carried in the QR payload, not in this struct).
#[derive(Debug, Clone)]
pub struct SealedMasterKey {
    pub encrypted_master_key: Vec<u8>,
    pub encrypted_key_nonce: Vec<u8>,
    pub key_confirm: Vec<u8>,
}

/// Derives the linking-specific (encKey, macKey) pair from the X25519
/// shared secret. Mirrors Electron's `deriveLinkingKeys` so HMAC proofs
/// produced by either client verify on the other.
pub fn derive_linking_keys(shared_secret: &[u8]) -> AppResult<(Vec<u8>, Vec<u8>)> {
    if shared_secret.len() != KEY_LENGTH {
        return Err(AppError::Crypto(format!(
            "shared secret must be {KEY_LENGTH} bytes, got {}",
            shared_secret.len()
        )));
    }
    let key: [u8; KEY_LENGTH] = shared_secret
        .try_into()
        .map_err(|_| AppError::Crypto("invalid shared secret length".into()))?;
    let mut enc_key = [0u8; KEY_LENGTH];
    let mut mac_key = [0u8; KEY_LENGTH];
    crypto_kdf_derive_from_key(&mut enc_key, LINKING_KDF_ENC_ID, LINKING_KDF_ENC_CTX, &key)
        .map_err(|err| AppError::Crypto(format!("kdf enc derive failed: {err}")))?;
    crypto_kdf_derive_from_key(&mut mac_key, LINKING_KDF_MAC_ID, LINKING_KDF_MAC_CTX, &key)
        .map_err(|err| AppError::Crypto(format!("kdf mac derive failed: {err}")))?;
    Ok((enc_key.to_vec(), mac_key.to_vec()))
}

fn cbor_encode_text_pairs(pairs: &[(&str, &str)]) -> AppResult<Vec<u8>> {
    if pairs.len() > 23 {
        return Err(AppError::Crypto(format!(
            "cbor map too large for our minimal encoder: {}",
            pairs.len()
        )));
    }
    let mut out = Vec::with_capacity(64);
    out.push(0xa0 | pairs.len() as u8);
    for (key, value) in pairs {
        cbor_push_text(&mut out, key);
        cbor_push_text(&mut out, value);
    }
    Ok(out)
}

fn cbor_push_text(out: &mut Vec<u8>, value: &str) {
    let bytes = value.as_bytes();
    let len = bytes.len();
    if len <= 23 {
        out.push(0x60 | len as u8);
    } else if len <= 0xff {
        out.push(0x78);
        out.push(len as u8);
    } else if len <= 0xffff {
        out.push(0x79);
        out.push((len >> 8) as u8);
        out.push((len & 0xff) as u8);
    } else {
        out.push(0x7a);
        out.extend_from_slice(&(len as u32).to_be_bytes());
    }
    out.extend_from_slice(bytes);
}

fn hmac_sodium(key_bytes: &[u8], message: &[u8]) -> AppResult<Vec<u8>> {
    let key: AuthKey = key_bytes.try_into().map_err(|_| {
        AppError::Crypto(format!(
            "hmac key must be {CRYPTO_AUTH_KEYBYTES} bytes, got {}",
            key_bytes.len()
        ))
    })?;
    let mut mac: AuthMac = [0u8; std::mem::size_of::<AuthMac>()];
    crypto_auth(&mut mac, message, &key);
    Ok(mac.to_vec())
}

/// HMAC over `CBOR{sessionId, devicePublicKey}`. The server uses this
/// for `scanProof` (key=linkingSecret) and the new-device-confirm
/// payload (key=macKey).
pub fn compute_linking_proof(
    key: &[u8],
    session_id: &str,
    device_public_key_b64: &str,
) -> AppResult<Vec<u8>> {
    let payload = cbor_encode_text_pairs(&[
        ("sessionId", session_id),
        ("devicePublicKey", device_public_key_b64),
    ])?;
    hmac_sodium(key, &payload)
}

/// HMAC over `CBOR{sessionId, initiatorPublicKey, devicePublicKey}`
/// keyed with the linking secret. Matches Electron's `computeScanConfirm`.
pub fn compute_scan_confirm(
    linking_secret: &[u8],
    session_id: &str,
    initiator_public_key_b64: &str,
    device_public_key_b64: &str,
) -> AppResult<Vec<u8>> {
    let payload = cbor_encode_text_pairs(&[
        ("sessionId", session_id),
        ("initiatorPublicKey", initiator_public_key_b64),
        ("devicePublicKey", device_public_key_b64),
    ])?;
    hmac_sodium(linking_secret, &payload)
}

/// HMAC over `CBOR{sessionId, encryptedMasterKey}` keyed with the
/// derived `macKey`. Matches Electron's `computeKeyConfirm`.
pub fn compute_key_confirm(
    mac_key: &[u8],
    session_id: &str,
    encrypted_master_key_b64: &str,
) -> AppResult<Vec<u8>> {
    let payload = cbor_encode_text_pairs(&[
        ("sessionId", session_id),
        ("encryptedMasterKey", encrypted_master_key_b64),
    ])?;
    hmac_sodium(mac_key, &payload)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Approver-side: encrypts the local master key with the linking
/// `encKey` derived from the X25519 shared secret. The resulting
/// `keyConfirm` HMAC binds the session id to the ciphertext so the new
/// device can detect tampering before unsealing.
pub fn seal_master_key_for_new_device(
    master_key: &[u8],
    enc_key: &[u8],
    mac_key: &[u8],
    session_id: &str,
) -> AppResult<SealedMasterKey> {
    let sealed = encrypt_blob(master_key, enc_key, None)?;
    let encrypted_master_key_b64 = B64.encode(&sealed.ciphertext);
    let key_confirm = compute_key_confirm(mac_key, session_id, &encrypted_master_key_b64)?;
    Ok(SealedMasterKey {
        encrypted_master_key: sealed.ciphertext,
        encrypted_key_nonce: sealed.nonce.to_vec(),
        key_confirm,
    })
}

/// New-device side: verifies `keyConfirm` against the supplied
/// `mac_key` and then opens the AEAD ciphertext with `enc_key`. Returns
/// the recovered master key plaintext.
pub fn open_master_key_for_new_device(
    sealed: &SealedMasterKey,
    enc_key: &[u8],
    mac_key: &[u8],
    session_id: &str,
) -> AppResult<Vec<u8>> {
    let encrypted_master_key_b64 = B64.encode(&sealed.encrypted_master_key);
    let expected = compute_key_confirm(mac_key, session_id, &encrypted_master_key_b64)?;
    if !constant_time_eq(&expected, &sealed.key_confirm) {
        return Err(AppError::Crypto(
            "linking key-confirm mismatch — possible tampering".into(),
        ));
    }
    decrypt_blob(
        &sealed.encrypted_master_key,
        &sealed.encrypted_key_nonce,
        enc_key,
        None,
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_shared_secret_rejects_all_zero_output() {
        // #given a low-order peer public key (all-zero is the canonical
        // example) X25519 scalarmult writes an all-zero shared secret;
        // accepting it would give a malicious peer predictable derived
        // (encKey, macKey) for the sealed master key.
        let kp = generate_ephemeral_keypair();
        let bad_peer = [0u8; KEY_LENGTH];

        // #when we derive against the bad peer
        let result = derive_shared_secret(&kp.secret_key, &bad_peer);

        // #then the helper rejects rather than returning the all-zero secret
        match result {
            Err(AppError::Crypto(msg)) => {
                assert!(
                    msg.contains("all-zero") || msg.contains("low-order"),
                    "expected low-order rejection message, got: {msg}",
                );
            }
            Err(other) => panic!("expected AppError::Crypto, got: {other:?}"),
            Ok(_) => panic!("derive_shared_secret accepted an all-zero shared secret"),
        }
    }

    #[test]
    fn derive_shared_secret_accepts_real_peer() {
        // #given two ephemeral keypairs (both honest)
        let a = generate_ephemeral_keypair();
        let b = generate_ephemeral_keypair();

        // #when both sides derive
        let shared_a = derive_shared_secret(&a.secret_key, &b.public_key).unwrap();
        let shared_b = derive_shared_secret(&b.secret_key, &a.public_key).unwrap();

        // #then they agree and neither is all-zero
        assert_eq!(shared_a, shared_b);
        assert_ne!(shared_a, [0u8; KEY_LENGTH]);
    }
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
    expires_at: i64,
}

/// Wraps the QR JSON payload with the server-issued expiry so the
/// renderer can show a countdown without needing to re-derive the value.
#[derive(Debug, Clone)]
pub struct LinkingQrCreated {
    pub payload: LinkingQrPayload,
    pub expires_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanLinkingBody<'a> {
    session_id: &'a str,
    new_device_public_key: &'a str,
    new_device_confirm: &'a str,
    linking_secret: &'a str,
    scan_confirm: &'a str,
    scan_proof: &'a str,
    device_name: &'a str,
    device_platform: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApproveLinkingBody<'a> {
    session_id: &'a str,
    encrypted_master_key: &'a str,
    encrypted_key_nonce: &'a str,
    key_confirm: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompleteLinkingBody<'a> {
    session_id: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteLinkingResponse {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    encrypted_master_key: Option<String>,
    #[serde(default)]
    encrypted_key_nonce: Option<String>,
    #[serde(default)]
    key_confirm: Option<String>,
}

/// Device metadata uploaded with `/auth/linking/scan`. The server
/// stores `deviceName` and `devicePlatform` for the approver UI; supply
/// reasonable defaults when running headlessly.
#[derive(Debug, Clone)]
pub struct ScanDeviceMetadata {
    pub device_name: String,
    pub device_platform: String,
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

/// Initiator (already-authenticated) side: generates an ephemeral
/// keypair, calls `/auth/linking/initiate` with the public key and the
/// supplied access token, registers a pending session in the registry,
/// and returns the QR payload + the server-issued expiry timestamp.
///
/// The token MUST be the active access token (not the one-shot
/// `setup-token`, which is deleted after first-device registration).
/// The server route is protected by `authMiddleware`.
pub async fn generate_linking_qr_with_base(
    base_url: &str,
    registry: &PendingLinkingRegistry,
    access_token: &str,
) -> AppResult<LinkingQrCreated> {
    let kp = generate_ephemeral_keypair();
    let public_key_b64 = B64.encode(kp.public_key);

    let body = InitiateLinkingBody {
        ephemeral_public_key: public_key_b64.clone(),
    };
    let resp: InitiateLinkingResponse =
        auth_client::initiate_linking_with_base(base_url, &body, access_token).await?;

    let linking_secret_bytes = decode_b64(&resp.linking_secret)?;
    registry.insert(PendingLinkingSession {
        session_id: resp.session_id.clone(),
        ephemeral_secret_key: kp.secret_key.to_vec(),
        ephemeral_public_key: kp.public_key.to_vec(),
        linking_secret: linking_secret_bytes,
        peer_public_key: None,
    });

    Ok(LinkingQrCreated {
        payload: LinkingQrPayload {
            session_id: resp.session_id,
            linking_secret: resp.linking_secret,
            ephemeral_public_key: public_key_b64,
        },
        expires_at: resp.expires_at,
    })
}

/// New-device side: parses a QR payload, derives the X25519 shared
/// secret with the approver, and posts the full set of HMAC proofs to
/// `/auth/linking/scan` per the server contract. Persists the
/// new-device ephemeral keys + initiator public key in the registry so
/// the matching `complete_linking_with_base` call can recover the
/// master key. Returns the SAS code the approver must compare against
/// the new device's screen.
pub async fn link_via_qr_with_base(
    base_url: &str,
    registry: &PendingLinkingRegistry,
    qr_json: &str,
    metadata: &ScanDeviceMetadata,
) -> AppResult<LinkingScanResult> {
    let qr = decode_qr_payload(qr_json)?;
    let initiator_public_key = decode_b64(&qr.ephemeral_public_key)?;
    if initiator_public_key.len() != KEY_LENGTH {
        return Err(AppError::Validation(format!(
            "ephemeral public key must be {KEY_LENGTH} bytes, got {}",
            initiator_public_key.len(),
        )));
    }
    let linking_secret = decode_b64(&qr.linking_secret)?;

    let new_device = generate_ephemeral_keypair();
    let new_device_public_b64 = B64.encode(new_device.public_key);
    let shared_secret = derive_shared_secret(&new_device.secret_key, &initiator_public_key)?;
    let (_enc_key, mac_key) = derive_linking_keys(&shared_secret)?;

    let new_device_confirm =
        compute_linking_proof(&mac_key, &qr.session_id, &new_device_public_b64)?;
    let scan_proof =
        compute_linking_proof(&linking_secret, &qr.session_id, &new_device_public_b64)?;
    let scan_confirm = compute_scan_confirm(
        &linking_secret,
        &qr.session_id,
        &qr.ephemeral_public_key,
        &new_device_public_b64,
    )?;

    let new_device_confirm_b64 = B64.encode(&new_device_confirm);
    let scan_proof_b64 = B64.encode(&scan_proof);
    let scan_confirm_b64 = B64.encode(&scan_confirm);

    let body = ScanLinkingBody {
        session_id: &qr.session_id,
        new_device_public_key: &new_device_public_b64,
        new_device_confirm: &new_device_confirm_b64,
        linking_secret: &qr.linking_secret,
        scan_confirm: &scan_confirm_b64,
        scan_proof: &scan_proof_b64,
        device_name: &metadata.device_name,
        device_platform: &metadata.device_platform,
    };
    let _: serde_json::Value = auth_client::scan_linking_with_base(base_url, &body, None).await?;

    registry.insert(PendingLinkingSession {
        session_id: qr.session_id.clone(),
        ephemeral_secret_key: new_device.secret_key.to_vec(),
        ephemeral_public_key: new_device.public_key.to_vec(),
        linking_secret: linking_secret.clone(),
        peer_public_key: Some(initiator_public_key.clone()),
    });

    let sas_code = generate_sas_code(&linking_secret)?;
    Ok(LinkingScanResult {
        session_id: qr.session_id,
        sas_code,
    })
}

/// Approver side: derives the X25519 shared secret with the new
/// device's public key, seals the local master key under the resulting
/// `encKey`, computes `keyConfirm` over `(sessionId, encryptedMasterKey)`
/// with the derived `macKey`, and posts the bundle to `/auth/linking/approve`.
pub async fn approve_linking_with_base(
    base_url: &str,
    session_id: &str,
    initiator_secret_key: &[u8],
    master_key: &[u8],
    new_device_public_key: &[u8],
    access_token: &str,
) -> AppResult<()> {
    let shared_secret = derive_shared_secret(initiator_secret_key, new_device_public_key)?;
    let (enc_key, mac_key) = derive_linking_keys(&shared_secret)?;
    let sealed = seal_master_key_for_new_device(master_key, &enc_key, &mac_key, session_id)?;

    let encrypted_master_key_b64 = B64.encode(&sealed.encrypted_master_key);
    let encrypted_key_nonce_b64 = B64.encode(&sealed.encrypted_key_nonce);
    let key_confirm_b64 = B64.encode(&sealed.key_confirm);

    let body = ApproveLinkingBody {
        session_id,
        encrypted_master_key: &encrypted_master_key_b64,
        encrypted_key_nonce: &encrypted_key_nonce_b64,
        key_confirm: &key_confirm_b64,
    };
    let _: serde_json::Value =
        auth_client::approve_linking_with_base(base_url, &body, access_token).await?;
    Ok(())
}

/// New device side: looks up the pending session in the registry,
/// fetches the sealed master key from `/auth/linking/complete`, opens
/// it under the derived `encKey`/`macKey`, and returns the recovered
/// master key. The session is consumed only on success so that a
/// not-yet-approved or transient error remains retryable.
pub async fn complete_linking_with_base(
    base_url: &str,
    registry: &PendingLinkingRegistry,
    session_id: &str,
) -> AppResult<CompleteLinkingResult> {
    let session = registry
        .peek(session_id)
        .ok_or_else(|| AppError::Auth(format!("no pending linking session: {session_id}")))?;
    let initiator_public_key = session.peer_public_key.as_deref().ok_or_else(|| {
        AppError::Auth(format!(
            "linking session {session_id} is missing peer public key (was QR scanned?)",
        ))
    })?;

    let body = CompleteLinkingBody { session_id };
    let resp: CompleteLinkingResponse =
        auth_client::complete_linking_with_base(base_url, &body).await?;

    let encrypted_master_key_b64 = resp
        .encrypted_master_key
        .ok_or_else(|| AppError::Auth("session not yet approved".into()))?;
    let encrypted_key_nonce_b64 = resp
        .encrypted_key_nonce
        .ok_or_else(|| AppError::Auth("session not yet approved".into()))?;
    let key_confirm_b64 = resp
        .key_confirm
        .ok_or_else(|| AppError::Auth("session not yet approved".into()))?;

    if !resp.success {
        return Err(AppError::Auth("server reported linking failure".into()));
    }

    let sealed = SealedMasterKey {
        encrypted_master_key: decode_b64(&encrypted_master_key_b64)?,
        encrypted_key_nonce: decode_b64(&encrypted_key_nonce_b64)?,
        key_confirm: decode_b64(&key_confirm_b64)?,
    };

    let shared_secret = derive_shared_secret(&session.ephemeral_secret_key, initiator_public_key)?;
    let (enc_key, mac_key) = derive_linking_keys(&shared_secret)?;
    let master_key = open_master_key_for_new_device(&sealed, &enc_key, &mac_key, session_id)?;

    // Decryption succeeded — drop the session so a replay can't reuse it.
    let _ = registry.take(session_id);

    Ok(CompleteLinkingResult {
        // The current `/auth/linking/complete` contract no longer carries
        // a `deviceId`; the renderer fetches it via `/devices` afterward
        // if it needs to display device info. We surface an empty string
        // so the caller can still match on the result without panicking.
        device_id: String::new(),
        master_key,
    })
}
