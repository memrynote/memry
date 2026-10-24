//! Desktop services of MemryNote. This crate never depends on `tauri`; the Tauri adapters in
//! `apps/desktop-tauri/src-tauri` call it.

pub mod command_failure;
pub mod http;
pub mod launch_env;
pub mod logging;
pub mod paths;
