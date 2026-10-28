//! A WebDriver drop is synthetic: no native drag reaches the webview, so the shell records no OS
//! drag (`shell::drop_stage::watch_os_drags`). This records a drag from outside the app and its
//! drop, as the GTK hooks would, so a spec can drive the WebKitGTK drop on every OS.

use std::sync::Arc;
use std::time::Instant;

use memry_desktop::shell::drop_stage::DropStaging;
use tauri::State;

use crate::commands::error::CommandError;

/// Records an OS drag offering `uris`, dropped now unless `dropped` is false.
#[tauri::command]
pub fn e2e_os_drag(
    staging: State<'_, Arc<DropStaging>>,
    uris: Vec<String>,
    dropped: bool,
) -> Result<(), CommandError> {
    let drag = staging.next_os_drag_id();
    staging.os_drag_offered(drag, &uris);
    if dropped {
        staging.os_drag_dropped(drag, Instant::now());
    }
    Ok(())
}
