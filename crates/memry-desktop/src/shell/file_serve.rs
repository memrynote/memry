//! What the `memry-file` and `memry-html` schemes and the loopback media route answer for a file:
//! port of `serveFromHandle` (`apps/desktop/src/main/lib/memry-file-protocol.ts`) and the
//! `memry-html` response (`vault/html-embed-protocol.ts`).
//!
//! Pure decisions over a path, a size and a `Range` header. The header is request input, so the
//! parser is bounded and total: any text yields a plan, and a header it cannot read is ignored
//! (the whole file, as RFC 9110 says of an invalid range).

use std::path::Path;

/// Bodies are streamed in chunks of this size.
pub const CHUNK_SIZE: usize = 64 * 1024;

/// A `Range` header longer than this is ignored. A real one is under 40 bytes.
const MAX_RANGE_HEADER_LEN: usize = 256;

/// The embedded document's policy: scripts run, but the document gets an opaque origin and no
/// access to the app, the vault or its own siblings.
///
/// A CSP source list cannot subtract a host, so `https:` still matches
/// `https://memry-file.localhost` on Windows. What keeps the embed from reading a file there is
/// the file server: it answers a request whose `Origin` is not the app's (`null` from a sandbox
/// included) with 403 and no CORS header, and refuses script, style and frame loads by
/// `Sec-Fetch-Dest`. WebView2 sends the handler neither header, so there a request must carry the
/// launch token the app's page puts in its URLs (`FileRequest::required_token`); an embed has
/// none. No `http:`, so the loopback server and other local services stay out of
/// reach; no `memry-file:` and no `memry-html:`.
pub const HTML_EMBED_CSP: &str = "sandbox allow-scripts allow-forms allow-popups; \
default-src https: data: blob: 'unsafe-inline' 'unsafe-eval'; \
connect-src https: wss: data: blob:; form-action 'none'; object-src 'none'";

/// The policy of every served file. Images, audio and video ignore it; a file the engine renders as
/// a document (an SVG, an HTML file) gets an opaque origin and no scripts.
pub const FILE_CSP: &str = "sandbox; default-src 'none'";

/// What a document served by this app may ask of the engine: no camera, microphone, location,
/// screen capture or clipboard. A frame it embeds (the YouTube player) inherits the limit unless
/// the embedder delegates a feature with `allow`, which the app never does for these.
pub const FRAME_PERMISSIONS_POLICY: &str = "camera=(), microphone=(), geolocation=(), \
display-capture=(), clipboard-read=(), clipboard-write=()";

/// A 1x1 transparent PNG, base64, answered for a missing image so a null thumbnail does not
/// render as a broken-image icon.
pub const TRANSPARENT_PNG_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

fn extension_is(path: &str, accepted: &[&str]) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| accepted.iter().any(|a| e.eq_ignore_ascii_case(a)))
}

/// `.html` and `.htm`: never served as a page from `memry-file`.
pub fn is_html_path(path: &str) -> bool {
    extension_is(path, &["html", "htm"])
}

/// An image a note can embed: a missing one gets the blank PNG.
pub fn is_image_path(path: &str) -> bool {
    extension_is(path, &["png", "jpg", "jpeg", "gif", "webp"])
}

/// The `Content-Type` of a served file. An attached HTML file is text here, never a page.
pub fn content_type(path: &str) -> String {
    if is_html_path(path) {
        return "text/plain; charset=utf-8".to_owned();
    }
    mime_guess::from_path(path).first().map_or_else(
        || "application/octet-stream".to_owned(),
        |m| m.essence_str().to_owned(),
    )
}

/// `text/html`, with a UTF-8 default unless the document declares a charset in its first KiB (the
/// header would otherwise override the document's own `<meta>`).
pub fn html_content_type(head: &[u8]) -> &'static str {
    let lower = head[..head.len().min(1024)].to_ascii_lowercase();
    // `charset`, optional space, `=`.
    let declares = lower.windows(7).enumerate().any(|(i, w)| {
        w == b"charset" && lower[i + 7..].iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'=')
    });
    if declares {
        "text/html"
    } else {
        "text/html; charset=utf-8"
    }
}

