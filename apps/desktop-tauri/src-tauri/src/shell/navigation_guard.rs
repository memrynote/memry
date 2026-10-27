//! Keeps every window's main frame on the app and routes links out of it: the adapter of
//! `memry_desktop::shell::frame_nav`. wry calls the handler for every frame on macOS and Linux and
//! for top-level navigations only on Windows; see `frame_nav` for what that changes.

use memry_desktop::shell::frame_nav::{Guard, Navigation, decide};
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Wry};
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
fn decide_for(app: &AppHandle<Wry>, origins: &[String], url: &Url) -> Navigation {
    let loopback_origin = loopback::origin(app);
    let guard = Guard {
        app_origins: origins,
        loopback_origin: loopback_origin.as_deref(),
        sees_subframes: !cfg!(windows),
    };
    decide(url.as_str(), None, &guard)
}

/// `on_navigation`: true lets the webview navigate.
pub fn on_navigation(app: AppHandle<Wry>) -> impl Fn(&Url) -> bool + Send + 'static {
    let origins = app_origins(&app);
    move |url| {
        let decision = decide_for(&app, &origins, url);
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
        let decision = decide_for(&app, &origins, &url);
        act(&app, &url, decision);
        NewWindowResponse::Deny
    }
}
