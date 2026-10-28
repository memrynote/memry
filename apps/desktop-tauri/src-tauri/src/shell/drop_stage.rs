//! Wires [`DropStaging`] into the app: the staging root under the app data directory, the
//! startup sweep of copies an earlier run never released, the record of the files a native OS
//! drag offers on Linux, and the mapping of its errors.

use std::sync::Arc;
use std::time::SystemTime;

use memry_desktop::paths::AppPaths;
use memry_desktop::shell::drop_stage::{DropStaging, STALE_AFTER, StageError};
use tauri::{AppHandle, Manager, WebviewWindow, Wry};

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
        StageError::NotDropped => (ErrorKind::Invalid, "drop_not_dropped"),
        StageError::NotAFile => (ErrorKind::Invalid, "drop_not_a_file"),
        StageError::Io(_) => (ErrorKind::Storage, "drop_io"),
    };
    CommandError::new(kind, code, error.to_string())
}

/// Records the files of each OS drag over `window` for `drop_os_drag_uris` and
/// `drop_stage_os_files`. WebKitGTK gives the page a file drag as an empty `text/uri-list` with no
/// `File` objects; the shell reads the URIs off the native drag, which the page cannot forge. WebKit asks for the drag's data when it
/// enters the view, so the record is in place before the page sees `drop`. Other engines hand
/// the page `File` objects, which it streams (`drop_stage_chunk`).
#[cfg(target_os = "linux")]
pub fn watch_os_drags(window: &WebviewWindow<Wry>) {
    use gtk::prelude::WidgetExt;

    let staging = Arc::clone(&window.state::<Arc<DropStaging>>());
    let result = window.with_webview(move |webview| {
        webview
            .inner()
            .connect_drag_data_received(move |_, _, _, _, data, _, _| {
                let uris = data.uris();
                // The drag's other targets (`text/html`, text) carry no URI list.
                if !uris.is_empty() {
                    staging.offer_os_drag(&uris);
                }
            });
    });
    if let Err(error) = result {
        tracing::error!(scope = "DropStage", "the webview was not reached: {error}");
    }
}

#[cfg(not(target_os = "linux"))]
pub fn watch_os_drags(_window: &WebviewWindow<Wry>) {}
