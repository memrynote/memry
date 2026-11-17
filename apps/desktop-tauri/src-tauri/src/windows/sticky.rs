//! The sticky capture window (`apps/desktop/src/main/stickies/sticky-window.ts`): frameless,
//! transparent and always on top, opened near the pointer by its own shortcut on the latest draft,
//! a draft the edge tab unfolds, or blank. Tucking hides it, or off macOS destroys it when no other
//! app window exists; the draft stays. The rules are `memry_desktop::sticky`; this is the window
//! adapter.

use std::sync::{Mutex, PoisonError};

use memry_desktop::shell::flush::FLUSH_WINDOW_TIMEOUT;
use memry_desktop::shell::shutdown::Deadline;
use memry_desktop::sticky::geometry::{self, INITIAL_HEIGHT, Rect, WIDTH};
use memry_desktop::sticky::session::{OpenRequest, Step, StickySession, Tuck};
use tauri::webview::{Color, PageLoadEvent};
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent, Wry,
};

use super::main_window::webview_profile;
use super::registry::is_app_label;
use super::scripts::{self, ShellGlobals};
use crate::commands::error::CommandError;
use crate::flush::FlushService;
use crate::shell::navigation_guard;
use crate::startup::{self, Stage};

pub const LABEL: &str = "sticky";

/// The app stays alive with no window and the Dock reopens it, so a hidden sticky keeps nothing
/// running that the user cannot reach.
const APP_OUTLIVES_WINDOWS: bool = cfg!(target_os = "macos");

#[derive(Default)]
pub struct StickyWindow {
    session: Mutex<StickySession>,
}

pub fn register_stages() {
    startup::register(Stage::Handlers, "manage the sticky window", manage);
}

fn manage(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    app.manage(StickyWindow::default());
    Ok(())
}

impl StickyWindow {
    fn lock(&self) -> std::sync::MutexGuard<'_, StickySession> {
        self.session.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The draft the open sticky shows (`sticky:get-session`).
    pub fn draft_id(&self) -> Option<String> {
        self.lock().draft_id()
    }
}

/// Opens the sticky for `request`. Callable from any thread, the shortcut handler included: the
/// draft list is read off the main thread and the window is built on it.
pub fn open(app: &AppHandle<Wry>, request: OpenRequest) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let latest = match request {
            OpenRequest::Shortcut => latest_draft(&app),
            OpenRequest::Draft(_) => None,
        };
        let target = app.clone();
        if let Err(error) = app.run_on_main_thread(move || open_on_main(&target, request, latest)) {
            tracing::warn!(scope = "StickyWindow", "could not open the sticky: {error}");
        }
    });
}

fn latest_draft(app: &AppHandle<Wry>) -> Option<String> {
    match crate::commands::stickies::store(app).and_then(|store| {
        store
            .list()
            .map_err(|error| CommandError::from_core(&error))
    }) {
        Ok(drafts) => drafts.into_iter().next().map(|draft| draft.id),
        Err(error) => {
            tracing::warn!(scope = "StickyWindow", "could not read the drafts: {error}");
            None
        }
    }
}

fn open_on_main(app: &AppHandle<Wry>, request: OpenRequest, latest: Option<String>) {
    let existing = app.get_webview_window(LABEL);
    let step =
        app.state::<StickyWindow>()
            .lock()
            .request(request, latest.as_deref(), existing.is_some());
    let result = match (step, existing) {
        (Step::Defer, _) => Ok(()),
        (Step::Focus, Some(window)) => window.show().and_then(|()| window.set_focus()),
        // Its page shows and focuses it once loaded.
        (Step::Reload, Some(window)) => reload(app, &window),
        (Step::Replace, Some(window)) => {
            replace(app, window);
            Ok(())
        }
        (Step::Build, _) | (Step::Focus | Step::Reload | Step::Replace, None) => {
            build(app).map(drop)
        }
    };
    if let Err(error) = result {
        tracing::warn!(scope = "StickyWindow", "could not open the sticky: {error}");
        if step != Step::Focus {
            app.state::<StickyWindow>().lock().closed();
        }
    }
}

/// The sticky on screen gives way to another draft: its page writes its pending text (the 400 ms
/// debounce), then loads the new draft. A page that does not answer is logged by the flush and
/// replaced anyway, as the user asked.
fn replace(app: &AppHandle<Wry>, window: WebviewWindow<Wry>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        app.state::<FlushService>()
            .request(&app, LABEL, Deadline::after(FLUSH_WINDOW_TIMEOUT))
            .await;
        let target = app.clone();
        let scheduled = app.run_on_main_thread(move || {
            if let Err(error) = reload(&target, &window) {
                tracing::warn!(scope = "StickyWindow", "could not open the sticky: {error}");
                target.state::<StickyWindow>().lock().closed();
            }
        });
        if let Err(error) = scheduled {
            tracing::warn!(scope = "StickyWindow", "could not open the sticky: {error}");
        }
    });
}

/// A fresh page on the session's draft, placed and sized as a new sticky is.
fn reload(app: &AppHandle<Wry>, window: &WebviewWindow<Wry>) -> tauri::Result<()> {
    window.set_size(LogicalSize::new(WIDTH, INITIAL_HEIGHT))?;
    if let Some(position) = near_cursor(app) {
        window.set_position(position)?;
    }
    window.reload()
}

