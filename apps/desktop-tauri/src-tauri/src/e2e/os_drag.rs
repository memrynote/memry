//! A WebDriver drop is synthetic: no native drag reaches the webview, so the shell records no OS
//! drag (`shell::drop_stage::watch_os_drags`). This records a drag from outside the app and its
//! drop, as the GTK hooks would, so a spec can drive the WebKitGTK drop on every OS.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use memry_desktop::shell::drop_stage::DropStaging;
use tauri::State;

use crate::commands::error::CommandError;

/// Drag ids for the e2e drops, far above the GTK hook's, so the two never meet.
static NEXT_DRAG: AtomicU64 = AtomicU64::new(1 << 62);

/// Records an OS drag offering `uris`, dropped now unless `dropped` is false.
#[tauri::command]
pub fn e2e_os_drag(
    staging: State<'_, Arc<DropStaging>>,
    uris: Vec<String>,
    dropped: bool,
) -> Result<(), CommandError> {
    let drag = NEXT_DRAG.fetch_add(1, Ordering::Relaxed);
    staging.os_drag_offered(drag, &uris);
    if dropped {
        staging.os_drag_dropped(drag, Instant::now());
    }
    Ok(())
}
