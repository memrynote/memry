//! The crypto surface the shells call, exported through UniFFI.
//!
//! **Keys cross as bytes, never as `String`.** A 32-byte key rendered as hex or
//! base64 for the FFI hop is a secret that Swift's immutable `String` storage
//! will keep alive somewhere the core cannot zero, and it invites a caller to
//! log it. `Data` in, `Data` out.
//!
//! The two **verifiers** are the deliberate exception and are `String` on
//! purpose: chapter 01 §1.4.1 defines the account key verifier as a base64
//! string and requires the comparison to happen over those strings rather than
//! over the decoded bytes. Handing Swift the decoded bytes would make the wrong
//! comparison the easy one to write.

use crate::api::errors::{CompressError, CryptoError, RecoveryError};
use crate::crypto::{keys, recovery};
use crate::protocol::compress;

/// Normalises and validates a recovery phrase, returning the canonical form.
///
/// Chapter 01 §1.3. Distinguishes an unknown word from a bad checksum, because
/// the first names a word to fix and the second says every word is real but the
/// phrase is not one Memry issued.
#[uniffi::export]
pub fn validate_recovery_phrase(phrase: String) -> Result<String, RecoveryError> {
    recovery::validate_phrase(&phrase)
}

/// Phrase and account salt to the 32-byte master key, chapter 01 §1.1.
///
/// This is the Argon2id pass: 64 MiB and three iterations, and the one call in
/// the product that can fail for lack of memory rather than for a wrong input.
/// The `RecoveryError::Crypto` variant carries that distinction outward so a
/// shell never tells the user to re-type a phrase that was correct.
#[uniffi::export]
pub fn derive_master_key(phrase: String, kdf_salt: Vec<u8>) -> Result<Vec<u8>, RecoveryError> {
    let seed = recovery::phrase_to_seed(&phrase)?;
    Ok(keys::derive_master_key(seed.as_slice(), &kdf_salt)?.to_vec())
}

/// The vault key for an account, chapter 01 §1.7.
///
/// One account, one vault key: no vault id enters the derivation. A caller
/// **MUST NOT** treat a successful decrypt as proof that a record belongs to the
/// vault it was routed to, because a ciphertext from any vault on the account
/// decrypts cleanly under this key.
#[uniffi::export]
pub fn derive_vault_key(master_key: Vec<u8>) -> Result<Vec<u8>, CryptoError> {
    Ok(keys::derive_vault_key(&master_key)?.to_vec())
}

/// The server-visible account key verifier, chapter 01 §1.4.1.
#[uniffi::export]
pub fn account_key_verifier(master_key: Vec<u8>) -> Result<String, CryptoError> {
    keys::account_key_verifier(&master_key)
}

/// Constant-time verifier comparison, chapter 01 §1.4.1.
///
/// Over the base64 strings, not the decoded bytes. Exported so that no shell has
/// to write the comparison, and so no shell writes the decoded-bytes version
/// that accepts every correct input and fails to reject some incorrect ones.
#[uniffi::export]
pub fn account_key_verifier_matches(local: String, server: String) -> bool {
    keys::account_key_verifier_matches(&local, &server)
}

/// The local vault key verifier, chapter 01 §1.4.2.
///
/// Never sent to the server. A change in this value means the vault key changed,
/// and key-scoped sync state must be purged so a stale cursor cannot skip items.
#[uniffi::export]
pub fn local_vault_key_verifier(
    vault_key: Vec<u8>,
    vault_id: String,
) -> Result<String, CryptoError> {
    keys::local_vault_key_verifier(&vault_key, &vault_id)
}

/// The locally derived device id, chapter 01 §1.5: 32 lowercase hex characters.
///
/// Computed at registration time. The **wire** identity is the server-assigned
/// `deviceId` from `POST /auth/devices`, not this value.
#[uniffi::export]
pub fn local_device_id_hex(ed25519_public_key: Vec<u8>) -> Result<String, CryptoError> {
    keys::local_device_id_hex(&ed25519_public_key)
}

/// Frames a payload with the chapter 04 §4.1 compression flag.
#[uniffi::export]
pub fn compress_payload(payload: Vec<u8>) -> Vec<u8> {
    compress::compress(&payload)
}

/// Unframes a payload, chapter 04 §4.1.
///
/// A truncated `0x01` stream is an error, never an empty result: an empty result
/// reaches the applier as a content wipe.
#[uniffi::export]
pub fn decompress_payload(frame: Vec<u8>) -> Result<Vec<u8>, CompressError> {
    compress::decompress(&frame)
}

/// The core's own version, for the `x-memry-client` header and for a shell that
/// wants to show what it is running.
#[uniffi::export]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
