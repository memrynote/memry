//! Where a window's frames may go: port of `decideFrameNavigation`
//! (`apps/desktop/src/main/lib/frame-navigation.ts`).
//!
//! The main frame stays on the app's own origin. A link to the web or to a mail address goes to
//! the OS. A file of the app goes to the OS too, because replacing the page with the scheme's
//! raw bytes would trap the window. Everything else is refused ([`decide_main`]).
//!
//! A subframe (a note's `memry-html` embed, the loopback YouTube page, and whatever web page those
//! nest) loads what the CSP `frame-src` lets it and never hands anything to the OS, since a frame's
//! own load is not a link the user clicked ([`frame_may_load`]).
//!
//! Each engine reports frames differently, so the adapter (`shell::navigation_guard` in the
//! Tauri crate) asks these at different points. WebView2 reports top-level navigations only, so
//! its navigation handler asks [`decide_main`]. WKWebView and WebKitGTK report every frame's
//! navigation to wry's handler with the URL alone, so that handler asks [`frame_may_load`], and
//! the main frame is decided before anything commits: on WKWebView from the navigation action's
//! target frame, on WebKitGTK from the main resource's response policy ([`is_app_page`]).

use url::{Host, Url};

use super::external::is_allowed_external_url;
use super::local_scheme::LocalScheme;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Navigation {
    Allow,
    Deny,
    /// Hand the URL to the OS browser or mail client.
    OpenExternal,
    /// Hand the file a `memry-file:` URL names to the OS (after the root check).
    OpenFile,
}

/// A URL longer than this is not a navigation the app makes.
const MAX_URL_LEN: usize = 16 * 1024;

fn parse(raw: &str) -> Option<Url> {
    (raw.len() <= MAX_URL_LEN)
        .then(|| Url::parse(raw).ok())
        .flatten()
}

/// `scheme://host[:port]` of a URL. `url`'s own `origin()` is opaque for `tauri://`.
fn origin_of(url: &Url) -> String {
    let mut origin = format!("{}://{}", url.scheme(), url.host_str().unwrap_or(""));
    if let Some(port) = url.port() {
        origin.push_str(&format!(":{port}"));
    }
    origin
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => name == "localhost" || name.ends_with(".localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback() || ip.is_unspecified(),
        Some(Host::Ipv6(ip)) => ip.is_loopback() || ip.is_unspecified(),
        None => false,
    }
}

/// `memry-file:` itself, or the `https://memry-file.localhost` form WebView2 uses.
fn is_scheme_url(url: &Url, scheme: LocalScheme) -> bool {
    url.scheme() == scheme.name()
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some(scheme.webview_host()))
}

/// What the guard knows about the app.
#[derive(Debug, Clone, Copy)]
pub struct Guard<'a> {
    /// The origins of the app's own pages (`tauri://localhost`, `https://tauri.localhost`, and the
    /// dev server in dev), serialized as `scheme://host[:port]`.
    pub app_origins: &'a [String],
    /// The loopback server's origin, `http://127.0.0.1:<port>`, once it listens.
    pub loopback_origin: Option<&'a str>,
}

/// Whether a main frame showing `raw` shows the app: its origin is one of `app_origins`. A
/// `memry-html` or `memry-file` document is not the app even though Tauri counts every registered
/// scheme as local and would accept its commands.
pub fn is_app_page(raw: &str, app_origins: &[String]) -> bool {
    parse(raw).is_some_and(|url| app_origins.contains(&origin_of(&url)))
}

/// What a navigation of the main frame, or a request for a new window, does.
pub fn decide_main(raw: &str, guard: &Guard<'_>) -> Navigation {
    let Some(target) = parse(raw) else {
        return Navigation::Deny;
    };
    if guard.app_origins.contains(&origin_of(&target)) {
        return Navigation::Allow;
    }
    // An embed is a frame's document. In the main frame it would replace the app.
    if is_scheme_url(&target, LocalScheme::Html) {
        return Navigation::Deny;
    }
    if is_scheme_url(&target, LocalScheme::File) {
        return Navigation::OpenFile;
    }
    match target.scheme() {
        // Never hand a loopback URL to the OS browser.
        "http" | "https" if is_loopback(&target) => Navigation::Deny,
        "http" | "https" | "mailto" if is_allowed_external_url(raw) => Navigation::OpenExternal,
        // javascript:, data:, blob:, about:, file:, memry: (an OS deep link) and the rest.
        _ => Navigation::Deny,
    }
}

/// Whether a frame may load `raw`, on an engine whose navigation handler cannot say which frame
/// asked (WKWebView, WebKitGTK). The answer never sends anything to the OS: the main frame's own
/// decision comes from [`decide_main`] before its document commits.
pub fn frame_may_load(raw: &str, guard: &Guard<'_>) -> bool {
    let Some(target) = parse(raw) else {
        return false;
    };
    if guard.app_origins.contains(&origin_of(&target))
        || is_scheme_url(&target, LocalScheme::Html)
        // The scheme's handler refuses a frame's document load of a vault file itself.
        || is_scheme_url(&target, LocalScheme::File)
    {
        return true;
    }
    match target.scheme() {
        // Frames start as `about:blank` or `about:srcdoc`.
        "about" => true,
        // Of the loopback server, only its embed page is a frame's document.
        "http" | "https" if is_loopback(&target) => guard
            .loopback_origin
            .is_some_and(|origin| origin_of(&target) == origin && target.path().starts_with("/e/")),
        // A YouTube player, or a web page an HTML attachment nests: CSP `frame-src` decides.
        "http" | "https" => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests;
