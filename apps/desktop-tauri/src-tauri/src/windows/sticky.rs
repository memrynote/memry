//! The sticky capture window (`apps/desktop/src/main/stickies/sticky-window.ts`): frameless,
//! transparent and always on top, opened near the pointer by its own shortcut on the latest draft,
//! a draft the edge tab unfolds, or blank. Tucking destroys it; the draft stays. The rules are
//! `memry_desktop::sticky`; this is the window adapter.

use std::sync::{Mutex, PoisonError};

use memry_desktop::sticky::geometry::{self, INITIAL_HEIGHT, Rect, WIDTH};
use memry_desktop::sticky::session::{OpenAction, OpenRequest, resolve};
use tauri::webview::{Color, PageLoadEvent};
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent, Wry,
};

use super::main_window::webview_profile;
use super::scripts::{self, ShellGlobals};
use crate::commands::error::CommandError;
use crate::shell::navigation_guard;
use crate::startup::{self, Stage};

pub const LABEL: &str = "sticky";

/// The draft the sticky shows, and which build of the window is on screen.
#[derive(Default)]
struct Session {
    draft_id: Option<String>,
    /// Bumped by every open, so the Destroyed event of a replaced window clears nothing.
    generation: u64,
    open: bool,
}

#[derive(Default)]
pub struct StickyWindow {
    session: Mutex<Session>,
}

pub fn register_stages() {
    startup::register(Stage::Handlers, "manage the sticky window", manage);
}

fn manage(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    app.manage(StickyWindow::default());
    Ok(())
}

impl StickyWindow {
    fn lock(&self) -> std::sync::MutexGuard<'_, Session> {
        self.session.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The draft the open sticky shows (`sticky:get-session`).
    pub fn draft_id(&self) -> Option<String> {
        self.lock().draft_id.clone()
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
        if let Err(error) = app.run_on_main_thread(move || open_on_main(&target, request, latest))
        {
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
    let state = app.state::<StickyWindow>();
    let mut session = state.lock();
    let on_screen = session.open.then_some(session.draft_id.as_deref());
    match resolve(request, on_screen, latest.as_deref()) {
        OpenAction::Focus => {
            drop(session);
            if let Some(window) = app.get_webview_window(LABEL)
                && let Err(error) = window.set_focus()
            {
                tracing::warn!(scope = "StickyWindow", "could not focus the sticky: {error}");
            }
        }
        OpenAction::Open { draft_id } => {
            session.draft_id = draft_id;
            session.generation += 1;
            session.open = true;
            let generation = session.generation;
            drop(session);
            match app.get_webview_window(LABEL) {
                // One that was replaced or is still closing: its label is free once the destroy
                // has run, which is before the next turn of the main thread.
                Some(old) => {
                    if let Err(error) = old.destroy() {
                        tracing::warn!(scope = "StickyWindow", "could not close the sticky: {error}");
                    }
                    let target = app.clone();
                    if let Err(error) =
                        app.run_on_main_thread(move || build_or_log(&target, generation))
                    {
                        tracing::warn!(scope = "StickyWindow", "could not open the sticky: {error}");
                    }
                }
                None => build_or_log(app, generation),
            }
        }
    }
}

fn build_or_log(app: &AppHandle<Wry>, generation: u64) {
    if let Err(error) = build(app, generation) {
        tracing::warn!(scope = "StickyWindow", "could not build the sticky: {error}");
        let state = app.state::<StickyWindow>();
        let mut session = state.lock();
        if session.generation == generation {
            session.open = false;
        }
    }
}

fn build(app: &AppHandle<Wry>, generation: u64) -> tauri::Result<WebviewWindow<Wry>> {
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
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    if let Err(error) = window.show().and_then(|()| window.set_focus()) {
                        tracing::warn!(scope = "StickyWindow", "could not show the sticky: {error}");
                    }
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
    if let Some(position) = near_cursor(app) {
        window.set_position(position)?;
    }
    navigation_guard::install(app, &window);
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let state = handle.state::<StickyWindow>();
            let mut session = state.lock();
            if session.generation == generation {
                session.open = false;
            }
        }
    });
    Ok(window)
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

/// Closes the sticky (`tuckStickyWindow`). It is forgotten before it finishes closing, so a
/// shortcut in between opens a new one instead of focusing the one on its way out.
pub fn tuck(app: &AppHandle<Wry>) {
    app.state::<StickyWindow>().lock().open = false;
    if let Some(window) = app.get_webview_window(LABEL)
        && let Err(error) = window.destroy()
    {
        tracing::warn!(scope = "StickyWindow", "could not tuck the sticky: {error}");
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
