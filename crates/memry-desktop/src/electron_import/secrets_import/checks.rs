//! The checks of Electron's device key and master key against the untouched Electron data, run
//! before the first write.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use memry_core::crypto::{keys, sodium};
use memry_core::seams::secure_store::SecureStoreKey;

use super::{Secret, SecretsError, SecretsEvidence, Verified, kind};
use crate::electron_import::VaultEvidence;

/// The device key against the current-device rows that name this install's device, compared as
/// base64 text (`sync-core-handlers.ts:140`). Also proves the 64 bytes are one Ed25519 secret key:
/// seed then public half. `Ok(true)` when at least one registered public key was compared.
///
/// Sign-out clears only the vault open at the time, so every other vault keeps the previous
/// session's current-device row until Electron binds it again and drops that row
/// (`vault-account-binding.ts:270-275` `bindVaultForSync`). Only the rows of config
/// `sync.deviceId` (`store.ts:466`) are compared; without one, only the vault Electron last had
/// open, the one its integrity check reads.
pub(super) fn check_device(
    device: &Secret,
    evidence: &SecretsEvidence,
) -> Result<bool, SecretsError> {
    let malformed = SecretsError::Malformed {
        kind: kind(SecureStoreKey::DeviceSigningKey),
    };
    let (public, secret) =
        sodium::sign_seed_keypair(&device[..32]).map_err(|_| malformed.clone())?;
    if secret.as_slice() != device.as_slice() {
        return Err(malformed);
    }
    let public = STANDARD.encode(public);
    let rows: Vec<&VaultEvidence> = match &evidence.device_id {
        Some(id) => evidence
            .vaults
            .iter()
            .filter(|v| v.device_id.as_deref() == Some(id.as_str()))
            .collect(),
        None => evidence
            .current_vault
            .and_then(|index| evidence.vaults.get(index))
            .into_iter()
            .collect(),
    };
    let mut compared = false;
    for row in rows.iter().filter_map(|v| v.device_public_key.as_deref()) {
        if row != public {
            return Err(SecretsError::DeviceKeyMismatch);
        }
        compared = true;
    }
    Ok(compared)
}

/// The master key against config `sync.accountKeyVerifier`, else against the
/// `vault.crypto.verifier.v1` row of the first vault that holds one (chapter 01 §1.4).
pub(super) fn check_master(
    master: &[u8],
    evidence: &SecretsEvidence,
) -> Result<Verified, SecretsError> {
    let crypto = |_| SecretsError::KeyVerifierMismatch;
    if let Some(expected) = &evidence.account_key_verifier {
        let local = keys::account_key_verifier(master).map_err(crypto)?;
        return if keys::account_key_verifier_matches(&local, expected) {
            Ok(Verified::AccountKeyVerifier)
        } else {
            Err(SecretsError::KeyVerifierMismatch)
        };
    }
    let row = evidence
        .vaults
        .iter()
        .find_map(|v| Some((v.vault_id.as_deref()?, v.key_verifier.as_deref()?)));
    let Some((vault_id, expected)) = row else {
        return Ok(Verified::NoVerifier);
    };
    let vault_key = keys::derive_vault_key(master).map_err(crypto)?;
    let local = keys::local_vault_key_verifier(&vault_key, vault_id).map_err(crypto)?;
    if sodium::memcmp(local.as_bytes(), expected.as_bytes()) {
        Ok(Verified::VaultKeyVerifier)
    } else {
        Err(SecretsError::KeyVerifierMismatch)
    }
}
