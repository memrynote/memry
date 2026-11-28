//! Who may call the capture server (`apps/desktop/src/main/capture/auth.ts`): browser-extension
//! origins, the `X-Memry-Capture: 1` header, and the pairing token compared in constant time.
//! Plus one check Electron lacks: the `Host` header must name this server, so a page that
//! rebinds its own DNS name to 127.0.0.1 is refused before any route runs.

use subtle::ConstantTimeEq;

/// Pairing accepts Chromium (`chrome-extension://`) and Firefox (`moz-extension://`) origins
/// only (`auth.ts:13`).
const EXTENSION_ORIGIN_PREFIXES: [&str; 2] = ["chrome-extension://", "moz-extension://"];

pub fn is_extension_origin(origin: &str) -> bool {
    EXTENSION_ORIGIN_PREFIXES
        .iter()
        .any(|prefix| origin.starts_with(prefix))
}

/// The reason an authed route refuses a request, in the order `auth.ts:31-34` checks them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Denied {
    MissingCaptureHeader,
    OriginNotAllowed,
    BadToken,
}

impl Denied {
    pub fn code(self) -> &'static str {
        match self {
            Self::MissingCaptureHeader => "missing-capture-header",
            Self::OriginNotAllowed => "origin-not-allowed",
            Self::BadToken => "bad-token",
        }
    }
}

/// The headers the checks read, as Node's `IncomingMessage.headers` presents them: a repeated
/// `Origin` or `X-Memry-Capture` is joined with `", "` (so it never matches), and a repeated
/// `Authorization` or `Host` keeps the first value.
#[derive(Debug, Clone, Default)]
pub struct Asked {
    pub host: Option<String>,
    pub origin: Option<String>,
    pub capture: Option<String>,
    pub authorization: Option<String>,
}

impl Asked {
    pub fn read(headers: &axum::http::HeaderMap) -> Self {
        let first = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let joined = |name: &str| {
            let values: Option<Vec<&str>> = headers
                .get_all(name)
                .iter()
                .map(|v| v.to_str().ok())
                .collect();
            values.filter(|v| !v.is_empty()).map(|v| v.join(", "))
        };
        Self {
            host: first("host"),
            origin: joined("origin"),
            capture: joined("x-memry-capture"),
            authorization: first("authorization"),
        }
    }

    pub fn has_capture_header(&self) -> bool {
        self.capture.as_deref() == Some("1")
    }

    /// The bearer token, or `""` (`auth.ts:33`: the prefix is case-sensitive).
    pub fn bearer(&self) -> &str {
        self.authorization
            .as_deref()
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or("")
    }
}

/// `Host` is `127.0.0.1:<port>` or `localhost:<port>` (any case). The extension always sends
/// the first (`capture-client.ts`); a missing or other host is refused.
pub fn host_allowed(host: Option<&str>, port: u16) -> bool {
    let Some(host) = host else {
        return false;
    };
    let Some((name, given)) = host.rsplit_once(':') else {
        return false;
    };
    given == port.to_string() && (name == "127.0.0.1" || name.eq_ignore_ascii_case("localhost"))
}

/// Constant time over the bytes; a length mismatch is `false` at once, as `timingSafeEqual`
/// is never reached for one in `auth.ts:19-24`.
pub fn token_matches(given: &str, token: &str) -> bool {
    !given.is_empty() && bool::from(given.as_bytes().ct_eq(token.as_bytes()))
}
