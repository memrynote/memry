//! The startup-error window (inv09#28), a port of `ensureStartupWindow`
//! (`apps/desktop/src/main/index.ts:1148-1177`). A startup stage that fails would otherwise
//! leave a process with no window that holds the single-instance lock, so every relaunch does
//! nothing. The window also shows, with its own copy, when an app window's web content process
//! keeps dying (`guards::process_gone`); closing it then quits through the quit sequence.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use memry_desktop::i18n::{Arg, Args};
use memry_desktop::paths::AppPaths;
use memry_desktop::session::Session;
use memry_desktop::telemetry::diagnostics::Failure;
use tauri::{AppHandle, Manager, WindowEvent, Wry};

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
/// stages built, since the app behind it is half started, and a vault the earlier stages opened
/// is closed so nothing behind the window keeps writing to it.
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
    if let Some(session) = app.try_state::<Session>() {
        // A vault close must not flip a window to the vault picker. Off the main thread: the
        // close waits behind an open still running.
        session.begin_shutdown();
        let session = session.inner().clone();
        tauri::async_runtime::spawn_blocking(move || session.close());
    }
    // Built first: with no window left at all, the runtime would ask to exit.
    let locale = preboot::locale(app);
    show(
        app,
        vec![
            (
                "title",
                preboot::text(locale, "system:startup.failed.title", &Args::new()),
            ),
            (
                "body",
                preboot::text(locale, "system:startup.failed.body", &Args::new()),
            ),
            ("details", failure.error.to_string()),
            ("logs", log_folder(app, locale)),
        ],
    );
    let own = WindowKind::StartupError.label(0);
    for (label, window) in app.webview_windows() {
        if label != own
            && let Err(error) = window.destroy()
        {
            tracing::warn!(scope = "Window", "{label} not destroyed: {error}");
        }
    }
}

/// An app window lost its web content process more than its reloads allow (`count` times in a
/// minute, the last for `reason`). The window stays as it is, and closing this one quits.
pub fn show_crashed(app: &AppHandle<Wry>, count: usize, reason: &str) {
    let locale = preboot::locale(app);
    let details = Args::from([
        (
            "count".to_owned(),
            Arg::from(i64::try_from(count).unwrap_or(i64::MAX)),
        ),
        ("reason".to_owned(), Arg::from(reason)),
    ]);
    let shown = show(
        app,
        vec![
            (
                "title",
                preboot::text(locale, "system:startup.crashed.title", &Args::new()),
            ),
            (
                "body",
                preboot::text(locale, "system:startup.crashed.body", &Args::new()),
            ),
            (
                "details",
                preboot::text(locale, "system:startup.crashed.details", &details),
            ),
            ("logs", log_folder(app, locale)),
        ],
    );
    if let Some(window) = shown {
        let app = app.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                app.exit(0);
            }
        });
    }
}

/// Brings the startup-error window forward. False when there is none.
pub fn raise(app: &AppHandle<Wry>) -> bool {
    let Some(window) = app.get_webview_window(&WindowKind::StartupError.label(0)) else {
        return false;
    };
    if let Err(error) = window
        .unminimize()
        .and_then(|()| window.show())
        .and_then(|()| window.set_focus())
    {
        tracing::warn!(scope = "Window", "startup-error window not raised: {error}");
    }
    true
}

fn log_folder(app: &AppHandle<Wry>, locale: &str) -> String {
    let path = app
        .try_state::<AppPaths>()
        .map(|paths| paths.log_dir.display().to_string())
        .or_else(|| {
            app.path()
                .app_log_dir()
                .ok()
                .map(|dir| dir.display().to_string())
        })
        .unwrap_or_default();
    preboot::text(
        locale,
        "system:startup.logFolder",
        &Args::from([("path".to_owned(), Arg::from(path.as_str()))]),
    )
}

/// Shows the startup-error window filled with `slots`, or brings the open one forward. The new
/// window, when one was built.
fn show(
    app: &AppHandle<Wry>,
    slots: Vec<(&'static str, String)>,
) -> Option<tauri::WebviewWindow<Wry>> {
    if raise(app) {
        return None;
    }
    let fill = PageFill {
        view: "error",
        slots,
    };
    let built = preboot::build(app, WindowKind::StartupError, fill, false, |builder| {
        builder.inner_size(460.0, 320.0).visible(true)
    });
    match built {
        Ok(window) => {
            let shown = window.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(RESHOW_AFTER).await;
                // A window the user closed meanwhile answers with an error, which is fine.
                let _ = shown.show();
            });
            Some(window)
        }
        Err(error) => {
            tracing::error!(scope = "Window", "startup-error window not built: {error}");
            // Nothing else is left to show; a windowless process must not linger.
            if startup_failed() {
                std::process::exit(EXIT_STARTUP_FAILED);
            }
            None
        }
    }
}
