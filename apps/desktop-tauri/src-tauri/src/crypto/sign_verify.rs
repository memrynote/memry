//! Ed25519 detached sign/verify wrappers and the BLAKE2b-based device id
//! derivation used by the Phase B device identity flow.
//!
//! All wrappers normalise length and verification failures into
//! `AppError::Crypto` so callers see a single error kind across the IPC
//! boundary. Length is enforced at the wrapper layer because the underlying
//! dryoc API takes fixed-size arrays - callers passing slices via IPC must
//! never reach unsafe transmute paths.

use dryoc::classic::{
    crypto_generichash::crypto_generichash,
    crypto_sign::{
        crypto_sign_detached, crypto_sign_keypair, crypto_sign_seed_keypair,
        crypto_sign_verify_detached,
    },
};

use crate::error::{AppError, AppResult};

pub const PUBLIC_KEY_LENGTH: usize = 32;
pub const SECRET_KEY_LENGTH: usize = 64;
pub const SIGNATURE_LENGTH: usize = 64;
pub const SEED_LENGTH: usize = 32;
pub const DEVICE_ID_HASH_LENGTH: usize = 16;

#[derive(Debug, Clone)]
pub struct SigningKeyPair {
    pub public_key: [u8; PUBLIC_KEY_LENGTH],
    pub secret_key: [u8; SECRET_KEY_LENGTH],
}

pub fn generate_keypair() -> SigningKeyPair {
    let (public_key, secret_key) = crypto_sign_keypair();
    SigningKeyPair {
        public_key,
        secret_key,
    }
}

pub fn keypair_from_seed(seed: &[u8; SEED_LENGTH]) -> SigningKeyPair {
    let (public_key, secret_key) = crypto_sign_seed_keypair(seed);
    SigningKeyPair {
        public_key,
        secret_key,
    }
}

pub fn sign_detached(
    message: &[u8],
    secret_key: &[u8],
) -> AppResult<[u8; SIGNATURE_LENGTH]> {
    let secret_array: &[u8; SECRET_KEY_LENGTH] = secret_key.try_into().map_err(|_| {
        AppError::Crypto(format!(
            "secret key must be {SECRET_KEY_LENGTH} bytes, got {}",
            secret_key.len()
        ))
    })?;

    let mut signature = [0u8; SIGNATURE_LENGTH];
    crypto_sign_detached(&mut signature, message, secret_array)
        .map_err(|err| AppError::Crypto(format!("ed25519 sign failed: {err}")))?;
    Ok(signature)
}

pub fn verify_detached(
    message: &[u8],
    signature: &[u8],
    public_key: &[u8],
) -> AppResult<()> {
    let signature_array: &[u8; SIGNATURE_LENGTH] = signature.try_into().map_err(|_| {
        AppError::Crypto(format!(
            "signature must be {SIGNATURE_LENGTH} bytes, got {}",
            signature.len()
        ))
    })?;

    let public_array: &[u8; PUBLIC_KEY_LENGTH] = public_key.try_into().map_err(|_| {
        AppError::Crypto(format!(
            "public key must be {PUBLIC_KEY_LENGTH} bytes, got {}",
            public_key.len()
        ))
    })?;

    crypto_sign_verify_detached(signature_array, message, public_array)
        .map_err(|err| AppError::Crypto(format!("ed25519 verify failed: {err}")))
}

/// Derives the 32-character hex device id from a 32-byte Ed25519 public key.
/// Matches Electron's `crypto_generichash(16, publicKey, null)` followed by
/// hex encoding.
pub fn device_id_from_public_key(public_key: &[u8]) -> AppResult<String> {
    if public_key.len() != PUBLIC_KEY_LENGTH {
        return Err(AppError::Crypto(format!(
            "public key must be {PUBLIC_KEY_LENGTH} bytes, got {}",
            public_key.len()
        )));
    }

    let mut hash = [0u8; DEVICE_ID_HASH_LENGTH];
    crypto_generichash(&mut hash, public_key, None)
        .map_err(|err| AppError::Crypto(format!("blake2b hash failed: {err}")))?;
    Ok(hex::encode(hash))
}
