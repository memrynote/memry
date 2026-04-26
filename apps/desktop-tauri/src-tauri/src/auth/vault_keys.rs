//! Vault key derivation, password unlock, and the boot-time
//! "remember device" path.
//!
//! Three public entry points:
//!
//! - `setup_local_vault_key`: first-time setup. Generates a random
//!   16-byte Argon2id salt, runs `derive_master_key` on a blocking thread,
//!   persists the salt + key verifier + remember-device flag in settings,
//!   and either stores or removes the master key in the keychain.
//! - `unlock_with_password`: subsequent password unlocks. Reads the salt
//!   and verifier from settings, runs Argon2id, compares verifiers in
//!   constant time, and only then touches the keychain.
//! - `try_unlock_from_keychain`: boot-time unlock when remember-device is
//!   true and the master key is already in the macOS Keychain.
//!
//! Wrong-password attempts must never write the keychain master key.
//! Verifier comparison uses constant-time equality.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::aead::{rand_core::RngCore, OsRng};

use crate::app_state::AppState;
use crate::auth::state::UnlockedSession;
use crate::auth::types::AuthStatus;
use crate::crypto::kdf::{
    derive_key, derive_master_key, ARGON2_SALT_LENGTH, MASTER_KEY_LENGTH,
};
use crate::db::settings;
use crate::error::{AppError, AppResult};
use crate::keychain::SERVICE_VAULT;

const SETTING_KDF_SALT: &str = "auth.kdfSalt";
const SETTING_KEY_VERIFIER: &str = "auth.keyVerifier";
const SETTING_REMEMBER_DEVICE: &str = "auth.rememberDevice";
const KEYCHAIN_ACCOUNT_MASTER_KEY: &str = "master-key";
const VAULT_KEY_CONTEXT: &str = "memry-vault-key-v1";

pub async fn setup_local_vault_key(
    state: &AppState,
    password: String,
    remember_device: bool,
) -> AppResult<()> {
    let mut salt = [0u8; ARGON2_SALT_LENGTH];
    OsRng.fill_bytes(&mut salt);

    state.auth.begin_unlock()?;

    let material = match derive_master_key(password.into_bytes(), salt).await {
        Ok(m) => m,
        Err(err) => {
            state.auth.fail_unlock("argon2id_failed")?;
            return Err(err);
        }
    };

    settings::set(&state.db, SETTING_KDF_SALT, &material.kdf_salt)?;
    settings::set(&state.db, SETTING_KEY_VERIFIER, &material.key_verifier)?;
    settings::set_bool(&state.db, SETTING_REMEMBER_DEVICE, remember_device)?;

    persist_remember_device(state, remember_device, &material.master_key)?;

    let vault_key = derive_key(&material.master_key, VAULT_KEY_CONTEXT, MASTER_KEY_LENGTH)?;
    let prior = state.auth.status();

    state.auth.finish_unlock(UnlockedSession {
        device_id: prior.device_id,
        email: prior.email,
        has_biometric: false,
        remember_device,
        master_key: material.master_key,
        vault_key,
    })?;

    Ok(())
}

pub async fn unlock_with_password(
    state: &AppState,
    password: String,
    remember_device: bool,
) -> AppResult<AuthStatus> {
    state.auth.begin_unlock()?;

    let salt = read_kdf_salt(state)?;
    let stored_verifier = settings::get(&state.db, SETTING_KEY_VERIFIER)?
        .ok_or_else(|| AppError::Auth("vault is not initialised".into()))?;

    let candidate = derive_master_key(password.into_bytes(), salt).await?;

    let verifier_matches = constant_time_eq(
        stored_verifier.as_bytes(),
        candidate.key_verifier.as_bytes(),
    );

    if !verifier_matches {
        state.auth.fail_unlock("invalid_password")?;
        return Err(AppError::InvalidPassword);
    }

    settings::set_bool(&state.db, SETTING_REMEMBER_DEVICE, remember_device)?;
    persist_remember_device(state, remember_device, &candidate.master_key)?;

    let vault_key = derive_key(&candidate.master_key, VAULT_KEY_CONTEXT, MASTER_KEY_LENGTH)?;
    let prior = state.auth.status();

    state.auth.finish_unlock(UnlockedSession {
        device_id: prior.device_id,
        email: prior.email,
        has_biometric: false,
        remember_device,
        master_key: candidate.master_key,
        vault_key,
    })?;

    Ok(state.auth.status())
}

pub fn try_unlock_from_keychain(state: &AppState) -> AppResult<Option<AuthStatus>> {
    let remember = settings::get_bool(&state.db, SETTING_REMEMBER_DEVICE)?.unwrap_or(false);
    if !remember {
        return Ok(None);
    }

    let master_key = match state
        .auth
        .keychain()
        .get_item(SERVICE_VAULT, KEYCHAIN_ACCOUNT_MASTER_KEY)?
    {
        Some(bytes) => bytes,
        None => return Ok(None),
    };

    if master_key.len() != MASTER_KEY_LENGTH {
        return Err(AppError::Crypto(format!(
            "stored master key must be {MASTER_KEY_LENGTH} bytes, got {}",
            master_key.len()
        )));
    }

    let vault_key = derive_key(&master_key, VAULT_KEY_CONTEXT, MASTER_KEY_LENGTH)?;
    let prior = state.auth.status();

    state.auth.finish_unlock(UnlockedSession {
        device_id: prior.device_id,
        email: prior.email,
        has_biometric: false,
        remember_device: true,
        master_key,
        vault_key,
    })?;

    Ok(Some(state.auth.status()))
}

fn persist_remember_device(
    state: &AppState,
    remember_device: bool,
    master_key: &[u8],
) -> AppResult<()> {
    let kc = state.auth.keychain();
    if remember_device {
        kc.set_item(SERVICE_VAULT, KEYCHAIN_ACCOUNT_MASTER_KEY, master_key)
    } else {
        kc.delete_item(SERVICE_VAULT, KEYCHAIN_ACCOUNT_MASTER_KEY)
    }
}

fn read_kdf_salt(state: &AppState) -> AppResult<[u8; ARGON2_SALT_LENGTH]> {
    let salt_b64 = settings::get(&state.db, SETTING_KDF_SALT)?
        .ok_or_else(|| AppError::Auth("vault is not initialised".into()))?;
    let salt_bytes = STANDARD
        .decode(salt_b64)
        .map_err(|e| AppError::Crypto(format!("invalid kdf salt encoding: {e}")))?;
    let len = salt_bytes.len();
    salt_bytes.as_slice().try_into().map_err(|_| {
        AppError::Crypto(format!(
            "kdf salt must be {ARGON2_SALT_LENGTH} bytes, got {len}"
        ))
    })
}

/// Constant-time byte equality. The length-mismatch branch is not itself
/// constant-time, but legitimate compare paths always pass equal-length
/// inputs (canonical 44-character base64 of a 32-byte derived key), so the
/// only attacker observable through length is "wrong-shape verifier",
/// which leaks no information about the password.
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
