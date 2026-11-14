//! "Join the iPhone beta" (`apps/desktop/src/main/ipc/ios-beta-handlers.ts`). The request goes
//! through the pinned transport, as `feedback_submit` does; the renderer never reaches the sync
//! host.

use std::sync::Arc;

use memry_desktop::account::AccountService;
use memry_desktop::config::RuntimeConfig;
use memry_desktop::seams::transport::SyncTransport;
use memry_desktop::telemetry::ios_beta::{self, IosBetaJoinInput, IosBetaJoinResult};
use tauri::{AppHandle, Manager, Wry};

use super::error::{CommandError, ErrorKind};
use crate::shell::services::telemetry;

/// With the account's token when signed in.
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
    let bearer = app
        .state::<Arc<AccountService>>()
        .access_token_if_signed_in()
        .await;
    Ok(ios_beta::join(
        app.state::<SyncTransport>().as_ref(),
        &url,
        input,
        &service,
        bearer.as_deref(),
    )
    .await)
}
