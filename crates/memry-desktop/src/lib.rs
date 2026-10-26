//! Desktop services of MemryNote. This crate never depends on `tauri`; the Tauri adapters in
//! `apps/desktop-tauri/src-tauri` call it.

pub mod command_failure;
pub mod e2e;
pub mod electron_import;
pub mod error;
pub mod http;
pub mod launch_env;
pub mod logging;
pub mod paths;
pub mod registry;
pub mod session;
pub mod web;
