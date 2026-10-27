//! The one app-level `on_window_event`. It feeds the bounds persister and the focus tracker,
//! then runs the close handlers other steps register. No other code installs its own window
//! event listener.

use std::sync::{Arc, Mutex, PoisonError};

use tauri::{AppHandle, CloseRequestApi, Manager, Window, WindowEvent, Wry};

use super::MAIN_LABEL;
use super::bounds_store::BoundsPersister;
use super::registry::WindowKind;
use crate::shell::services;

/// Runs on `CloseRequested`; it may call `api.prevent_close()`.
pub type CloseRequestedHandler = Box<dyn Fn(&Window<Wry>, &CloseRequestApi) + Send + Sync>;

#[derive(Default)]
pub struct WindowEvents {
    close: Mutex<Vec<(Option<WindowKind>, CloseRequestedHandler)>>,
}

impl WindowEvents {
    /// Adds a close handler for windows of `kind` (every window when `None`). Handlers run in
    /// registration order.
    pub fn on_close_requested(&self, kind: Option<WindowKind>, handler: CloseRequestedHandler) {
        self.close
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((kind, handler));
    }

    fn run_close(&self, window: &Window<Wry>, api: &CloseRequestApi) {
        let kind = WindowKind::of_label(window.label());
        let handlers = self.close.lock().unwrap_or_else(PoisonError::into_inner);
        for (wanted, handler) in handlers.iter() {
            if wanted.is_none() || *wanted == kind {
                handler(window, api);
            }
        }
    }
}

/// Manages the dispatcher's state. Runs at the `Handlers` stage, before any window exists.
pub fn manage(app: &AppHandle<Wry>) {
    app.manage(WindowEvents::default());
    app.manage(Arc::new(BoundsPersister::default()));
}

pub fn dispatch(window: &Window<Wry>, event: &WindowEvent) {
    let app = window.app_handle();
    let is_main = window.label() == MAIN_LABEL;
    match event {
        WindowEvent::Focused(focused) if is_main => services::on_focus(app, *focused),
        WindowEvent::Resized(_) | WindowEvent::Moved(_) if is_main => {
            if let Some(persister) = app.try_state::<Arc<BoundsPersister>>() {
                // A minimized window reports a restored rectangle on Windows: write now,
                // while the last trustworthy state is still known.
                if window.is_minimized().unwrap_or(false) {
                    persister.flush(app);
                } else {
                    persister.changed(app);
                }
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            if is_main && let Some(persister) = app.try_state::<Arc<BoundsPersister>>() {
                persister.flush(app);
            }
            if let Some(events) = app.try_state::<WindowEvents>() {
                events.run_close(window, api);
            }
        }
        _ => {}
    }
}
