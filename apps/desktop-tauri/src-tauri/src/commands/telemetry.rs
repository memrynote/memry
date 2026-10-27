//! Telemetry and feedback commands. Opt-out semantics are the Electron app's: `enabled` is a
//! stored boolean, `autoSendDiagnostics` is on unless explicitly false, and nothing leaves the
//! device while telemetry is off.

use std::sync::Arc;

use memry_desktop::config::RuntimeConfig;
use memry_desktop::telemetry::TelemetryEvent;
use memry_desktop::telemetry::logship::LogShip;
use memry_desktop::telemetry::report::{self, FeedbackSubmit};
use memry_desktop::telemetry::service::{FlushReason, Service};
use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};

use super::error::{CommandError, ErrorKind};
use crate::shell::services::telemetry;

fn service(app: &AppHandle<Wry>) -> Result<Arc<Service>, CommandError> {
    telemetry(app).ok_or_else(|| {
        CommandError::new(
            ErrorKind::Internal,
            "telemetry_not_initialized",
            "Telemetry has not started",
        )
    })
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySettings {
    pub enabled: bool,
    pub auto_send_diagnostics: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryFlushResult {
    pub success: bool,
    pub attempted: u32,
    pub accepted: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSubmitResult {
    pub success: bool,
    pub error: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn telemetry_track(
    app: AppHandle<Wry>,
    event: TelemetryEvent,
) -> Result<(), CommandError> {
    service(&app)?.track(event);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn telemetry_flush(app: AppHandle<Wry>) -> Result<TelemetryFlushResult, CommandError> {
    let result = service(&app)?.flush(FlushReason::Manual).await;
    Ok(TelemetryFlushResult {
        success: result.success,
        attempted: u32::try_from(result.attempted).unwrap_or(u32::MAX),
        accepted: u32::try_from(result.accepted).unwrap_or(u32::MAX),
        error: result.error,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn telemetry_get_settings(
    app: AppHandle<Wry>,
) -> Result<TelemetrySettings, CommandError> {
    let service = service(&app)?;
    Ok(TelemetrySettings {
        enabled: service.enabled(),
        auto_send_diagnostics: service.config().auto_send_diagnostics(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn telemetry_set_enabled(app: AppHandle<Wry>, enabled: bool) -> Result<(), CommandError> {
    service(&app)?.set_enabled(enabled);
    if let Some(ship) = app.try_state::<Arc<LogShip>>() {
        ship.set_enabled(enabled);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn telemetry_set_auto_send_diagnostics(
    app: AppHandle<Wry>,
    enabled: bool,
) -> Result<(), CommandError> {
    service(&app)?.config().set_auto_send_diagnostics(enabled);
    Ok(())
}

/// Beta feedback, anonymous or with the account's token (Step 19, #3536, adds the bearer).
#[tauri::command]
#[specta::specta]
pub async fn feedback_submit(
    app: AppHandle<Wry>,
    input: FeedbackSubmit,
) -> Result<FeedbackSubmitResult, CommandError> {
    let fail = |error: String| FeedbackSubmitResult {
        success: false,
        error: Some(error),
    };
    let input = match input.validated() {
        Ok(input) => input,
        Err(code) => return Ok(fail(code.to_owned())),
    };
    let url = app.state::<RuntimeConfig>().server_url("/feedback");
    let body = serde_json::to_string(&input)
        .map_err(|e| CommandError::new(ErrorKind::Internal, "feedback_encode", e.to_string()))?;
    match report::post_json(&url, body, None).await {
        Ok(()) => Ok(FeedbackSubmitResult {
            success: true,
            error: None,
        }),
        Err(error) => {
            tracing::error!(scope = "Feedback", "failed to submit feedback: {error}");
            Ok(fail("FEEDBACK_SUBMIT_FAILED".to_owned()))
        }
    }
}
