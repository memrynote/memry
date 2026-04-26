//! Argon2id master-key derivation and `crypto_kdf` subkey derivation.
//!
//! The constants below are the canonical Memry parameters, mirrored from
//! Electron `apps/desktop/src/main/crypto/keys.ts` and the libsodium
//! `crypto_pwhash` defaults. Notably:
//!
//! - parallelism is 1 because libsodium hardcodes p=1; the migration spec
//!   discusses p=4 but the live implementation has always run with p=1.
//! - memory limit is 64 MiB (interactive memlimit) but ops limit is 3
//!   (moderate opslimit) - this mix matches the existing Electron canonical.
//!
//! Argon2id is CPU-bound; `derive_master_key` uses `tokio::task::spawn_blocking`
//! so it never blocks the async runtime.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use dryoc::classic::{
    crypto_kdf::crypto_kdf_derive_from_key,
    crypto_pwhash::{crypto_pwhash, PasswordHashAlgorithm},
};

use crate::crypto::vectors::lookup_context;
use crate::error::{AppError, AppResult};

pub const ARGON2_OPS_LIMIT: u64 = 3;
pub const ARGON2_MEM_LIMIT: usize = 67_108_864;
pub const ARGON2_SALT_LENGTH: usize = 16;

pub const MASTER_KEY_LENGTH: usize = 32;
const KDF_SUBKEY_MIN: usize = 16;
const KDF_SUBKEY_MAX: usize = 64;

#[derive(Debug, Clone)]
pub struct MasterKeyMaterial {
    pub master_key: Vec<u8>,
    pub kdf_salt: String,
    pub key_verifier: String,
}

pub fn derive_key(master_key: &[u8], context: &str, length: usize) -> AppResult<Vec<u8>> {
    let entry = lookup_context(context)
        .ok_or_else(|| AppError::Crypto(format!("unknown KDF context: {context}")))?;

    let key_array: &[u8; MASTER_KEY_LENGTH] = master_key.try_into().map_err(|_| {
        AppError::Crypto(format!(
            "master key must be {MASTER_KEY_LENGTH} bytes, got {}",
            master_key.len(),
        ))
    })?;

    if !(KDF_SUBKEY_MIN..=KDF_SUBKEY_MAX).contains(&length) {
        return Err(AppError::Crypto(format!(
            "subkey length must be between {KDF_SUBKEY_MIN} and {KDF_SUBKEY_MAX}, got {length}"
        )));
    }

    let mut subkey = vec![0u8; length];
    crypto_kdf_derive_from_key(
        &mut subkey,
        entry.subkey_id,
        &entry.context_bytes,
        key_array,
    )
    .map_err(|err| AppError::Crypto(format!("kdf derive failed: {err}")))?;

    Ok(subkey)
}

pub fn generate_key_verifier(master_key: &[u8]) -> AppResult<String> {
    let derived = derive_key(master_key, "memry-key-verifier-v1", MASTER_KEY_LENGTH)?;
    Ok(STANDARD.encode(derived))
}

pub async fn derive_master_key(
    seed: Vec<u8>,
    salt: [u8; ARGON2_SALT_LENGTH],
) -> AppResult<MasterKeyMaterial> {
    let kdf_salt_b64 = STANDARD.encode(salt);

    let master_key = tokio::task::spawn_blocking(move || -> AppResult<Vec<u8>> {
        let mut out = vec![0u8; MASTER_KEY_LENGTH];
        crypto_pwhash(
            &mut out,
            &seed,
            &salt,
            ARGON2_OPS_LIMIT,
            ARGON2_MEM_LIMIT,
            PasswordHashAlgorithm::Argon2id13,
        )
        .map_err(|err| AppError::Crypto(format!("argon2id failed: {err}")))?;
        Ok(out)
    })
    .await
    .map_err(|err| AppError::Internal(format!("spawn_blocking join failed: {err}")))??;

    let key_verifier = generate_key_verifier(&master_key)?;

    Ok(MasterKeyMaterial {
        master_key,
        kdf_salt: kdf_salt_b64,
        key_verifier,
    })
}