fn build(app: &AppHandle<Wry>) -> tauri::Result<WebviewWindow<Wry>> {
    let origins = navigation_guard::app_origins(app);
    let off_app = navigation_guard::OffApp::default();
    let (loopback_origin, loopback_token) =
        crate::shell::loopback::address(app).unwrap_or_default();
    let globals = ShellGlobals {
        maximizable: false,
        loopback_origin,
        loopback_token,
    };
    let state = crate::shell::services::startup_state(app);
    let builder =
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html#/sticky".into()))
            .title("Sticky")
            .inner_size(WIDTH, INITIAL_HEIGHT)
            .always_on_top(true)
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .visible(false)
            .transparent(true)
            .shadow(false)
            .background_color(Color(0, 0, 0, 0))
            .use_https_scheme(true)
            .disable_drag_drop_handler()
            // Not at first paint: on Windows a hidden transparent window never paints, so the
            // shortcut would seem to do nothing (`af1c3517f2`).
            .on_page_load(|window, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished)
                    && window.state::<StickyWindow>().lock().shows_on_load()
                    && let Err(error) = window.show().and_then(|()| window.set_focus())
                {
                    tracing::warn!(scope = "StickyWindow", "could not show the sticky: {error}");
                }
            })
            .on_navigation(navigation_guard::on_navigation(
                app.clone(),
                off_app.clone(),
            ))
            .on_new_window(navigation_guard::on_new_window(app.clone(), off_app))
            .initialization_script(scripts::app_page_only(&origins, &startup::script(&state)))
            .initialization_script(scripts::app_page_only(
                &origins,
                &scripts::init_script(globals),
            ));
    let window = webview_profile(builder, app).build()?;
    if let Some(position) = near_cursor(app)
        && let Err(error) = window.set_position(position)
    {
        tracing::warn!(
            scope = "StickyWindow",
            "could not place the sticky: {error}"
        );
    }
    navigation_guard::install(app, &window);
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed)
            && let Some((request, latest)) = handle.state::<StickyWindow>().lock().destroyed()
        {
            open_after_removal(&handle, request, latest);
        }
    });
    Ok(window)
}

/// An open that waited for the old window: the runtime removes it after this `Destroyed`
/// listener returns, so the build is posted from a runtime thread to run after that.
/// `run_on_main_thread` called on the main thread would run at once, before the removal.
fn open_after_removal(app: &AppHandle<Wry>, request: OpenRequest, latest: Option<String>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let target = app.clone();
        let scheduled = app.run_on_main_thread(move || {
            // Destroying the last window asked the app to quit.
            if startup::shutdown_started() {
                tracing::info!(
                    scope = "StickyWindow",
                    "sticky not opened: the app is quitting"
                );
            } else {
                open_on_main(&target, request, latest);
            }
        });
        if let Err(error) = scheduled {
            tracing::warn!(scope = "StickyWindow", "could not open the sticky: {error}");
        }
    });
}

/// Another window that shows app content exists, besides the sticky and `except`.
fn other_app_window(app: &AppHandle<Wry>, except: &str) -> bool {
    app.webview_windows()
        .keys()
        .any(|label| label != LABEL && label != except && is_app_label(label))
}

fn destroy(app: &AppHandle<Wry>, window: &WebviewWindow<Wry>) {
    if let Err(error) = window.destroy() {
        tracing::error!(
            scope = "StickyWindow",
            "could not destroy the sticky: {error}"
        );
        app.state::<StickyWindow>().lock().closed();
    }
}

/// `placeNearCursor`, on the display under the cursor. `None` leaves the OS placement.
fn near_cursor(app: &AppHandle<Wry>) -> Option<PhysicalPosition<i32>> {
    let cursor = app.cursor_position().ok()?;
    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let area = monitor.work_area();
    let rect = Rect {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    };
    let (x, y) = geometry::place_near_cursor((cursor.x, cursor.y), rect, monitor.scale_factor());
    Some(PhysicalPosition::new(x, y))
}

/// Puts the sticky away (`tuckStickyWindow`): hidden, so the next open reuses the window (see
/// [`StickySession`]), or destroyed when it is the last app window off macOS, which ends the app
/// as Electron's `window-all-closed` does. It is forgotten first, so a shortcut in between opens
/// it again instead of focusing it.
pub fn tuck(app: &AppHandle<Wry>) {
    let others = other_app_window(app, LABEL);
    let tuck = app
        .state::<StickyWindow>()
        .lock()
        .tuck(others, APP_OUTLIVES_WINDOWS);
    let Some(window) = app.get_webview_window(LABEL) else {
        app.state::<StickyWindow>().lock().closed();
        return;
    };
    match tuck {
        Tuck::Destroy => destroy(app, &window),
        Tuck::Hide => {
            if let Err(error) = window.hide() {
                tracing::warn!(scope = "StickyWindow", "could not tuck the sticky: {error}");
            }
        }
    }
}

/// Window `label` was destroyed (`shutdown::on_window_destroyed`). When it was the last other app
/// window, a hidden sticky goes too off macOS: left alone it would keep the app running with no
/// way back to it.
pub fn on_window_destroyed(app: &AppHandle<Wry>, label: &str) {
    if label == LABEL || other_app_window(app, label) {
        return;
    }
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let release = app
        .try_state::<StickyWindow>()
        .is_some_and(|sticky| sticky.lock().last_other_window_gone(APP_OUTLIVES_WINDOWS));
    if release {
        destroy(app, &window);
    }
}

/// The renderer measured its card (`resizeStickyWindow`): 360 wide, the height clamped, the top
/// edge kept.
pub fn resize(app: &AppHandle<Wry>, height: f64) -> tauri::Result<()> {
    match app.get_webview_window(LABEL) {
        Some(window) => window.set_size(LogicalSize::new(WIDTH, geometry::clamp_height(height))),
        None => Ok(()),
    }
}
