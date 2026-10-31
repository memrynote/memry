//! Tauri commands, one module per domain. A domain step adds its module here and its command
//! paths to `registry.rs`.

pub mod app;
pub mod custom_icons;
pub mod diagnostics;
pub mod drop_stage;
pub mod error;
pub mod locale;
pub mod logging;
pub mod note_links;
pub mod notes;
pub mod settings;
pub mod shell;
pub mod shell_integrations;
pub mod shortcuts;
pub mod spell;
pub mod telemetry;
pub mod unsplash;
pub mod updater;
pub mod vault;
pub mod vault_activity;
pub mod vault_files;
pub mod vault_index;

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
