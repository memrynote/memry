//! Page zoom of every app window. The factor is clamped and persisted by
//! `memry_desktop::startup_values`; this applies it to the live webviews.

use tauri::{AppHandle, Runtime, WebviewWindow};

use super::registry::WindowRegistry;

pub fn apply_to<R: Runtime>(window: &WebviewWindow<R>, factor: f64) {
    if let Err(error) = window.set_zoom(factor) {
        tracing::warn!(label = window.label(), "zoom was not applied: {error}");
    }
}

pub fn apply<R: Runtime>(app: &AppHandle<R>, factor: f64) {
    for window in WindowRegistry::app_windows(app) {
        apply_to(&window, factor);
    }
}
