//! Auth runtime: in-memory unlock state, keychain handle, and the
//! supporting public types. Vault key derivation lives in
//! `vault_keys.rs`; provider secret storage lives in `secrets.rs`;
//! later phases add device, account, and linking sub-modules per the
//! M4 plan.

pub mod secrets;
pub mod state;
pub mod types;
pub mod vault_keys;

pub use state::{AuthRuntime, UnlockedSession};
pub use types::{AuthStateKind, AuthStatus};
