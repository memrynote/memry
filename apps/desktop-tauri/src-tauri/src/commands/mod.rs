//! Tauri commands, one module per domain. A domain step adds its module here and its command
//! paths to `registry.rs`.

pub mod account;
pub mod agent;
pub mod ai;
pub mod ai_structured;
pub mod app;
pub mod attachment_sources;
pub mod attachments;
pub mod billing;
pub mod calendar_eventkit;
pub mod calendar_ics;
pub mod calendar_providers;
pub mod canvas;
pub mod canvas_folders;
pub mod clipboard;
pub mod custom_icons;
pub mod devices;
pub mod diagnostics;
pub mod drop_stage;
pub mod editor;
pub mod error;
pub mod export;
pub mod fold;
pub mod folder_view;
pub mod folders;
pub mod home_pages;
pub mod ios_beta;
pub mod journal;
pub mod large_file;
pub mod launch;
pub mod linking;
pub mod locale;
pub mod logging;
pub mod notes;
pub mod notes_import;
pub mod notes_similarity;
pub mod notes_versions;
pub mod ocr_languages;
pub mod onboarding;
pub mod portals;
pub mod properties;
pub mod property_definitions;
pub mod search;
pub mod settings;
pub mod shell;
pub mod shell_integrations;
pub mod shortcuts;
pub mod spell;
pub mod stickies;
pub mod sync;
pub mod sync_account;
pub mod tag_schema;
pub mod tags;
pub mod tags_retag;
pub mod task_writes;
pub mod tasks;
pub mod telemetry;
pub mod templates;
pub mod terminal_command;
pub mod unsplash;
pub mod updater;
pub mod vault;
pub mod vault_account;
pub mod vault_activity;
pub mod vault_files;
pub mod vault_index;
pub mod vault_locks;
pub mod vault_notices;
pub mod voice;

use error::{CommandError, ErrorKind, log_failure};

/// Runs blocking work (a database, a file) off the async runtime and logs a failure under
/// `command` before it reaches the renderer.
pub(crate) async fn blocking<T, F>(command: &'static str, work: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| CommandError::new(ErrorKind::Internal, "task_failed", error.to_string()))
        .and_then(|outcome| outcome)
        .inspect_err(|error| log_failure(command, error))
}
