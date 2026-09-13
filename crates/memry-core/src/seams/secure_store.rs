//! The Keychain seam, data-model §B and FR-023.
//!
//! **Bytes, not strings.** Every value here is `Vec<u8>`; the master key is 32
//! raw bytes and the device signing key is 64, and rendering either as a
//! `String` to cross the FFI puts a secret in Swift storage the core cannot
//! zero (constitution 2.1.0).
//!
//! **Keys never reach the database, the logs, telemetry, or a backup**
//! (data-model §D.5). This seam is the only place key material crosses out of
//! the core, and it crosses only into the platform's own secure storage.

use crate::api::errors::SecureStoreError;

/// The five entries chapter 01 §1.8 defines, all under service `com.memry.sync`.
///
/// An enum rather than a string key, so a typo is a compile error and so the
/// shell cannot invent a sixth entry the core does not know about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum SecureStoreKey {
    /// 32 raw bytes. The one secret that must survive, because everything else
    /// derives from it (chapter 01 §1.6).
    MasterKey,
    /// The 64-byte Ed25519 secret key. Random, never derived, so a device that
    /// loses it MUST register anew.
    DeviceSigningKey,
    AccessToken,
    RefreshToken,
    SetupToken,
}

/// Platform secure storage.
///
/// The core specifies the access policy and the shell applies it: after first
/// unlock, this device only, never synchronised to iCloud, never in a backup.
/// The shell does not get to choose, because a shell that chooses
/// `whenUnlocked` breaks the background refresh that runs before the first
/// unlock after a reboot.
#[uniffi::export(with_foreign)]
pub trait SecureStore: Send + Sync {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError>;
    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError>;
    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError>;
    /// Removes every entry. Sign-out, and the only correct response to an
    /// account key verifier mismatch.
    fn clear(&self) -> Result<(), SecureStoreError>;
}
