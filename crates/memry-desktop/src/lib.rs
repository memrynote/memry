//! Desktop services of MemryNote. This crate never depends on `tauri`; the Tauri adapters in
//! `apps/desktop-tauri/src-tauri` call it.

pub mod ai;
pub mod attachments;
pub mod command_failure;
pub mod config;
pub mod e2e;
pub mod editor;
pub mod electron_import;
pub mod error;
pub mod fold;
pub mod http;
pub mod i18n;
pub mod journal;
pub mod large_file;
pub mod launch_env;
pub mod launch_timeline;
pub mod locale;
pub mod locks;
pub mod logging;
pub mod notes;
pub mod paths;
pub mod redact;
pub mod registry;
pub mod seams;
pub mod services;
pub mod session;
pub mod settings;
pub mod shell;
pub mod startup_values;
pub mod tags;
pub mod telemetry;
pub mod templates;
pub mod updater;
pub mod uri;
pub mod vault;
pub mod web;
