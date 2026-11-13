//! "Join the iPhone beta" (`apps/desktop/src/main/ipc/ios-beta-handlers.ts`). The request goes
//! through the pinned transport, as `feedback_submit` does; the renderer never reaches the sync
//! host.

use memry_desktop::config::RuntimeConfig;
use memry_desktop::seams::transport::SyncTransport;
use memry_desktop::telemetry::ios_beta::{self, IosBetaJoinInput, IosBetaJoinResult};
use tauri::{AppHandle, Manager, Wry};

use super::error::{CommandError, ErrorKind};
use crate::shell::services::telemetry;

/// Sent without the account's token until Step 19 (#3536) provides the session token.
#[tauri::command]
#[specta::specta]
pub async fn ios_beta_join(
    app: AppHandle<Wry>,
    input: IosBetaJoinInput,
) -> Result<IosBetaJoinResult, CommandError> {
    let service = telemetry(&app).ok_or_else(|| {
        CommandError::new(
            ErrorKind::Internal,
            "telemetry_not_initialized",
            "Telemetry has not started",
        )
    })?;
    let url = app.state::<RuntimeConfig>().server_url("/ios-beta/join");
    Ok(ios_beta::join(app.state::<SyncTransport>().as_ref(), &url, input, &service).await)
}
