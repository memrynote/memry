//! The startup-error window (inv09#28), a port of `ensureStartupWindow`
//! (`apps/desktop/src/main/index.ts:1148-1177`). A startup stage that fails would otherwise
//! leave a process with no window that holds the single-instance lock, so every relaunch does
//! nothing. The window also shows when the main window's web content process keeps dying
//! (`guards::process_gone`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use memry_desktop::telemetry::diagnostics::Failure;
use tauri::{AppHandle, Manager, Wry};

use super::preboot::{self, PageFill};
use super::registry::WindowKind;
use crate::shell::services::telemetry;
use crate::startup::StageFailure;

/// The process exit code after a failed startup, once the user closed the window.
pub const EXIT_STARTUP_FAILED: i32 = 2;

/// Electron re-showed after 3 s because the failure that stopped startup can also stop the
/// first reveal.
const RESHOW_AFTER: Duration = Duration::from_secs(3);

static STARTUP_FAILED: AtomicBool = AtomicBool::new(false);

/// True once a startup stage failed: the app then runs only for this window, and the services
/// the quit sequence needs may not exist.
pub fn startup_failed() -> bool {
    STARTUP_FAILED.load(Ordering::SeqCst)
}

/// A startup stage failed. The startup-error window takes the place of any window the earlier
/// stages built, since the app behind it is half started.
pub fn on_startup_failure(app: &AppHandle<Wry>, failure: &StageFailure) {
    tracing::error!(
        stage = ?failure.stage,
        name = failure.name,
        "startup stage failed: {}",
        failure.error
    );
    eprintln!("startup stage {} failed: {}", failure.name, failure.error);
    if let Some(service) = telemetry(app) {
        service.track_main_error(
            "main_process",
            "startup_failed_no_window",
            &Failure::new(Some(&failure.error.code), failure.error.message.clone()),
        );
    }
    STARTUP_FAILED.store(true, Ordering::SeqCst);
    // Built first: with no window left at all, the runtime would ask to exit.
    show(app, &failure.error.to_string());
    let own = WindowKind::StartupError.label(0);
    for (label, window) in app.webview_windows() {
        if label != own
            && let Err(error) = window.destroy()
        {
            tracing::warn!(scope = "Window", "{label} not destroyed: {error}");
        }
    }
}

/// Shows the startup-error window with `details` under the localized title and body, or
/// brings the open one forward.
pub fn show(app: &AppHandle<Wry>, details: &str) {
    if let Some(window) = app.get_webview_window(&WindowKind::StartupError.label(0)) {
        if let Err(error) = window.show().and_then(|()| window.set_focus()) {
            tracing::warn!(scope = "Window", "startup-error window not raised: {error}");
        }
        return;
    }
    let locale = preboot::locale(app);
    let fill = PageFill {
        view: "error",
        slots: vec![
            ("title", preboot::text(locale, "startup.failed.title")),
            ("body", preboot::text(locale, "startup.failed.body")),
            ("details", details.to_owned()),
        ],
    };
    let built = preboot::build(app, WindowKind::StartupError, fill, false, |builder| {
        builder.inner_size(460.0, 300.0).visible(true)
    });
    match built {
        Ok(window) => {
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(RESHOW_AFTER).await;
                // A window the user closed meanwhile answers with an error, which is fine.
                let _ = window.show();
            });
        }
        Err(error) => {
            tracing::error!(scope = "Window", "startup-error window not built: {error}");
            // Nothing else is left to show; a windowless process must not linger.
            if startup_failed() {
                std::process::exit(EXIT_STARTUP_FAILED);
            }
        }
    }
}
