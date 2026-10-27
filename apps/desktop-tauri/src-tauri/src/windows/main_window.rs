use std::sync::Arc;

use memry_desktop::launch_timeline::LaunchPhase;
use memry_desktop::paths::AppPaths;
use memry_desktop::registry::AppConfig;
use memry_desktop::session::Session;
use memry_desktop::shell::bounds::{
    DEFAULT_MAIN_SIZE, PICKER_SIZE, PickerTransition, Rect, ResolvedBounds, picker_transition,
    resolve_startup_bounds,
};
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, LogicalSize, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};

use super::reveal::{self, StartupMode};
use super::{MAIN_LABEL, bounds_store, zoom};
use crate::shell::services::mark_phase;
use crate::startup::{self, StartupState};

/// Builds the main window, hidden: `windows::reveal` shows it at the renderer's first paint.
/// The webview profile lives under the instance's data dir, so two instances never share
/// localStorage. Sizes are logical (DIP), as Electron stored them. Chrome per OS belongs to
/// the next stage.
pub fn create_main(
    app: &AppHandle<Wry>,
    state: &StartupState,
) -> tauri::Result<WebviewWindow<Wry>> {
    let resolved = startup_bounds(app, state);
    let mut builder =
        WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("index.html".into()))
            .title("MemryNote")
            .visible(false)
            .inner_size(f64::from(resolved.width), f64::from(resolved.height))
            // Fixes the Windows origin to https://tauri.localhost for good; macOS and Linux
            // keep tauri://localhost.
            .use_https_scheme(true)
            // OS file drops arrive as DOM `File` objects.
            .disable_drag_drop_handler()
            .on_page_load(|window, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    mark_phase(window.app_handle(), LaunchPhase::WindowDidFinishLoad);
                }
            })
            .initialization_script(startup::script(state));
    builder = match resolved.position {
        Some((x, y)) => builder.position(f64::from(x), f64::from(y)),
        None => builder.center(),
    };
    let window = isolate_webview_profile(builder, &app.state::<AppPaths>()).build()?;
    zoom::apply_to(&window, state.zoom);
    reveal::arm(
        app,
        StartupMode {
            maximize: resolved.maximize,
            full_screen: resolved.full_screen,
        },
    );
    Ok(window)
}

/// The picker keeps its compact size and never restores geometry; the app window restores the
/// saved rectangle when it still lands on a display.
fn startup_bounds(app: &AppHandle<Wry>, state: &StartupState) -> ResolvedBounds {
    if state.startup_vault.is_none() {
        return ResolvedBounds {
            width: PICKER_SIZE.width,
            height: PICKER_SIZE.height,
            position: None,
            maximize: false,
            full_screen: false,
        };
    }
    let saved = app
        .try_state::<Arc<AppConfig>>()
        .and_then(|config| bounds_store::saved(&config));
    resolve_startup_bounds(saved.as_ref(), &work_areas(app), DEFAULT_MAIN_SIZE)
}

fn work_areas(app: &AppHandle<Wry>) -> Vec<Rect> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            let position = area.position.to_logical::<f64>(scale);
            let size = area.size.to_logical::<f64>(scale);
            Rect {
                x: position.x.round() as i32,
                y: position.y.round() as i32,
                width: size.width.round() as i32,
                height: size.height.round() as i32,
            }
        })
        .collect()
}

/// Grows the picker window to the app window when a vault opens and shrinks it back when the
/// vault closes (`apps/desktop/src/main/index.ts:845-875`).
pub fn on_vault_status(app: &AppHandle<Wry>, is_open: bool) {
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    let Some(state) = bounds_store::window_state(&window) else {
        return;
    };
    let switching = app
        .try_state::<Session>()
        .is_some_and(|session| session.is_switching());
    let saved = app
        .try_state::<Arc<AppConfig>>()
        .and_then(|config| bounds_store::saved(&config));
    let transition = picker_transition(
        is_open,
        switching,
        state.maximized,
        (state.bounds.width, state.bounds.height),
        saved.as_ref(),
    );
    let (size, maximize) = match transition {
        PickerTransition::None => return,
        PickerTransition::Grow { size, maximize } => (size, maximize),
        PickerTransition::ShrinkToPicker => (PICKER_SIZE, false),
    };
    let size = LogicalSize::new(f64::from(size.width), f64::from(size.height));
    if let Err(error) = window.set_size(size) {
        tracing::warn!(scope = "Window", "the window was not resized: {error}");
    }
    if maximize && let Err(error) = window.maximize() {
        tracing::warn!(scope = "Window", "the window was not maximized: {error}");
    }
}

#[cfg(any(windows, target_os = "linux"))]
fn isolate_webview_profile<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    paths: &AppPaths,
) -> WebviewWindowBuilder<'a, R, M> {
    builder.data_directory(paths.webview_dir())
}

// macOS 14 and later. Earlier systems ignore the identifier and share one store, which is why
// the e2e harness refuses to start two instances on macOS 13.
#[cfg(target_os = "macos")]
fn isolate_webview_profile<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    paths: &AppPaths,
) -> WebviewWindowBuilder<'a, R, M> {
    builder.data_store_identifier(paths.webview_store_id())
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn isolate_webview_profile<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    _paths: &AppPaths,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
}
