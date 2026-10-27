//! Keeps every window's main frame on the app and routes links out of it: the adapter of
//! `memry_desktop::shell::frame_nav`. wry calls the handler for every frame on macOS and Linux and
//! for top-level navigations only on Windows; see `frame_nav` for what that changes.

use memry_desktop::shell::frame_nav::{Guard, Navigation, decide, leaves_app};
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

fn act(app: &AppHandle<Wry>, url: &Url, decision: Navigation) {
    let result = match decision {
        Navigation::OpenExternal => external::open_url(app, url.as_str()),
        Navigation::OpenFile => external::open_memry_file(app, url.as_str()),
        Navigation::Allow | Navigation::Deny => return,
    };
    if let Err(error) = result {
        tracing::warn!(scope = "Navigation", "a link was not opened: {error:?}");
    }
}

/// The loopback origin once the server listens; the guard is built after startup's `Protocols`
/// stage, so it is set by then. A window built earlier simply has no embed page to allow.
fn decide_for(
    app: &AppHandle<Wry>,
    origins: &[String],
    url: &Url,
    sees_subframes: bool,
) -> Navigation {
    let loopback_origin = loopback::origin(app);
    let guard = Guard {
        app_origins: origins,
        loopback_origin: loopback_origin.as_deref(),
        sees_subframes,
    };
    decide(url.as_str(), None, &guard)
}

/// `on_navigation`: true lets the webview navigate.
pub fn on_navigation(app: AppHandle<Wry>) -> impl Fn(&Url) -> bool + Send + 'static {
    let origins = app_origins(&app);
    move |url| {
        // The engine reports subframes too (macOS, Linux), so this may be a frame's own load.
        let decision = decide_for(&app, &origins, url, !cfg!(windows));
        act(&app, url, decision);
        decision == Navigation::Allow
    }
}

/// `on_new_window`: never a new webview window. A link goes to the OS as a navigation would.
pub fn on_new_window(
    app: AppHandle<Wry>,
) -> impl Fn(Url, NewWindowFeatures) -> NewWindowResponse<Wry> + Send + 'static {
    let origins = app_origins(&app);
    move |url, _features| {
        // A new window is never a subframe's navigation: a link the user opened goes to the OS.
        let decision = decide_for(&app, &origins, &url, false);
        act(&app, &url, decision);
        NewWindowResponse::Deny
    }
}

/// Keeps the main frame on the app whatever started the navigation. The click listener of the
/// renderer and `on_navigation` cannot do it alone: on WKWebView and WebKitGTK the navigation
/// handler also sees the frames of a note's embed and so lets web pages through, while a native
/// "Open Link" menu entry, a link dragged in from a browser, a handler that stops propagation and a
/// script assigning `location` all bypass the listener. The page-load start is reported for the
/// main frame only (WKWebView reports it at commit, WebKitGTK at the provisional start). The link
/// goes to the OS and the window returns to the app, so a remote page stays on screen for a moment
/// at most. It never gets the shell's globals (`windows::scripts`) or a Tauri command (the
/// capabilities name the app's origins).
pub fn pin_main_frame(window: &WebviewWindow<Wry>, event: PageLoadEvent, url: &Url) {
    let app = window.app_handle();
    let origins = app_origins(app);
    if event != PageLoadEvent::Started || !leaves_app(url.as_str(), &origins) {
        return;
    }
    let decision = decide_for(app, &origins, url, false);
    act(app, url, decision);
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
