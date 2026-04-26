//! `KeychainStore` trait and the canonical Memry service identifiers.
//!
//! The trait is intentionally narrow: three sync methods that mirror the
//! macOS Keychain "generic password" API. Tests use the in-memory backend in
//! `memory.rs`; production wires up the macOS backend in `macos.rs`.
//!
//! Service identifiers must match the Electron implementation
//! (`packages/contracts/src/crypto.ts` `KEYCHAIN_ENTRIES`) so that
//! Keychain Access.app and the Tauri build see the same items during a
//! migration. Both constants intentionally point at the single canonical
//! Electron service `com.memry.sync`; the trait splits the namespace by
//! account name (`master-key`, `device-signing-key`, ...). A future
//! migration that needs to renamespace must update the Electron contract
//! at the same time.

use crate::error::AppResult;

/// Keychain service for vault-related secrets: master key, key verifier
/// metadata, access/refresh/setup tokens, provider API keys, recovery phrase.
pub const SERVICE_VAULT: &str = "com.memry.sync";

/// Keychain service for device identity: signing secret key and device id.
/// Points at the same Electron service as `SERVICE_VAULT` because the
/// Electron contract stores all secrets under one service name and
/// distinguishes them only by account.
pub const SERVICE_DEVICE: &str = "com.memry.sync";

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
