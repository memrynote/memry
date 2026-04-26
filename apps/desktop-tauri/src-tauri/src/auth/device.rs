//! Device identity: signing keypair persistence, challenge signing, and
//! the local `sync_devices` upsert for the current device.
//!
//! The signing keypair lives in the OS keychain under
//! `SERVICE_DEVICE / device-signing-key`. `get_or_create_device_signing_key`
//! creates one on first call and reuses the stored bytes on subsequent
//! calls. The corresponding device id is the BLAKE2b/16 hash of the
//! Ed25519 public key, hex-encoded, matching the Phase A helper in
//! `crypto::sign_verify::device_id_from_public_key`.
//!
//! `upsert_current_device` writes the local device row into
//! `sync_devices` with `is_current_device = 1`. Any other row that was
//! previously marked current is cleared in the same transaction so the
//! "exactly one current device" invariant cannot drift.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

use crate::app_state::AppState;
use crate::crypto::sign_verify::{
    device_id_from_public_key, generate_keypair, sign_detached, PUBLIC_KEY_LENGTH,
    SECRET_KEY_LENGTH, SEED_LENGTH,
};
use crate::error::{AppError, AppResult};
use crate::keychain::SERVICE_DEVICE;

/// Keychain account identifier under `SERVICE_DEVICE` for the persisted
/// Ed25519 signing keypair seed. The account name is part of the public
/// contract so renderer-side test fixtures and Keychain Access lookups
/// can find the item.
pub const KEYCHAIN_DEVICE_SIGNING_KEY: &str = "device-signing-key";

/// Device-side Ed25519 keypair used to sign auth-server challenges and
/// CRDT messages. `secret_key` carries the canonical 64-byte libsodium
/// representation; callers MUST keep it in scope only for the duration
/// of a single signing operation.
#[derive(Debug, Clone)]
pub struct DeviceSigningKeyPair {
    pub public_key: [u8; PUBLIC_KEY_LENGTH],
    pub secret_key: [u8; SECRET_KEY_LENGTH],
}

/// Local device fields persisted to the `sync_devices` table.
#[derive(Debug, Clone)]
pub struct CurrentDeviceRecord {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub os_version: Option<String>,
    pub app_version: String,
    pub linked_at: i64,
    pub signing_public_key: String,
}

/// Returns the existing device signing keypair if one is stored under
/// `SERVICE_DEVICE / device-signing-key`. Otherwise generates a fresh
/// keypair, persists the canonical 64-byte libsodium secret key, and
/// returns the new keypair.
///
/// libsodium's 64-byte Ed25519 secret key concatenates the 32-byte
/// seed with the 32-byte public key, so we can reconstruct the public
/// key from the stored bytes without recomputing the curve operation.
pub fn get_or_create_device_signing_key(state: &AppState) -> AppResult<DeviceSigningKeyPair> {
    let kc = state.auth.keychain();
    if let Some(stored) = kc.get_item(SERVICE_DEVICE, KEYCHAIN_DEVICE_SIGNING_KEY)? {
        return reconstruct_keypair_from_secret(&stored);
    }

    let kp = generate_keypair();
    kc.set_item(SERVICE_DEVICE, KEYCHAIN_DEVICE_SIGNING_KEY, &kp.secret_key)?;
    Ok(kp.into())
}

/// Returns the 32-character hex device id derived from the keypair's
/// Ed25519 public key.
pub fn device_id_for_keypair(kp: &DeviceSigningKeyPair) -> AppResult<String> {
    device_id_from_public_key(&kp.public_key)
}

/// Signs `challenge` (a UTF-8 server nonce) with the supplied 64-byte
/// Ed25519 secret key. Returns the 64-byte signature, base64-encoded so
/// it can travel across the IPC and HTTP boundaries unchanged.
pub fn sign_device_challenge(secret_key: &[u8], challenge: &str) -> AppResult<String> {
    let signature = sign_detached(challenge.as_bytes(), secret_key)?;
    Ok(B64.encode(signature))
}

/// Inserts or updates the local device row in `sync_devices` and sets
/// `is_current_device = 1`. Any previously-current device row is
/// cleared so the table maintains the "exactly one current device"
/// invariant.
pub fn upsert_current_device(state: &AppState, device: CurrentDeviceRecord) -> AppResult<()> {
    let mut conn = state.db.conn()?;
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE sync_devices SET is_current_device = 0 WHERE id <> ?1",
        rusqlite::params![device.id],
    )?;
    tx.execute(
        "INSERT INTO sync_devices(
             id, name, platform, os_version, app_version,
             linked_at, last_sync_at, is_current_device, signing_public_key
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 1, ?7)
         ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             platform = excluded.platform,
             os_version = excluded.os_version,
             app_version = excluded.app_version,
             linked_at = excluded.linked_at,
             is_current_device = 1,
             signing_public_key = excluded.signing_public_key",
        rusqlite::params![
            device.id,
            device.name,
            device.platform,
            device.os_version,
            device.app_version,
            device.linked_at,
            device.signing_public_key,
        ],
    )?;
    tx.commit()?;
    Ok(())
}

impl From<crate::crypto::sign_verify::SigningKeyPair> for DeviceSigningKeyPair {
    fn from(kp: crate::crypto::sign_verify::SigningKeyPair) -> Self {
        Self {
            public_key: kp.public_key,
            secret_key: kp.secret_key,
        }
    }
}

fn reconstruct_keypair_from_secret(bytes: &[u8]) -> AppResult<DeviceSigningKeyPair> {
    let secret_key: [u8; SECRET_KEY_LENGTH] = bytes.try_into().map_err(|_| {
        AppError::Crypto(format!(
            "stored device signing secret must be {SECRET_KEY_LENGTH} bytes, got {}",
            bytes.len()
        ))
    })?;
    // libsodium Ed25519 64-byte secret = seed (32) || public_key (32).
    let mut public_key = [0u8; PUBLIC_KEY_LENGTH];
    public_key.copy_from_slice(&secret_key[SEED_LENGTH..]);
    Ok(DeviceSigningKeyPair {
        public_key,
        secret_key,
    })
}
