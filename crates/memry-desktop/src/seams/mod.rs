//! The platform seams the desktop sync stack runs on: the secure store (the OS keychain), the
//! transport with the sync host's certificate pins (`transport`, `tls`), and reachability from the
//! OS network events.
//!
//! `memry-core/src/seams/` defines the traits; each submodule here implements one for the desktop.
//! The core's file-protection seam (`seams/storage.rs`) stays unimplemented on desktop: the core
//! has no consumer, and the session hands `<vault>/.memry/core/` to `Vault::open`.

pub mod reachability;
pub mod secure_store;
pub mod tls;
pub mod transport;
