//! A webview process died. Every death is reported as a telemetry log event with the failure
//! reason as its error code, and never anything about the page. A page whose web content process
//! died is frozen (WebKit) or blank (WebView2): its flush waits end, and it is reloaded within the
//! budget of `memry_desktop::shell::web_crash`; past it, the startup-error window explains.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::Instant;

#[cfg(windows)]
use memry_desktop::shell::flush::BrowserPages;
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
/// ends releases the flush waits on the page and recovers it, and a new document stops the
/// flushes until it listens (`flush_ready`). A page that closes or starts a new document lets go
/// of its large-file leases. The only process-failure subscription on Windows and
/// Linux; macOS reports through the builder hook [`on_web_content_process_terminate`].
pub fn plugin() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new("memry-page-watch")
        .on_webview_ready(|webview| {
            if is_app_label(webview.label()) {
                #[cfg(any(windows, target_os = "linux"))]
                super::gpu::watch_process_failures(webview.app_handle(), &webview);
            }
        })
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Started) && is_app_label(webview.label()) {
                document_replaced(webview.app_handle(), webview.label());
                crate::commands::large_file::release_page(webview.app_handle(), webview.label());
            }
        })
        .on_event(|app, event| {
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } = event
            {
                forget(app, label);
                crate::commands::large_file::release_page(app, label);
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
/// The pages of each watched WebView2 browser process ([`watch_browser_exit`]).
#[cfg(windows)]
static BROWSER_PAGES: LazyLock<BrowserPages> = LazyLock::new(BrowserPages::default);
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
    crate::commands::editor::forget_window(app, label);
    if let Some(flush) = app.try_state::<FlushService>() {
        let released = flush.page_gone(label);
        tracing::warn!(
            scope = "Shell",
            "the page of window {label} lost its process; {released} flush waits released"
        );
    }
}

/// Releases the flush waits on the pages of the WebView2 browser process `pid` the moment it ends.
/// `ProcessFailed` reports the same death, but WebView2 raises it on the main thread, with no bound
/// on how late: on a loaded arm64 runner it had not come 2.2 s after the browser ended at a
/// sign-out, and the quit's flush waited its full 2 s on a page that was gone (#3940). A thread
/// blocked on the process handle hears the exit itself. One thread per browser process, which
/// every app window of the profile shares.
#[cfg(windows)]
pub fn watch_browser_exit(app: &AppHandle<Wry>, label: &str, pid: u32) {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Threading::{
        INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };

    if !BROWSER_PAGES.host(pid, label) {
        return;
    }
    // SAFETY: plain Win32 call; the thread below closes the handle.
    let process = match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) } {
        Ok(process) => process,
        Err(error) => {
            BROWSER_PAGES.ended(pid);
            tracing::warn!(
                scope = "Shell",
                "the WebView2 browser process {pid} is not watched: {error}"
            );
            return;
        }
    };
    // A `HANDLE` is not `Send`; the thread owns it from here.
    let raw = process.0 as isize;
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("webview2-browser-exit".into())
        .spawn(move || {
            let process = HANDLE(raw as *mut _);
            // SAFETY: the handle opened above, waited on and closed only here.
            unsafe {
                WaitForSingleObject(process, INFINITE);
                let _ = CloseHandle(process);
            }
            tracing::warn!(scope = "Shell", "the WebView2 browser process {pid} ended");
            for label in BROWSER_PAGES.ended(pid) {
                page_gone(&app, &label);
            }
        });
    if let Err(error) = spawned {
        BROWSER_PAGES.ended(pid);
        // SAFETY: the handle opened above; the thread that would own it never started.
        let _ = unsafe { CloseHandle(HANDLE(raw as *mut _)) };
        tracing::warn!(
            scope = "Shell",
            "the WebView2 browser process {pid} is not watched: {error}"
        );
    }
}

/// A new document replaced the page of window `label` (a reload, a recovery). The old one cannot
/// answer any more, and the new one answers once it subscribed, which a quit while it loads must
/// not wait for: it holds no edits yet.
fn document_replaced(app: &AppHandle<Wry>, label: &str) {
    crate::commands::editor::forget_window(app, label);
    if let Some(flush) = app.try_state::<FlushService>() {
        let released = flush.page_gone(label);
        if released > 0 {
            tracing::warn!(
                scope = "Shell",
                "the page of window {label} was replaced; {released} flush waits released"
            );
        }
    }
}

/// Window `label` is gone: a later window of that label starts with a full budget and nothing to
/// tell, is not asked to flush until its page listens, and its browser's exit no longer marks it
/// gone.
fn forget(app: &AppHandle<Wry>, label: &str) {
    if let Some(flush) = app.try_state::<FlushService>() {
        flush.page_gone(label);
    }
    let mut recovery = RECOVERY.lock().unwrap_or_else(PoisonError::into_inner);
    recovery.budgets.remove(label);
    recovery.reloaded.remove(label);
    #[cfg(windows)]
    BROWSER_PAGES.forget(label);
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
