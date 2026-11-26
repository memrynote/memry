//! macOS Calendar access (#3546 29h): the permission step of Electron's `connectApple`
//! (`calendar/eventkit/eventkit-provider.ts`), over
//! `memry_desktop::calendar_providers::eventkit::EventKit`. The macOS dialog appears only when
//! the user has never answered. On Windows and Linux the call answers `unsupported_platform`
//! and spawns nothing.

use std::sync::Arc;

use memry_desktop::calendar_providers::eventkit::{AccessError, AuthorizationStatus, EventKit};
use tauri::{AppHandle, Manager, Wry};

use super::error::{CommandError, ErrorKind, log_failure};

/// `calendar_eventkit_request_access`: the status after the request; a failure throws its code
/// (`unsupported_platform`, `unavailable`, `permission_denied`, `sync_failed`).
#[tauri::command]
#[specta::specta]
pub async fn calendar_eventkit_request_access(
    app: AppHandle<Wry>,
) -> Result<AuthorizationStatus, CommandError> {
    const COMMAND: &str = "calendar_eventkit_request_access";
    let eventkit = eventkit(&app).inspect_err(|error| log_failure(COMMAND, error))?;
    eventkit.request_access().await.map_err(|code| {
        let kind = match code {
            AccessError::UnsupportedPlatform => ErrorKind::Invalid,
            AccessError::PermissionDenied => ErrorKind::Auth,
            AccessError::Unavailable | AccessError::Failed => ErrorKind::Internal,
        };
        let error = CommandError::new(kind, code.as_str(), code.as_str());
        log_failure(COMMAND, &error);
        error
    })
}

/// The app's one bridge, made on first use; the helper sits beside the app binary.
fn eventkit(app: &AppHandle<Wry>) -> Result<Arc<EventKit>, CommandError> {
    if let Some(eventkit) = app.try_state::<Arc<EventKit>>() {
        return Ok(eventkit.inner().clone());
    }
    let exe = std::env::current_exe().map_err(|error| {
        CommandError::new(
            ErrorKind::Internal,
            "unavailable",
            format!("cannot locate the app binary: {error}"),
        )
    })?;
    app.manage(Arc::new(EventKit::new(
        std::env::consts::OS,
        EventKit::beside(&exe),
    )));
    // A concurrent first call may have managed its own first; both use the one that won.
    Ok(app.state::<Arc<EventKit>>().inner().clone())
}
