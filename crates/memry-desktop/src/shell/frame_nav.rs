//! What a navigation of the main frame does: port of `decideFrameNavigation`
//! (`apps/desktop/src/main/lib/frame-navigation.ts`).
//!
//! The main frame stays on the app's own origin. A link to the web or to a mail address goes to
//! the OS. A file of the app goes to the OS too, because replacing the page with the scheme's
//! raw bytes would trap the window. Everything else is refused. Tauri reports the main frame
//! only (a subframe's navigation is decided by the CSP `frame-src`), so there is no subframe
//! branch here.

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

/// `memry-file:` itself, or the `https://memry-file.localhost` form Windows and Linux use.
fn is_scheme_url(url: &Url, scheme: LocalScheme) -> bool {
    url.scheme() == scheme.name()
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some(scheme.webview_host()))
}

/// `app_origins` are the origins of the app's own pages (`tauri://localhost`,
/// `https://tauri.localhost`, and the dev server in dev), serialized as `scheme://host[:port]`.
/// `current` is the page the window shows now, if known.
pub fn decide(raw: &str, current: Option<&str>, app_origins: &[String]) -> Navigation {
    let Some(target) = raw
        .len()
        .le(&(16 * 1024))
        .then(|| Url::parse(raw).ok())
        .flatten()
    else {
        return Navigation::Deny;
    };
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
    if app_origins.contains(&origin_of(&target)) {
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
