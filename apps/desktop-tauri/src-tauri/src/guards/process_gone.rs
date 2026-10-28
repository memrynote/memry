//! A webview process died. The report is a telemetry log event with the failure reason as its
//! error code, and never anything about the page.

use memry_desktop::telemetry::main_warning::Level;
use tauri::plugin::TauriPlugin;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Wry};

use crate::flush::FlushService;
use crate::shell::services::telemetry;
use crate::windows::registry::is_app_label;

/// Watches the page of every app window, wherever the window is built: a webview process that
/// ends releases the flush waits on the page, and a page that finishes loading answers flushes
/// again.
pub fn plugin() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new("memry-page-watch")
        .on_webview_ready(|webview| {
            if is_app_label(webview.label()) {
                #[cfg(any(windows, target_os = "linux"))]
                super::gpu::watch_process_failures(webview.app_handle(), &webview);
            }
        })
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) && is_app_label(webview.label()) {
                page_loaded(webview.app_handle(), webview.label());
            }
        })
        .build()
}

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

/// The page of window `label` lost its process (the WebView2 browser or renderer process, or the
/// WebKit web process, ended). Nothing there can answer a flush any more, so the waits on it end
/// now instead of at their timeout: at a sign-out the OS ends these processes while the quit
/// sequence is still asking.
pub fn page_gone(app: &AppHandle<Wry>, label: &str) {
    if let Some(flush) = app.try_state::<FlushService>() {
        let released = flush.page_gone(label);
        tracing::warn!(
            scope = "Shell",
            "the page of window {label} lost its process; {released} flush waits released"
        );
    }
}

/// The page of window `label` finished loading, so it answers flush requests again.
fn page_loaded(app: &AppHandle<Wry>, label: &str) {
    if let Some(flush) = app.try_state::<FlushService>() {
        flush.page_loaded(label);
    }
}
