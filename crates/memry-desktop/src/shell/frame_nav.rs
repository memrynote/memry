//! What a navigation of the main frame does: port of `decideFrameNavigation`
//! (`apps/desktop/src/main/lib/frame-navigation.ts`).
//!
//! The main frame stays on the app's own origin. A link to the web or to a mail address goes to
//! the OS. A file of the app goes to the OS too, because replacing the page with the scheme's
//! raw bytes would trap the window. Everything else is refused.
//!
//! WebView2 reports top-level navigations only. WKWebView and WebKitGTK report every frame's and
//! wry passes the URL alone (`wkwebview/navigation.rs`, `webkitgtk/mod.rs`), so the guard cannot
//! tell a subframe from the main frame there. [`Guard::sees_subframes`] says which engine this
//! is; on those engines the targets the app's own frames load (a `memry-html` embed, the
//! loopback YouTube page and the player it nests) are allowed instead of denied or sent to the OS
//! browser. The CSP `frame-src` still bounds what a frame may load, and no embed is allowed to
//! navigate the top frame (`sandbox` has no `allow-top-navigation`).

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

fn without_fragment(url: &Url) -> Url {
    let mut copy = url.clone();
    copy.set_fragment(None);
    copy
}

/// `memry-file:` itself, or the `https://memry-file.localhost` form WebView2 uses.
fn is_scheme_url(url: &Url, scheme: LocalScheme) -> bool {
    url.scheme() == scheme.name()
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some(scheme.webview_host()))
}

/// What the guard knows about the window and its engine.
#[derive(Debug, Clone, Copy)]
pub struct Guard<'a> {
    /// The origins of the app's own pages (`tauri://localhost`, `https://tauri.localhost`, and the
    /// dev server in dev), serialized as `scheme://host[:port]`.
    pub app_origins: &'a [String],
    /// The loopback server's origin, `http://127.0.0.1:<port>`, once it listens.
    pub loopback_origin: Option<&'a str>,
    /// True where the engine reports subframe navigations to the handler (macOS, Linux).
    pub sees_subframes: bool,
}

/// The page of the YouTube player the loopback embed page nests.
const YOUTUBE_PLAYER_PREFIX: &str = "https://www.youtube-nocookie.com/embed/";

/// Whether `target` is a page one of the app's own frames loads, on an engine that cannot say which
/// frame asked: a `memry-html` embed, the loopback embed page `/e/...`, and the player it nests.
fn is_own_frame_target(target: &Url, guard: &Guard<'_>) -> bool {
    if is_scheme_url(target, LocalScheme::Html) {
        return true;
    }
    if guard
        .loopback_origin
        .is_some_and(|origin| origin_of(target) == origin && target.path().starts_with("/e/"))
    {
        return true;
    }
    target.scheme() == "https" && target.as_str().starts_with(YOUTUBE_PLAYER_PREFIX)
}

/// `current` is the page the window shows now, if known.
pub fn decide(raw: &str, current: Option<&str>, guard: &Guard<'_>) -> Navigation {
    let Some(target) = raw
        .len()
        .le(&(16 * 1024))
        .then(|| Url::parse(raw).ok())
        .flatten()
    else {
        return Navigation::Deny;
    };
    if guard.sees_subframes && is_own_frame_target(&target, guard) {
        return Navigation::Allow;
    }
    // An embed is a frame's document. In the main frame it would replace the app.
    if is_scheme_url(&target, LocalScheme::Html) {
        return Navigation::Deny;
    }
    if is_scheme_url(&target, LocalScheme::File) {
        return Navigation::OpenFile;
    }
    if let Some(current) = current.and_then(|c| Url::parse(c).ok())
        && without_fragment(&current) == without_fragment(&target)
    {
        return Navigation::Allow;
    }
    if guard.app_origins.contains(&origin_of(&target)) {
        return Navigation::Allow;
    }
    match target.scheme() {
        // Never hand a loopback URL to the OS browser.
        "http" | "https" if is_loopback(&target) => Navigation::Deny,
        "http" | "https" | "mailto" if is_allowed_external_url(raw) => Navigation::OpenExternal,
        // javascript:, data:, blob:, about:, file:, memry: (an OS deep link) and the rest.
        _ => Navigation::Deny,
    }
}

#[cfg(test)]
mod tests;
