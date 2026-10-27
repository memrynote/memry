//! Keeps every window's main frame on the app and routes links out of it: the adapter of
//! `memry_desktop::shell::frame_nav`.
//!
//! The main frame is decided before it commits a document, so no page outside the app ever runs
//! in the window. A page that ran could cancel the way back with `window.stop()`, chain
//! `location.replace` hops that each reach the OS browser, or open windows. Per engine:
//! - WebView2 reports top-level navigations only, so [`on_navigation`] decides them.
//! - WKWebView reports every frame's navigation, and wry hands its handler the URL alone.
//!   `macos::install` decides the main frame's navigations ahead of wry, from the navigation
//!   action's target frame, before the request is made.
//! - WebKitGTK reports every frame's navigation too, and no navigation API says which frame asks.
//!   `linux::install` hands the link to the OS at the main frame's load start (`load-changed`
//!   STARTED, main frame only, before any response) and refuses the main resource's response
//!   unless it is the app's (`is_main_frame_main_resource`), so nothing else commits.
//!
//! On WKWebView and WebKitGTK [`on_navigation`] therefore answers for the frames of a note's
//! embeds, which load in place and never reach the OS. [`check_commit`] stays behind all of this as
//! defence in depth.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use memry_desktop::shell::frame_nav::{
    Guard, Navigation, decide_main, frame_may_load, is_app_page,
};
use tauri::webview::PageLoadEvent;
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Manager, WebviewWindow, Wry};
use url::Url;

use super::{external, loopback, permissions};

/// The origins of the app's own pages: `tauri://localhost`, `https://tauri.localhost` (Windows,
/// fixed by `use_https_scheme`) and, in `tauri dev`, the dev server.
pub fn app_origins(app: &AppHandle<Wry>) -> Vec<String> {
    let mut origins = vec![
        "tauri://localhost".to_owned(),
        "https://tauri.localhost".to_owned(),
    ];
    origins.extend(permissions::dev_origin(app));
    origins
}

/// The origin the main window's page has: the dev server in `tauri dev`, else the packaged app's.
pub fn page_origin(app: &AppHandle<Wry>) -> String {
    permissions::dev_origin(app).unwrap_or_else(|| {
        if cfg!(windows) {
            "https://tauri.localhost".to_owned()
        } else {
            "tauri://localhost".to_owned()
        }
    })
}

/// Set while a window's main frame shows a page outside the app, which only a pre-commit guard
/// that failed lets happen. While it is set the window goes nowhere but back to the app and hands
/// nothing more to the OS, so the page cannot chain hops or open windows.
#[derive(Debug, Clone, Default)]
pub struct OffApp(Arc<AtomicBool>);

impl OffApp {
    fn is_set(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// True when the flag was clear: this is the first page off the app.
    fn set(&self) -> bool {
        !self.0.swap(true, Ordering::SeqCst)
    }

    fn clear(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn act(app: &AppHandle<Wry>, url: &str, decision: Navigation) {
    let result = match decision {
        Navigation::OpenExternal => external::open_url(app, url),
        Navigation::OpenFile => external::open_memry_file(app, url),
        Navigation::Allow | Navigation::Deny => return,
    };
    if let Err(error) = result {
        tracing::warn!(scope = "Navigation", "a link was not opened: {error:?}");
    }
}

/// The loopback origin once the server listens; the guard is built after startup's `Protocols`
/// stage, so it is set by then. A window built earlier simply has no embed page to allow.
fn with_guard<T>(app: &AppHandle<Wry>, origins: &[String], f: impl FnOnce(&Guard<'_>) -> T) -> T {
    let loopback_origin = loopback::origin(app);
    f(&Guard {
        app_origins: origins,
        loopback_origin: loopback_origin.as_deref(),
    })
}

/// The main frame is about to navigate to `raw`, or a page asks for a new window: hands a link
/// to the OS, and returns whether the navigation may go on.
#[cfg(target_os = "macos")]
fn main_frame_may_load(app: &AppHandle<Wry>, raw: &str) -> bool {
    let decision = with_guard(app, &app_origins(app), |guard| decide_main(raw, guard));
    act(app, raw, decision);
    decision == Navigation::Allow
}

/// Decides the main frame before it commits, where the navigation handler cannot (macOS, Linux).
pub fn install(app: &AppHandle<Wry>, window: &WebviewWindow<Wry>) {
    #[cfg(target_os = "macos")]
    macos::install(app, window);
    #[cfg(target_os = "linux")]
    linux::install(app, window);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let _ = (app, window);
}

/// `on_navigation`: true lets the webview navigate.
pub fn on_navigation(
    app: AppHandle<Wry>,
    off_app: OffApp,
) -> impl Fn(&Url) -> bool + Send + 'static {
    let origins = app_origins(&app);
    move |url| {
        if off_app.is_set() {
            return is_app_page(url.as_str(), &origins);
        }
        if cfg!(windows) {
            // Top-level navigations only.
            let decision = with_guard(&app, &origins, |guard| decide_main(url.as_str(), guard));
            act(&app, url.as_str(), decision);
            decision == Navigation::Allow
        } else {
            with_guard(&app, &origins, |guard| frame_may_load(url.as_str(), guard))
        }
    }
}

/// `on_new_window`: never a new webview window. A link goes to the OS as a main-frame navigation
/// would (on macOS the navigation action has decided it already, and nothing reaches here).
pub fn on_new_window(
    app: AppHandle<Wry>,
    off_app: OffApp,
) -> impl Fn(Url, NewWindowFeatures) -> NewWindowResponse<Wry> + Send + 'static {
    let origins = app_origins(&app);
    move |url, _features| {
        if !off_app.is_set() {
            let decision = with_guard(&app, &origins, |guard| decide_main(url.as_str(), guard));
            act(&app, url.as_str(), decision);
        }
        NewWindowResponse::Deny
    }
}

/// `on_page_load` of the main frame, behind the pre-commit guard: a page outside the app that
/// committed anyway (the guard failed to install, or an engine changed) is logged, the first one
/// is handed to the OS, and the window returns to the app. The return is sent again when the page
/// finishes, since the page's own `window.stop()` cancels a return sent at commit. It never gets the
/// shell's globals (`windows::scripts`) or a Tauri command (the capabilities name the app's origins).
pub fn check_commit(
    window: &WebviewWindow<Wry>,
    event: PageLoadEvent,
    url: &Url,
    off_app: &OffApp,
) {
    let app = window.app_handle();
    let origins = app_origins(app);
    if is_app_page(url.as_str(), &origins) {
        if event == PageLoadEvent::Started {
            off_app.clear();
        }
        return;
    }
    if event == PageLoadEvent::Started {
        tracing::error!(
            scope = "Navigation",
            "a page outside the app committed in the main frame; returning to the app"
        );
        if off_app.set() {
            let decision = with_guard(app, &origins, |guard| decide_main(url.as_str(), guard));
            act(app, url.as_str(), decision);
        }
    } else if !off_app.is_set() {
        return;
    }
    let home = format!("{}/", page_origin(app));
    match Url::parse(&home) {
        Ok(home) => {
            if let Err(error) = window.navigate(home) {
                tracing::warn!(
                    scope = "Navigation",
                    "the app page did not return: {error:?}"
                );
            }
        }
        Err(error) => tracing::warn!(scope = "Navigation", "no app page to return to: {error}"),
    }
}
