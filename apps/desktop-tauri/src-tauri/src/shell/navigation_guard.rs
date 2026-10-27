//! Keeps every window's main frame on the app and routes links out of it: the adapter of
//! `memry_desktop::shell::frame_nav`. Tauri reports main-frame navigations only; a subframe is
//! held by the CSP `frame-src` and by the embed's sandbox.

use memry_desktop::shell::frame_nav::{Navigation, decide};
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Wry};
use url::Url;

use super::{external, permissions};

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

/// `on_navigation`: true lets the webview navigate.
pub fn on_navigation(app: AppHandle<Wry>) -> impl Fn(&Url) -> bool + Send + 'static {
    let origins = app_origins(&app);
    move |url| {
        let decision = decide(url.as_str(), None, &origins);
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
        let decision = decide(url.as_str(), None, &origins);
        act(&app, &url, decision);
        NewWindowResponse::Deny
    }
}
