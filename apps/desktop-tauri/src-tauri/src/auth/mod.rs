//! Auth runtime: in-memory unlock state, keychain handle, and the
//! supporting public types. Vault key derivation lives in
//! `vault_keys.rs`; provider secret storage lives in `secrets.rs`;
//! device identity lives in `device.rs`; account-level state lives in
//! `account.rs`. A linking sub-module is added in Task 14.

pub mod account;
pub mod device;
pub mod redaction;
pub mod secrets;
pub mod state;
pub mod types;
pub mod vault_keys;

pub use state::{AuthRuntime, UnlockedSession};
pub use types::{AuthStateKind, AuthStatus};
