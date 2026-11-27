//! The edge tab (`apps/desktop/src/main/stickies/edge-tab.ts`): a small tab on the screen edge
//! that stands for the unsent drafts while the sticky is away. Hovering it fans the draft list
//! out; a click unfolds the sticky on a draft. The rules are `memry_desktop::sticky::edge_tab`;
//! this is the window adapter and what refreshes it.
//!
//! Like the sticky, the tab keeps one window: going away hides it and coming back loads its page
//! again, because a window rebuilt under the same label races the old one's teardown (wry
//! `WEBVIEW_STATE`). It is destroyed only with the last app window off macOS, so that the app can
//! quit (`closeEdgeTabWithLastAppWindow`).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use memry_desktop::session::Session;
use memry_desktop::settings::SettingsService;
use memry_desktop::sticky::edge_tab::{self, Edge};
use memry_desktop::sticky::geometry::Rect;
use serde_json::Value;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewWindow, WindowEvent, Wry};

use super::registry::is_app_label;
use super::sticky::{self, APP_OUTLIVES_WINDOWS, StickyWindow};
use crate::events::{StickyDraftsChangedEvent, broadcast, send_to};
use crate::shell::navigation_guard;
use crate::startup;

pub const LABEL: &str = "sticky-tab";

/// The display the tab opened on, kept until it goes away (`createTab`).
#[derive(Debug, Clone, Copy)]
struct Placement {
    area: Rect,
    scale: f64,
}

#[derive(Debug, Default)]
struct TabState {
    /// The tab is on screen, or its page is loading to show.
    shown: bool,
    peeking: bool,
    drafts: usize,
    edge: Edge,
    placement: Option<Placement>,
    /// `destroy` was called and `Destroyed` has not arrived: no window of this label is built.
    destroying: bool,
}

#[derive(Default)]
pub struct EdgeTab {
    state: Mutex<TabState>,
    /// A refresh is posted and has not read the drafts yet: a burst of writes is one refresh.
    scheduled: AtomicBool,
    /// The latest refresh; an older one that reads later is dropped.
    generation: AtomicU64,
}

impl EdgeTab {
    fn lock(&self) -> MutexGuard<'_, TabState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// What a refresh reads off the main thread.
struct Facts {
    drafts: usize,
    edge: Edge,
}

/// The draft list changed, by this device or by sync: every window re-reads it, and the tab
/// follows (`notifyStickyDraftsChanged`).
pub fn drafts_changed(app: &AppHandle<Wry>) {
    broadcast(app, StickyDraftsChangedEvent);
    refresh(app);
}

/// Shows, updates or hides the tab to match the drafts and the sticky (`refreshEdgeTab`), on a
/// later turn: the drafts are read off the main thread and the window is changed on it.
pub fn refresh(app: &AppHandle<Wry>) {
    let Some(tab) = app.try_state::<EdgeTab>() else {
        return;
    };
    if tab.scheduled.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let tab = app.state::<EdgeTab>();
        tab.scheduled.store(false, Ordering::SeqCst);
        let generation = tab.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let Some(facts) = read_facts(&app) else {
            return;
        };
        let target = app.clone();
        if let Err(error) = app.run_on_main_thread(move || apply(&target, generation, facts)) {
            tracing::warn!(scope = "StickyEdgeTab", "edge tab refresh failed: {error}");
        }
    });
}

/// The open vault's draft count and `sticky.tuckEdge`; no drafts while no vault is open. `None`
/// when the drafts cannot be read: the tab stays as it is.
fn read_facts(app: &AppHandle<Wry>) -> Option<Facts> {
    let Some(vault) = app
        .try_state::<Session>()
        .and_then(|session| session.current())
    else {
        return Some(Facts {
            drafts: 0,
            edge: Edge::default(),
        });
    };
    let drafts = crate::commands::stickies::store(app).and_then(|store| {
        store
            .list()
            .map_err(|error| crate::commands::error::CommandError::from_core(&error))
    });
    let drafts = match drafts {
        Ok(drafts) => drafts.len(),
        Err(error) => {
            tracing::error!(scope = "StickyEdgeTab", "edge tab refresh failed: {error}");
            return None;
        }
    };
    let edge = app
        .try_state::<SettingsService>()
        .and_then(|settings| settings.read_group(Some(&vault), "sticky").ok())
        .and_then(|read| {
            read.value
                .get("tuckEdge")
                .and_then(Value::as_str)
                .map(Edge::parse)
        })
        .unwrap_or_default();
    Some(Facts { drafts, edge })
}

/// What a refresh does to the window.
enum Change {
    Hide(WebviewWindow<Wry>),
    Update(WebviewWindow<Wry>),
    /// Back on screen: placed collapsed on the cursor's display, its page loaded again.
    Reappear(WebviewWindow<Wry>),
    Build,
    Nothing,
}

