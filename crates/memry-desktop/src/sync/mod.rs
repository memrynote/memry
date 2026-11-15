//! The sync supervisor of the open vault: when passes run, whether sync may start, and the status
//! the renderer shows. The passes themselves are `memry_core::sync::driver::SyncDriver`'s.

pub mod error_category;
pub mod gate;
pub mod status;
pub mod triggers;
