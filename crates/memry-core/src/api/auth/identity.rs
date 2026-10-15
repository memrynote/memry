//! The device signing key, minted before any account exists.
//!
//! A vault used without an account still writes field clocks, and every clock
//! names this device by the id derived from the signing key (chapter 01
//! §1.5). The key is therefore minted on the first local write, not at
//! sign-in, and sign-in reuses it: [`signing_secret_key_in`] is the one
//! mint-or-reuse rule both paths share, so the clocks written offline carry
//! the id of the key that later registers (chapter 02 §2.5).

use crate::api::errors::AuthError;
use crate::crypto::sodium;
use crate::seams::secure_store::{SecureStore, SecureStoreKey};

/// The device's Ed25519 secret key, created on first use.
///
/// Random, never derived (data-model §B), so a device that loses it must
/// register anew. A `SecureStoreError::Locked` on the read is **not**
/// "absent": returning it unchanged is what stops a locked keychain from
/// silently minting a second identity.
pub(crate) fn signing_secret_key_in(store: &dyn SecureStore) -> Result<Vec<u8>, AuthError> {
    if let Some(existing) = store.get(SecureStoreKey::DeviceSigningKey)? {
        return Ok(existing);
    }
    let (_public, secret) = sodium::sign_keypair()?;
    store.set(SecureStoreKey::DeviceSigningKey, secret.to_vec())?;
    Ok(secret.to_vec())
}

/// Mints and persists this device's signing key when it has none, and keeps
/// the one it has otherwise.
///
/// Call before opening a vault's writers on a device that has never signed
/// in: the writers refuse to write without a device identity. Signing in
/// later commits this same key as `devicePublicKey`, so nothing written
/// before the account existed changes owner.
#[uniffi::export]
pub fn ensure_device_identity(store: std::sync::Arc<dyn SecureStore>) -> Result<(), AuthError> {
    signing_secret_key_in(store.as_ref()).map(|_| ())
}
