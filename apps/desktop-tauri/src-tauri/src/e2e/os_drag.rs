//! A WebDriver drop is synthetic: no native drag reaches the webview, so the shell records no OS
//! drag (`shell::drop_stage::watch_os_drags`). This records one as the GTK hook would, so a spec
//! can drive the `file://` drop of WebKitGTK on every OS.

use std::sync::Arc;

use memry_desktop::shell::drop_stage::DropStaging;
use tauri::State;

use crate::commands::error::CommandError;

#[tauri::command]
pub fn e2e_offer_os_drag(
    staging: State<'_, Arc<DropStaging>>,
    uris: Vec<String>,
) -> Result<(), CommandError> {
    staging.offer_os_drag(&uris);
    Ok(())
}