/// What to send for a file of a known size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServePlan {
    /// 200 with the whole file.
    Full,
    /// 206 with the bytes `start..=end`.
    Partial { start: u64, end: u64 },
    /// 416: the range starts past the end.
    Unsatisfiable,
}

impl ServePlan {
    /// Bytes in the body.
    pub fn body_len(self, size: u64) -> u64 {
        match self {
            Self::Full => size,
            Self::Partial { start, end } => end - start + 1,
            Self::Unsatisfiable => 0,
        }
    }
}

fn digits(text: &str) -> Option<Option<u64>> {
    if text.is_empty() {
        return Some(None);
    }
    if !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // More digits than u64 holds is not a position in any file.
    text.parse().ok().map(Some)
}

/// Plans the response to a `Range` header (`None` when absent). One range is served: of
/// several, the first. A suffix range (`bytes=-N`) is the last N bytes (Electron answered it
/// from byte 0). A header that is too long, not `bytes=`, not numeric, or ends before it starts
/// is ignored and the whole file is sent.
pub fn plan(range: Option<&str>, size: u64) -> ServePlan {
    let Some(header) = range else {
        return ServePlan::Full;
    };
    if header.len() > MAX_RANGE_HEADER_LEN {
        return ServePlan::Full;
    }
    let header = header.trim();
    let Some(spec) = header
        .get(..6)
        .filter(|prefix| prefix.eq_ignore_ascii_case("bytes="))
        .map(|_| &header[6..])
    else {
        return ServePlan::Full;
    };
    let first = spec.split(',').next().unwrap_or("").trim();
    let Some((from, to)) = first.split_once('-') else {
        return ServePlan::Full;
    };
    let (Some(from), Some(to)) = (digits(from.trim()), digits(to.trim())) else {
        return ServePlan::Full;
    };
    match (from, to) {
        (None, None) => ServePlan::Full,
        (None, Some(0)) => ServePlan::Unsatisfiable,
        (None, Some(last)) => {
            if size == 0 {
                return ServePlan::Unsatisfiable;
            }
            ServePlan::Partial {
                start: size.saturating_sub(last),
                end: size - 1,
            }
        }
        (Some(start), end) => {
            if end.is_some_and(|end| end < start) {
                return ServePlan::Full;
            }
            if start >= size {
                return ServePlan::Unsatisfiable;
            }
            ServePlan::Partial {
                start,
                end: end.map_or(size - 1, |end| end.min(size - 1)),
            }
        }
    }
}

/// The status and headers of a file response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
}

/// The head for `plan` over a file of `size` bytes at `path`.
pub fn head(path: &str, size: u64, plan: ServePlan) -> Head {
    let mut headers = vec![
        ("Content-Type", content_type(path)),
        ("Accept-Ranges", "bytes".to_owned()),
        ("X-Content-Type-Options", "nosniff".to_owned()),
        // A file opened as a document (an SVG at a loopback URL) runs nothing and reads nothing.
        ("Content-Security-Policy", FILE_CSP.to_owned()),
        ("Permissions-Policy", FRAME_PERMISSIONS_POLICY.to_owned()),
    ];
    let status = match plan {
        ServePlan::Full => 200,
        ServePlan::Partial { start, end } => {
            headers.push(("Content-Range", format!("bytes {start}-{end}/{size}")));
            206
        }
        ServePlan::Unsatisfiable => {
            headers.push(("Content-Range", format!("bytes */{size}")));
            416
        }
    };
    headers.push(("Content-Length", plan.body_len(size).to_string()));
    Head { status, headers }
}

#[cfg(test)]
mod tests;
