//! Wires [`DropStaging`] into the app: the staging root under the app data directory, the
//! startup sweep of copies an earlier run never released, and the mapping of its errors.

use std::sync::Arc;
use std::time::SystemTime;

use memry_desktop::paths::AppPaths;
use memry_desktop::shell::drop_stage::{DropStaging, STALE_AFTER, StageError};
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::{CommandError, ErrorKind};

/// Staged copies live beside the profile, not in the OS cache directory: `MEMRY_APP_DATA_DIR`
/// then sandboxes them with everything else, so a test run never writes into a real profile.
const STAGING_DIR: &str = "drop-staging";

/// Creates the staging area, manages it, and deletes copies older than a day in the background.
pub fn init(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let root = app.state::<AppPaths>().data_dir.join(STAGING_DIR);
    let staging = Arc::new(DropStaging::new(root));
    app.manage(Arc::clone(&staging));
    tauri::async_runtime::spawn_blocking(move || {
        match staging.sweep(SystemTime::now(), STALE_AFTER) {
            Ok(0) => {}
            Ok(removed) => {
                tracing::info!(scope = "DropStage", removed, "removed stale staged drops");
            }
            Err(error) => {
                tracing::warn!(scope = "DropStage", %error, "could not sweep staged drops");
            }
        }
    });
    Ok(())
}

pub fn stage_error(error: StageError) -> CommandError {
    let (kind, code) = match &error {
        StageError::TooLarge => (ErrorKind::Invalid, "drop_too_large"),
        StageError::TooManyOpen => (ErrorKind::Invalid, "drop_too_many"),
        StageError::UnknownId => (ErrorKind::NotFound, "drop_unknown"),
        StageError::OutOfOrder => (ErrorKind::Invalid, "drop_out_of_order"),
        StageError::Overrun => (ErrorKind::Invalid, "drop_overrun"),
        StageError::Incomplete => (ErrorKind::Invalid, "drop_incomplete"),
        StageError::Io(_) => (ErrorKind::Storage, "drop_io"),
    };
    CommandError::new(kind, code, error.to_string())
}
