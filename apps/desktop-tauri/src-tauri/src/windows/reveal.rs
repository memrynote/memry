//! Showing the main window. Tauri has no `ready-to-show`: the renderer calls
//! `shell_first_paint` from the first animation frame after React mounted, and a 10 s timer
//! reveals anyway so a page that never paints cannot leave an invisible window.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use memry_desktop::launch_timeline::{self, LaunchPhase};
use memry_desktop::shell::heartbeat::{BEAT_INTERVAL_MS, HeartbeatMonitor};
use tauri::{AppHandle, Manager, WebviewWindow, Wry};

use super::MAIN_LABEL;
use super::bounds_store::BoundsPersister;
use crate::shell::services::mark_phase;

const FALLBACK_MS: u64 = 10_000;

/// What to re-apply after `show`: Windows ignores `maximize` on a hidden window.
#[derive(Default)]
pub struct StartupMode {
    pub maximize: bool,
    pub full_screen: bool,
}

#[derive(Default)]
pub struct Reveal {
    shown: AtomicBool,
    mode: Mutex<StartupMode>,
    heartbeat: Mutex<(Option<Instant>, HeartbeatMonitor)>,
}

fn state(app: &AppHandle<Wry>) -> Arc<Reveal> {
    if let Some(existing) = app.try_state::<Arc<Reveal>>() {
        return existing.inner().clone();
    }
    app.manage(Arc::new(Reveal::default()));
    app.state::<Arc<Reveal>>().inner().clone()
}

/// Called once the main window exists: records what to apply at reveal and starts the timers.
pub fn arm(app: &AppHandle<Wry>, mode: StartupMode) {
    let reveal = state(app);
    *reveal.mode.lock().unwrap_or_else(PoisonError::into_inner) = mode;
    let for_timer = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(FALLBACK_MS)).await;
        if !state(&for_timer).shown.load(Ordering::SeqCst) {
            tracing::warn!(
                scope = "Window",
                "ready-to-show did not fire within 10s; revealing window as fallback"
            );
            crate::guards::gpu::record_reveal_fallback(&for_timer);
            show(&for_timer, "fallback");
        }
    });
    let for_watch = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(BEAT_INTERVAL_MS));
        loop {
            tick.tick().await;
            let reveal = state(&for_watch);
            let mut guard = reveal
                .heartbeat
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let Some(origin) = guard.0 else { continue };
            if guard.1.poll(elapsed_ms(origin)) {
                tracing::warn!(scope = "Window", "main window renderer unresponsive");
            }
        }
    });
}

fn elapsed_ms(origin: Instant) -> u64 {
    u64::try_from(origin.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Shows the main window once. `reason` is `shown` (first paint) or `fallback`.
pub fn show(app: &AppHandle<Wry>, reason: &str) {
    let reveal = state(app);
    if reveal.shown.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    if let Err(error) = window.show() {
        tracing::error!(
            scope = "Window",
            "the main window could not be shown: {error}"
        );
    }
    if let Some(persister) = app.try_state::<Arc<BoundsPersister>>() {
        persister.observe(app);
    }
    apply_mode(&reveal, &window);
    mark_phase(app, LaunchPhase::WindowShown);
    crate::updater::on_window_shown(app);
    tracing::info!(scope = "Window", "main window shown ({reason})");
    launch_timeline::global().report(reason);
}

fn apply_mode(reveal: &Reveal, window: &WebviewWindow<Wry>) {
    let mode = reveal.mode.lock().unwrap_or_else(PoisonError::into_inner);
    let result = if mode.full_screen {
        window.set_fullscreen(true)
    } else if mode.maximize {
        window.maximize()
    } else {
        Ok(())
    };
    if let Err(error) = result {
        tracing::warn!(
            scope = "Window",
            "the startup window mode was not applied: {error}"
        );
    }
}

/// The renderer painted its first frame (main window only).
pub fn first_paint(app: &AppHandle<Wry>, window: &WebviewWindow<Wry>) {
    if window.label() == MAIN_LABEL {
        mark_phase(app, LaunchPhase::WindowReadyToShow);
        show(app, "shown");
        // Links that arrived before the page could act on them are delivered now.
        crate::deep_link::on_first_paint(app);
    }
}

/// Liveness beat every 2 s from the main window's page.
pub fn heartbeat(app: &AppHandle<Wry>, window: &WebviewWindow<Wry>) {
    if window.label() != MAIN_LABEL {
        return;
    }
    let reveal = state(app);
    let mut guard = reveal
        .heartbeat
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let origin = *guard.0.get_or_insert_with(Instant::now);
    if let Some(duration_ms) = guard.1.beat(elapsed_ms(origin)) {
        tracing::warn!(
            scope = "Window",
            duration_ms,
            "main window renderer responsive again"
        );
    }
}
