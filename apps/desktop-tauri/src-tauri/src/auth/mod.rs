//! Auth runtime: in-memory unlock state, keychain handle, and the
//! supporting public types. Vault key derivation lives in
//! `vault_keys.rs`; provider secret storage lives in `secrets.rs`;
//! device identity lives in `device.rs`; account-level state lives in
//! `account.rs`; cross-device linking primitives live in `linking.rs`.

pub mod account;
pub mod device;
pub mod linking;
pub mod redaction;
pub mod secrets;
pub mod state;
pub mod types;
pub mod vault_keys;

pub use state::{AuthRuntime, UnlockedSession};
pub use types::{AuthStateKind, AuthStatus};
