//! Closing the main window: the renderer flushes its unsaved edits, the close hooks run, then
//! the window is destroyed. The close is held with `prevent_close` until then, so a window the
//! user closed never takes unwritten edits with it.

use std::sync::atomic::{AtomicBool, Ordering};

use memry_desktop::shell::close::CloseHooks;
use memry_desktop::shell::flush::FLUSH_WINDOW_TIMEOUT;
use memry_desktop::shell::shutdown::Deadline;
use memry_desktop::telemetry::diagnostics::Failure;
use tauri::{AppHandle, CloseRequestApi, Manager, Window, Wry};

use super::registry::WindowKind;
use crate::commands::error::CommandError;
use crate::flush::FlushService;
use crate::startup::{self, Stage};

/// A flush-and-close of the main window is in progress: a second request waits for it.
#[derive(Default)]
struct Closing(AtomicBool);

pub fn register_stages() {
    startup::register(Stage::Handlers, "register main window close", register);
}

fn register(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    app.manage(Closing::default());
    app.state::<super::events::WindowEvents>()
        .on_close_requested(Some(WindowKind::Main), Box::new(on_close_requested));
    Ok(())
}

fn on_close_requested(window: &Window<Wry>, api: &CloseRequestApi) {
    // The app is quitting: the sequence already flushed every window. A window the tray hides
    // is not closing, so nothing is flushed or destroyed.
    if startup::shutdown_started() || crate::tray::hides_on_close(window.app_handle()) {
        return;
    }
    api.prevent_close();
    let app = window.app_handle().clone();
    if app.state::<Closing>().0.swap(true, Ordering::SeqCst) {
        return;
    }
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        let flushed = app
            .state::<FlushService>()
            .request(&app, window.label(), Deadline::after(FLUSH_WINDOW_TIMEOUT))
            .await;
        let failures = app.state::<CloseHooks>().run_all().await;
        if !flushed || !failures.is_empty() {
            let detail = if failures.is_empty() {
                "the window did not answer the flush request".to_owned()
            } else {
                failures.join("; ")
            };
            tracing::error!(scope = "Shell", "window close flush failed: {detail}");
            if let Some(service) = crate::shell::services::telemetry(&app) {
                service.track_main_error(
                    "main_process",
                    "window_close_flush_failed",
                    &Failure::new(None, detail),
                );
            }
        }
        // The user asked to close: the window goes even when the flush did not finish.
        app.state::<Closing>().0.store(false, Ordering::SeqCst);
        if let Err(error) = window.destroy() {
            tracing::error!(scope = "Shell", "could not destroy the window: {error}");
        }
    });
}
