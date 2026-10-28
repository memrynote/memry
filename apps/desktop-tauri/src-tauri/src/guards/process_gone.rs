//! A webview process died. Every death is reported as a telemetry log event with the failure
//! reason as its error code, and never anything about the page. A GPU process that died is
//! recorded for the GPU guard. A web content process that died left its window frozen (WebKit)
//! or blank (WebView2), so the page is reloaded, within the budget of
//! `memry_desktop::shell::web_crash`; past it, the startup-error window explains instead.

use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::Instant;

use memry_desktop::shell::web_crash::{CrashAction, MAX_RELOADS, ReloadBudget};
use memry_desktop::telemetry::main_warning::Level;
use tauri::{AppHandle, Manager, Webview, Wry};

use crate::shell::services::telemetry;

static BUDGET: Mutex<ReloadBudget> = Mutex::new(ReloadBudget::new());
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

/// The web content process of `webview` died for `reason`: reload the page, or show the
/// startup-error window once the reloads ran out. Runs on the event loop, outside the
/// platform callback that reported the death, since a new window must not be built inside one.
fn recover(webview: Webview<Wry>, reason: &'static str) {
    let app = webview.app_handle().clone();
    let scheduled = app.clone().run_on_main_thread(move || {
        let now_ms = u64::try_from(EPOCH.elapsed().as_millis()).unwrap_or(u64::MAX);
        let action = BUDGET
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .on_crash(now_ms);
        match action {
            CrashAction::Reload => {
                tracing::warn!(scope = "Shell", "reloading {} after its web process ended", webview.label());
                if let Err(error) = webview.reload() {
                    tracing::error!(scope = "Shell", "{} not reloaded: {error}", webview.label());
                }
            }
            CrashAction::GiveUp => {
                tracing::error!(scope = "Shell", "web process keeps ending; reloads stopped");
                crate::windows::startup_error::show(
                    &app,
                    &format!(
                        "The web content process ended ({reason}) more than {MAX_RELOADS} times in a minute."
                    ),
                );
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
    report(webview.app_handle(), "unknown");
    recover(webview.clone(), "unknown");
}

/// Subscribes to the main webview's process failures: every one is reported, a GPU process
/// that crashed, ended unexpectedly or failed to launch is recorded, and a page whose renderer
/// exited or hung is recovered.
#[cfg(windows)]
pub fn watch_process_failures(app: &AppHandle<Wry>, window: &tauri::WebviewWindow<Wry>) {
    use memry_desktop::shell::gpu_guard::GpuExit;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
        COREWEBVIEW2_PROCESS_FAILED_REASON, COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED,
        COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED,
        COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY,
        COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED,
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED,
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE, ICoreWebView2ProcessFailedEventArgs2,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows_core::Interface;

    let app = app.clone();
    let page = window.as_ref().clone();
    let result = window.with_webview(move |webview| {
        // SAFETY: the controller and its core are live COM objects owned by the webview, used on
        // the main thread that `with_webview` runs on.
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                tracing::warn!(
                    scope = "Shell",
                    "no WebView2 core; process failures go unreported"
                );
                return;
            };
            let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = Default::default();
                args.ProcessFailedKind(&mut kind)?;
                let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                let known = args
                    .cast::<ICoreWebView2ProcessFailedEventArgs2>()
                    .and_then(|args| args.Reason(&mut reason))
                    .is_ok();
                let (name, exit) = if !known {
                    ("unknown", None)
                } else if reason == COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED {
                    ("crash", Some(GpuExit::Crashed))
                } else if reason == COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED {
                    ("unexpected", Some(GpuExit::Unexpected))
                } else if reason == COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED {
                    ("launch-failed", Some(GpuExit::LaunchFailed))
                } else if reason == COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED {
                    ("terminated", Some(GpuExit::Terminated))
                } else if reason == COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY {
                    ("out-of-memory", Some(GpuExit::OutOfMemory))
                } else if reason == COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE {
                    ("unresponsive", None)
                } else {
                    ("unknown", None)
                };
                report(&app, name);
                if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED
                    && let Some(exit) = exit
                {
                    super::gpu::record(&app, exit);
                }
                // A frame's own renderer (an embed) dying leaves the page itself running.
                if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                    || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
                {
                    recover(page.clone(), name);
                }
                Ok(())
            }));
            let mut token = 0_i64;
            if let Err(error) = core.add_ProcessFailed(&handler, &mut token) {
                tracing::warn!(
                    scope = "Shell",
                    "could not subscribe to process failures: {error}"
                );
            }
        }
    });
    if let Err(error) = result {
        tracing::warn!(scope = "Shell", "could not reach the webview: {error}");
    }
}

/// WebKitGTK reports a web process that crashed, ran out of memory or was killed.
#[cfg(target_os = "linux")]
pub fn watch_process_failures(app: &AppHandle<Wry>, window: &tauri::WebviewWindow<Wry>) {
    use webkit2gtk::{WebProcessTerminationReason, WebViewExt};

    let app = app.clone();
    let page = window.as_ref().clone();
    let result = window.with_webview(move |webview| {
        webview
            .inner()
            .connect_web_process_terminated(move |_, reason| {
                let name = match reason {
                    WebProcessTerminationReason::Crashed => "crash",
                    WebProcessTerminationReason::ExceededMemoryLimit => "out-of-memory",
                    WebProcessTerminationReason::TerminatedByApi => "terminated",
                    _ => "unknown",
                };
                report(&app, name);
                recover(page.clone(), name);
            });
    });
    if let Err(error) = result {
        tracing::warn!(scope = "Shell", "could not reach the webview: {error}");
    }
}
