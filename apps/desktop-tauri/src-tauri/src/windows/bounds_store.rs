//! Persists the main window's geometry to `windowBounds` in `memry-config.json`: the debounce
//! and the read of the window's state around the pure rules in `memry_desktop::shell::bounds`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use memry_desktop::registry::{AppConfig, ConfigError};
use memry_desktop::session::Session;
use memry_desktop::shell::bounds::{
    BoundsTracker, PERSIST_DELAY_MS, Rect, StoredWindowBounds, WindowState,
};
use tauri::{AppHandle, Manager, Wry};

use super::MAIN_LABEL;

const KEY: &str = "windowBounds";

#[derive(Default)]
pub struct BoundsPersister {
    tracker: Mutex<BoundsTracker>,
    generation: AtomicU64,
}

/// The window's state in logical units. Size is the inner size, which is what the builder
/// applies on the next launch.
pub fn window_state(window: &tauri::WebviewWindow<Wry>) -> Option<WindowState> {
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(WindowState {
        minimized: window.is_minimized().ok()?,
        visible: window.is_visible().ok()?,
        maximized: window.is_maximized().ok()?,
        full_screen: window.is_fullscreen().ok()?,
        bounds: Rect {
            x: position.x.round() as i32,
            y: position.y.round() as i32,
            width: size.width.round() as i32,
            height: size.height.round() as i32,
        },
    })
}

pub fn saved(config: &AppConfig) -> Option<StoredWindowBounds> {
    config.read(|map| {
        map.get(KEY)
            .and_then(|value| serde_json::from_value(value.clone()).ok())
    })
}

impl BoundsPersister {
    /// Feeds a resize or move, then queues the trailing write.
    pub fn changed(self: &Arc<Self>, app: &AppHandle<Wry>) {
        if let Some(state) = self.main_state(app) {
            self.lock().observe(state);
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let this = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(PERSIST_DELAY_MS)).await;
            if this.generation.load(Ordering::SeqCst) == generation {
                this.persist(&app);
            }
        });
    }

    /// Cancels the pending write and writes now (close, minimize).
    pub fn flush(&self, app: &AppHandle<Wry>) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.persist(app);
    }

    /// Remembers the state the window opened with, so a window that opens maximized still
    /// knows its normal rectangle.
    pub fn observe(&self, app: &AppHandle<Wry>) {
        if let Some(state) = self.main_state(app) {
            self.lock().observe(state);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BoundsTracker> {
        self.tracker.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn main_state(&self, app: &AppHandle<Wry>) -> Option<WindowState> {
        window_state(&app.get_webview_window(MAIN_LABEL)?)
    }

    fn persist(&self, app: &AppHandle<Wry>) {
        // The picker never persists geometry.
        let open = app
            .try_state::<Session>()
            .is_some_and(|session| session.status().is_open);
        if !open {
            return;
        }
        let Some(state) = self.main_state(app) else {
            return;
        };
        let Some(capture) = self.lock().capture(state) else {
            return;
        };
        let Some(config) = app.try_state::<Arc<AppConfig>>() else {
            return;
        };
        let written = config.update::<_, ConfigError>(|map| {
            let mut stored = map
                .get(KEY)
                .and_then(|value| serde_json::from_value::<StoredWindowBounds>(value.clone()).ok())
                .unwrap_or_default();
            stored.apply(capture);
            map.insert(
                KEY.to_owned(),
                serde_json::to_value(&stored).unwrap_or_default(),
            );
            Ok(())
        });
        if let Err(error) = written {
            self.lock().write_failed();
            tracing::warn!(scope = "Window", "window bounds were not saved: {error}");
        }
    }
}
