//! A webview process died. Every death is reported as a telemetry log event with the failure
//! reason as its error code, and never anything about the page. A page whose web content process
//! died is frozen (WebKit) or blank (WebView2): its flush waits end, and it is reloaded within the
//! budget of `memry_desktop::shell::web_crash`; past it, the startup-error window explains.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::Instant;

use memry_desktop::shell::web_crash::{CrashAction, MAX_RELOADS, ReloadBudget};
use memry_desktop::telemetry::main_warning::Level;
use tauri::plugin::TauriPlugin;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, Webview, WindowEvent, Wry};

use crate::flush::FlushService;
use crate::shell::services::telemetry;
use crate::windows::registry::is_app_label;
use crate::windows::startup_error;

/// Watches the page of every app window, wherever the window is built: a webview process that
/// ends releases the flush waits on the page and recovers it, and a page that finishes loading
/// answers flushes again. The only process-failure subscription on Windows and Linux; macOS
/// reports through the builder hook [`on_web_content_process_terminate`].
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
        .on_event(|_, event| {
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } = event
            {
                forget(label);
            }
        })
        .build()
}

/// The reload budget of each window, and the windows reloaded since their page last asked.
#[derive(Default)]
struct Recovery {
    budgets: HashMap<String, ReloadBudget>,
    reloaded: HashSet<String>,
}

static RECOVERY: LazyLock<Mutex<Recovery>> = LazyLock::new(Mutex::default);
static EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);

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

/// Window `label` is gone: a later window of that label starts with a full budget and nothing to
/// tell.
fn forget(label: &str) {
    let mut recovery = RECOVERY.lock().unwrap_or_else(PoisonError::into_inner);
    recovery.budgets.remove(label);
    recovery.reloaded.remove(label);
}

/// True once for a page that was reloaded after its web process died, so it can tell the user.
pub fn take_reloaded(label: &str) -> bool {
    RECOVERY
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .reloaded
        .remove(label)
}

/// The web content process of `webview` died for `reason`: reload the page, or show the
/// startup-error window once its reloads ran out. A webview built inside a WebView2 event
/// callback never finishes navigating (the re-entrancy wry warns about), and `run_on_main_thread`
/// called on the main thread runs at once, so the task is posted from a runtime thread: it runs
/// on the event loop after the platform callback that reported the death has returned.
pub fn recover(webview: Webview<Wry>, reason: &'static str) {
    tauri::async_runtime::spawn(async move { schedule_recovery(webview, reason) });
}

fn schedule_recovery(webview: Webview<Wry>, reason: &'static str) {
    let app = webview.app_handle().clone();
    let scheduled = app.clone().run_on_main_thread(move || {
        // Read here, not when the death was reported: a sign-out ends the webview processes
        // while the quit sequence runs, and the flag may have flipped since.
        let quitting = crate::startup::shutdown_started() || startup_error::startup_failed();
        let label = webview.label().to_owned();
        let now_ms = u64::try_from(EPOCH.elapsed().as_millis()).unwrap_or(u64::MAX);
        let action = {
            let mut recovery = RECOVERY.lock().unwrap_or_else(PoisonError::into_inner);
            let action = recovery
                .budgets
                .entry(label.clone())
                .or_default()
                .on_crash(now_ms, quitting);
            if action == CrashAction::Reload {
                recovery.reloaded.insert(label.clone());
            }
            action
        };
        match action {
            CrashAction::LeaveAlone => {
                tracing::info!(scope = "Shell", "{label} not reloaded: the app is quitting");
            }
            CrashAction::Reload => {
                tracing::warn!(
                    scope = "Shell",
                    "reloading {label} after its web process ended"
                );
                if let Err(error) = webview.reload() {
                    tracing::error!(scope = "Shell", "{label} not reloaded: {error}");
                }
            }
            CrashAction::GiveUp => {
                tracing::error!(
                    scope = "Shell",
                    "{label} keeps losing its web process; reloads stopped"
                );
                startup_error::show_crashed(&app, MAX_RELOADS + 1, reason);
            }
        }
    });
    if let Err(error) = scheduled {
        tracing::error!(
            scope = "Shell",
            "web process recovery not scheduled: {error}"
        );
    }
}

/// WKWebView reports a web content process that ended, without a reason.
#[cfg(target_os = "macos")]
pub fn on_web_content_process_terminate(webview: &Webview<Wry>) {
    if !is_app_label(webview.label()) {
        return;
    }
    let app = webview.app_handle();
    report(app, "unknown");
    page_gone(app, webview.label());
    recover(webview.clone(), "unknown");
}
