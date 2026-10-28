//! The routes of the loopback media server: what a request path, a `Host` header and a token
//! mean. The server (`file_service` for the bytes, axum for the sockets) lives in the Tauri app;
//! every decision about untrusted input lives here so `cargo test` covers it without a socket.
//!
//! The server binds `127.0.0.1` on a random port and is reachable by any local process, and by
//! any web page through a DNS-rebinding name. Three checks keep it a private channel of the app:
//! the `Host` header must be exactly `127.0.0.1:<port>` (a rebinding name carries another host),
//! the path carries a per-launch random token (a page cannot guess it), and a media route names
//! only a `memry-file` URL, which the same root checks as the scheme then resolve.
//!
//! - `/m/<token>/<base64url of the canonical memry-file URL>`: audio and video bytes, with Range.
//! - `/e/<token>/youtube/<video id>`: a page that frames the YouTube embed with a referrer YouTube
//!   accepts (the app's own origin is not `http(s)`, which YouTube answers with Error 153).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use super::local_scheme::MAX_URL_LEN;

/// The longest base64 a media route accepts: the encoding of the longest URL.
const MAX_ENCODED_LEN: usize = MAX_URL_LEN / 3 * 4 + 4;
/// The longest path the router reads at all.
const MAX_PATH_LEN: usize = MAX_ENCODED_LEN + 256;
const MEDIA_URL_PREFIX: &str = "memry-file://local/";

/// The CSP of every `/e/` response: the page may frame YouTube and nothing else.
pub const EMBED_CSP: &str =
    "default-src 'none'; frame-src https://www.youtube-nocookie.com; style-src 'unsafe-inline'";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Serve the file this canonical `memry-file` URL names.
    Media(String),
    /// Serve the embed page of a video.
    YoutubeEmbed(String),
    /// A `Host` header that is not the server's own address.
    BadHost,
    /// Anything else, including a wrong token. Always a 404, so a probe learns nothing.
    NotFound,
}

/// Equal strings, in time that does not depend on where they differ.
fn same_token(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |diff, (x, y)| diff | (x ^ y))
            == 0
}

/// A YouTube video id: eleven of `[A-Za-z0-9_-]`.
pub fn is_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Encodes the canonical URL for a media route (the renderer's `toMediaUrl` does the same).
pub fn encode_media_target(canonical_url: &str) -> String {
    URL_SAFE_NO_PAD.encode(canonical_url)
}

/// Decides a request. `path` is the request path without its query.
pub fn route(host: Option<&str>, path: &str, port: u16, token: &str) -> Route {
    if host != Some(format!("127.0.0.1:{port}").as_str()) {
        return Route::BadHost;
    }
    if path.len() > MAX_PATH_LEN {
        return Route::NotFound;
    }
    let mut parts = path.strip_prefix('/').unwrap_or("").split('/');
    let (Some(kind), Some(given), Some(first)) = (parts.next(), parts.next(), parts.next()) else {
        return Route::NotFound;
    };
    if !same_token(given, token) {
        return Route::NotFound;
    }
    let rest: Vec<&str> = parts.collect();
    match (kind, first, rest.as_slice()) {
        ("m", encoded, []) => decode_media_target(encoded).map_or(Route::NotFound, Route::Media),
        ("e", "youtube", [id]) if is_video_id(id) => Route::YoutubeEmbed((*id).to_owned()),
        _ => Route::NotFound,
    }
}

fn decode_media_target(encoded: &str) -> Option<String> {
    if encoded.len() > MAX_ENCODED_LEN {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let url = String::from_utf8(bytes).ok()?;
    url.starts_with(MEDIA_URL_PREFIX).then_some(url)
}

/// The page of a `/e/` response. The iframe's referrer policy and the page's own make YouTube
/// see `http://127.0.0.1:<port>` as the embedder.
pub fn youtube_embed_html(video_id: &str) -> String {
    debug_assert!(is_video_id(video_id));
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
<meta name=\"referrer\" content=\"strict-origin-when-cross-origin\">\
<style>html,body,iframe{{margin:0;width:100%;height:100%;border:0;background:#000}}</style>\
</head><body><iframe src=\"https://www.youtube-nocookie.com/embed/{video_id}?autoplay=1&amp;rel=0\" \
referrerpolicy=\"strict-origin-when-cross-origin\" \
allow=\"autoplay; encrypted-media; picture-in-picture\" allowfullscreen></iframe></body></html>"
    )
}

#[cfg(test)]
mod tests;
