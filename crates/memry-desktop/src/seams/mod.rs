//! The platform seams the desktop sync stack runs on: the secure store (the OS keychain).
//!
//! `memry-core/src/seams/` defines the traits; each submodule here implements one for the desktop.
//! The `FileProtection` seam stays unimplemented on desktop: the core has no consumer, and the
//! session hands `<vault>/.memry/core/` to `Vault::open`.

pub mod secure_store;
