//! The sync supervisor of the open vault: when passes run, whether sync may start, and the status
//! the renderer shows. The passes themselves are `memry_core::sync::driver::SyncDriver`'s.

pub mod backend;
pub mod error_category;
pub mod gate;
pub mod result;
mod run_loop;
pub mod status;
pub mod supervisor;
pub mod triggers;