fn apply(app: &AppHandle<Wry>, generation: u64, facts: Facts) {
    let tab = app.state::<EdgeTab>();
    if startup::shutdown_started() || tab.generation.load(Ordering::SeqCst) != generation {
        return;
    }
    let sticky_open = app.state::<StickyWindow>().is_open();
    let app_window = app
        .webview_windows()
        .keys()
        .any(|label| label != sticky::LABEL && is_app_label(label));
    let show = edge_tab::should_show(sticky_open, facts.drafts, app_window, APP_OUTLIVES_WINDOWS);
    let window = app.get_webview_window(LABEL);
    let mut state = tab.lock();
    state.drafts = facts.drafts;
    state.edge = facts.edge;
    let change = match window {
        Some(window) if !show => Change::Hide(window),
        _ if !show || state.destroying => Change::Nothing,
        Some(window) if state.shown => Change::Update(window),
        Some(window) => Change::Reappear(window),
        None => Change::Build,
    };
    if matches!(change, Change::Hide(_)) {
        state.shown = false;
        state.peeking = false;
    }
    if matches!(change, Change::Reappear(_) | Change::Build) {
        state.shown = true;
        state.peeking = false;
        state.placement = cursor_display(app);
    }
    let result = match change {
        Change::Hide(window) => window.hide(),
        Change::Update(window) => place(&window, &state).map(|()| {
            send_to(app, LABEL, StickyDraftsChangedEvent);
        }),
        Change::Reappear(window) => place(&window, &state).and_then(|()| window.reload()),
        Change::Build => {
            drop(state);
            build(app).inspect_err(|_| tab.lock().shown = false)
        }
        Change::Nothing => Ok(()),
    };
    if let Err(error) = result {
        tracing::error!(scope = "StickyEdgeTab", "edge tab refresh failed: {error}");
    }
}

/// The work area of the display under the cursor, else the primary one.
fn cursor_display(app: &AppHandle<Wry>) -> Option<Placement> {
    let cursor = app.cursor_position().ok();
    let monitor = cursor
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let area = monitor.work_area();
    Some(Placement {
        area: Rect {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        },
        scale: monitor.scale_factor(),
    })
}

fn place(window: &WebviewWindow<Wry>, state: &TabState) -> tauri::Result<()> {
    let Some(placement) = state.placement else {
        return Ok(());
    };
    let bounds = edge_tab::bounds(
        placement.area,
        placement.scale,
        state.edge,
        state.peeking,
        state.drafts,
    );
    // The corner first: on another display the size is then read at that display's scale.
    window.set_position(PhysicalPosition::new(bounds.x, bounds.y))?;
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::WidgetExt;
        // GTK holds a non-resizable window at its natural size, 200x200 for a page that requests
        // none (`NO_CONTENT_CHILD_NAT`), and `set_size` cannot take it below that. A size request
        // makes the window's natural size the tab's. Runs on the main thread, which owns GTK.
        window
            .gtk_window()?
            .set_size_request(bounds.width.round() as i32, bounds.height.round() as i32);
    }
    window.set_size(LogicalSize::new(bounds.width, bounds.height))
}

fn build(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let window = sticky::floating_page(app, LABEL, "sticky-tab")
        .title("Sticky drafts")
        .focused(false)
        .focusable(false)
        .minimizable(false)
        .maximizable(false)
        .closable(false)
        // The first click on the inactive tab unfolds a draft instead of only activating it.
        .accept_first_mouse(true)
        .visible_on_all_workspaces(true)
        // Shown after load, never focused (`showInactive` on `did-finish-load`).
        .on_page_load(|window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished)
                && window.state::<EdgeTab>().lock().shown
            {
                show_inactive(&window);
            }
        })
        .build()?;
    #[cfg(target_os = "macos")]
    {
        super::mac_window::float_on_every_space(&window);
        super::mac_window::track_pointer_unfocused(&window);
    }
    {
        let tab = app.state::<EdgeTab>();
        let state = tab.lock();
        place(&window, &state)?;
    }
    navigation_guard::install(app, &window);
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let tab = handle.state::<EdgeTab>();
            let mut state = tab.lock();
            state.shown = false;
            state.peeking = false;
            state.placement = None;
            state.destroying = false;
        }
    });
    Ok(())
}

fn show_inactive(window: &WebviewWindow<Wry>) {
    #[cfg(target_os = "macos")]
    super::mac_window::show_inactive(window);
    #[cfg(not(target_os = "macos"))]
    if let Err(error) = window.show() {
        tracing::warn!(
            scope = "StickyEdgeTab",
            "could not show the edge tab: {error}"
        );
    }
}

/// Fans the draft list out on hover, and folds it back (`setEdgeTabPeek`).
pub fn peek(app: &AppHandle<Wry>, open: bool) -> tauri::Result<()> {
    let tab = app.state::<EdgeTab>();
    let mut state = tab.lock();
    if state.peeking == open {
        return Ok(());
    }
    state.peeking = open;
    match app.get_webview_window(LABEL) {
        Some(window) if state.shown => place(&window, &state),
        _ => Ok(()),
    }
}

/// Window `label` was destroyed (`shutdown::on_window_destroyed`). Off macOS the app quits with
/// its last window, and the tab, shown or hidden, would keep it running: it goes with the last
/// app window, a tucked sticky's included.
pub fn on_window_destroyed(app: &AppHandle<Wry>, label: &str) {
    if APP_OUTLIVES_WINDOWS || !is_app_label(label) {
        return;
    }
    let others = app
        .webview_windows()
        .keys()
        .any(|other| other != label && is_app_label(other));
    let Some(tab) = app.try_state::<EdgeTab>() else {
        return;
    };
    let Some(window) = app.get_webview_window(LABEL).filter(|_| !others) else {
        return;
    };
    {
        let mut state = tab.lock();
        state.shown = false;
        state.destroying = true;
    }
    if let Err(error) = window.destroy() {
        tracing::error!(
            scope = "StickyEdgeTab",
            "could not close the edge tab: {error}"
        );
        tab.lock().destroying = false;
    }
}
