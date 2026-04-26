//! `KeychainStore` trait and the canonical Memry service identifiers.
//!
//! The trait is intentionally narrow: three sync methods that mirror the
//! macOS Keychain "generic password" API. Tests use the in-memory backend in
//! `memory.rs`; production wires up the macOS backend in `macos.rs`.
//!
//! Service identifiers must match the Electron implementation so that
//! Keychain Access.app and the Tauri build see the same items during a
//! migration.

use crate::error::AppResult;

/// Keychain service for vault-related secrets: master key, key verifier
/// metadata, access/refresh/setup tokens, provider API keys, recovery phrase.
pub const SERVICE_VAULT: &str = "com.memry.vault";

/// Keychain service for device identity: signing secret key and device id.
pub const SERVICE_DEVICE: &str = "com.memry.device";

/// Sync, allocation-owning secret store contract.
///
/// Implementations must:
/// - return `Ok(None)` from `get_item` when the (service, account) pair is
///   absent (never an error).
/// - treat `delete_item` on a missing item as `Ok(())`.
/// - return cloned bytes from `get_item` so callers cannot mutate the store
///   by mutating the returned `Vec<u8>`.
pub trait KeychainStore: Send + Sync {
    fn set_item(&self, service: &str, account: &str, value: &[u8]) -> AppResult<()>;
    fn get_item(&self, service: &str, account: &str) -> AppResult<Option<Vec<u8>>>;
    fn delete_item(&self, service: &str, account: &str) -> AppResult<()>;
}
