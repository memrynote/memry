//! The incident report (Path B): the renderer previews a redacted report, the user consents, and
//! the same report is sent. The report carries redacted log lines and a device snapshot, never
//! note content.

use std::sync::Arc;

use memry_desktop::config::RuntimeConfig;
use memry_desktop::launch_timeline;
use memry_desktop::redact::{RedactOptions, salted_hash};
use memry_desktop::session::Session;
use memry_desktop::telemetry::logship::LogShip;
use memry_desktop::telemetry::report::{
    self, BuildInputs, DiagnosticReport, DiagnosticSnapshot, DiagnosticTrigger,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};

use super::error::{CommandError, ErrorKind};
use crate::shell::services::telemetry;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPreview {
    pub success: bool,
    pub report: Option<DiagnosticReport>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSendResult {
    pub success: bool,
    pub incident_id: Option<String>,
    pub error: Option<String>,
}

fn is_token(value: &str) -> bool {
    memry_desktop::redact::is_safe_token(value)
}

#[tauri::command]
#[specta::specta]
pub async fn diagnostics_preview_report(
    app: AppHandle<Wry>,
    trigger: DiagnosticTrigger,
) -> Result<DiagnosticPreview, CommandError> {
    let invalid = |error: &str| DiagnosticPreview {
        success: false,
        report: None,
        error: Some(error.to_owned()),
    };
    if !is_token(&trigger.source) || trigger.error_code.as_deref().is_some_and(|c| !is_token(c)) {
        return Ok(invalid("INVALID_TRIGGER"));
    }
    let Some(service) = telemetry(&app) else {
        return Ok(invalid("TELEMETRY_NOT_INITIALIZED"));
    };
    let context = service.context().clone();
    let snapshot = DiagnosticSnapshot {
        app_version: context.app_version.clone(),
        build_channel: context.build_channel.clone(),
        platform: context.platform.clone(),
        arch: context.arch.clone(),
        locale: service.locale(),
        uptime_seconds: launch_timeline::global().uptime_seconds().round(),
        sync_enabled: service.sync_state() == "enabled",
        sync_state: service.sync_state().to_owned(),
        queue_depth: 0,
        vault_open: app.state::<Session>().status().is_open,
        auth_state: service.auth_state().to_owned(),
    };
    let lines = app
        .try_state::<Arc<LogShip>>()
        .map(|ship| ship.recent_lines())
        .unwrap_or_default();
    let salt = service.config().diagnostics_salt();
    let hasher = |value: &str| salted_hash(&salt, value);
    let opts = RedactOptions {
        vault_root: None,
        hash: Some(&hasher),
    };
    let report = report::build_incident_report(
        &trigger,
        BuildInputs {
            incident_id: report::generate_incident_id(),
            context: &context,
            snapshot,
            recent_lines: lines,
            opts: &opts,
        },
    );
    Ok(DiagnosticPreview {
        success: true,
        report: Some(report),
        error: None,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn diagnostics_send_report(
    app: AppHandle<Wry>,
    report: DiagnosticReport,
) -> Result<DiagnosticSendResult, CommandError> {
    let fail = |error: &str| DiagnosticSendResult {
        success: false,
        incident_id: None,
        error: Some(error.to_owned()),
    };
    if !report::is_incident_id(&report.incident_id) || report.lines.len() > 200 {
        return Ok(fail("INVALID_REPORT"));
    }
    let url = app
        .state::<RuntimeConfig>()
        .server_url("/diagnostics/report");
    let body = serde_json::to_string(&report)
        .map_err(|e| CommandError::new(ErrorKind::Internal, "diagnostics_encode", e.to_string()))?;
    // Step 19 (#3536) adds the bearer so the server attributes the report to the account.
    match report::post_json(&url, body, None).await {
        Ok(()) => Ok(DiagnosticSendResult {
            success: true,
            incident_id: Some(report.incident_id),
            error: None,
        }),
        Err(error) => {
            tracing::error!(
                scope = "Diagnostics",
                "failed to send the incident report: {error}"
            );
            Ok(fail("SEND_FAILED"))
        }
    }
}
