//! A webview process died. The report is a telemetry log event with the failure reason as its
//! error code, and never anything about the page.

use memry_desktop::telemetry::main_warning::Level;
use tauri::{AppHandle, Wry};

use crate::shell::services::telemetry;

/// Reports that a webview process ended for `reason` (`crash`, `unexpected`, `launch-failed`,
/// ...). Called by every platform's process-failure hook.
pub fn report(app: &AppHandle<Wry>, reason: &str) {
    tracing::error!(scope = "Shell", "webview process gone: {reason}");
    if let Some(service) = telemetry(app) {
        service.track_main_log(
            Level::Error,
            "Shell",
            "render_process_gone",
            Some(reason),
            None,
            None,
        );
    }
}
