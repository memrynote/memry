//! Desktop services of MemryNote. This crate never depends on `tauri`; the Tauri adapters in
//! `apps/desktop-tauri/src-tauri` call it.

pub mod command_failure;
pub mod config;
pub mod e2e;
pub mod electron_import;
pub mod error;
pub mod http;
pub mod i18n;
pub mod launch_env;
pub mod launch_timeline;
pub mod locale;
pub mod logging;
pub mod notes;
pub mod paths;
pub mod profile_store;
pub mod redact;
pub mod registry;
pub mod seams;
pub mod session;
pub mod settings;
pub mod shell;
pub mod startup_values;
pub mod telemetry;
pub mod vault;
pub mod web;
