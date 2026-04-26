//! Keychain abstraction.
//!
//! `KeychainStore` is a small sync trait with three methods that mirror the
//! macOS Keychain "generic password" API: `set_item`, `get_item`, and
//! `delete_item`. All secret material crosses this boundary as `&[u8]`/
//! `Vec<u8>`; references to stored bytes are never exposed.
//!
//! - `MacosKeychain` (production, M4 default on macOS) is backed by
//!   `security-framework`. It maps "not found" errors to `Ok(None)` /
//!   `Ok(())` so missing items are not failures.
//! - `MemoryKeychain` is a process-local `HashMap` used in tests and from
//!   `#[cfg(test)]` initialization of `AppState`.

pub mod macos;
pub mod memory;
pub mod service;

pub use macos::MacosKeychain;
pub use memory::MemoryKeychain;
pub use service::{KeychainStore, SERVICE_DEVICE, SERVICE_VAULT};
