//! The device signing key, minted before any account exists.
//!
//! A vault used without an account still writes field clocks, and every clock
//! names this device by the id derived from the signing key (chapter 01
//! §1.5). The key is therefore minted on the first local write, not at
//! sign-in, and sign-in reuses it: [`signing_secret_key_in`] is the one
//! mint-or-reuse rule both paths share, so the clocks written offline carry
//! the id of the key that later registers (chapter 02 §2.5).

use zeroize::Zeroizing;

use super::AuthSession;
use crate::api::errors::AuthError;
use crate::crypto::sodium;
use crate::protocol::account;
use crate::seams::secure_store::{SecureStore, SecureStoreKey};

const ACCOUNT_SECRETS: [SecureStoreKey; 5] = [
    SecureStoreKey::AccessToken,
    SecureStoreKey::RefreshToken,
    SecureStoreKey::SetupToken,
    SecureStoreKey::MasterKey,
    SecureStoreKey::DeviceSigningKey,
];

impl AuthSession {
    /// Before a new sign-in leaves `SignedOut` (#4766): a sign-out whose keychain refused a
    /// delete may have left the last account's secrets. Each is deleted again, and a device key
    /// that still will not go is replaced, so the next account never registers with the last
    /// one's key and an unbound vault of the last account reads as foreign, not as its own. A
    /// key that can be neither deleted nor replaced refuses the sign-in. Entries that stay
    /// besides the device key are overwritten by the sign-in, and the marker stays until then.
    pub(super) fn forget_last_account(&self) -> Result<(), AuthError> {
        if !self.sign_out_marker.secrets_may_remain() {
            return Ok(());
        }
        if self.tokens.clear().is_ok() {
            self.sign_out_marker.store_cleared();
            return Ok(());
        }
        let mut kept = false;
        for key in ACCOUNT_SECRETS {
            if self.store.delete(key).is_ok() {
                continue;
            }
            if key != SecureStoreKey::DeviceSigningKey {
                kept = true;
                continue;
            }
            let (_public, secret) = sodium::sign_keypair()?;
            self.store.set(key, secret.to_vec())?;
        }
        if !kept {
            self.sign_out_marker.store_cleared();
        }
        Ok(())
    }

    /// The server's id for the device key this install holds, when the account still lists it
    /// unrevoked (`repairDeviceKeys`, `sync/device-registration.ts:411-428`); `None` when the
    /// keychain holds no device key or no live device has it. Never mints a key: a key minted here
    /// would be one the server never saw. Rust-only.
    pub async fn listed_device_id(&self) -> Result<Option<String>, AuthError> {
        let Some(secret) = self.store.get(SecureStoreKey::DeviceSigningKey)? else {
            return Ok(None);
        };
        let public = Self::signing_public_key(&Zeroizing::new(secret))?;
        Ok(account::active_device_with_key(&self.http(), &public).await?)
    }
}

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
