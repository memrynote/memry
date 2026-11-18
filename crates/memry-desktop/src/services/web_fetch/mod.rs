//! Web page fetches of the Inbox: link metadata, article HTML, hero images and the network seam of
//! article extraction. Port of `apps/desktop/src/main/inbox/metadata.ts`.
//!
//! Electron fetched through `net.fetch`, Chromium's own stack, because Cloudflare and similar bot
//! walls answer a non-browser TLS fingerprint with a 403 challenge (`metadata.ts:66-96`,
//! eksisozluk.com). This client is wreq (BoringSSL) with the Chrome 149 emulation for the same
//! TLS and HTTP/2 fingerprint. It serves only these fetches: every other HTTP client of the app
//! stays on the shared `ring` rustls stack (`crate::http`).
//!
//! Error messages carry the status code only, never the URL: they reach telemetry as the job's
//! error (`metadata.ts:202-205`, `:251-255`).

mod fetcher;
mod image;
mod metadata;
mod reddit;

use std::net::SocketAddr;
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::StreamExt;
use wreq::header::{
    ACCEPT, ACCEPT_ENCODING, ACCEPT_LANGUAGE, CONTENT_TYPE, HeaderMap, HeaderValue, USER_AGENT,
};
use wreq::tls::trust::CertStore;

pub use fetcher::BlockingFetcher;
pub use image::image_extension;
pub use metadata::{
    METASCRAPE_MAX_DEPTH, MetascrapeError, is_bot_page_title, metascrape, metascrape_at,
    metascrape_parse_steps, metascrape_steps,
};
pub use reddit::{
    UrlMetadata, is_reddit_url, reddit_json_url, reddit_metadata_from_listing,
    rewrite_url_for_fetch,
};

/// `URL_FETCH_TIMEOUT` (`metadata.ts:51`).
pub const PAGE_TIMEOUT: Duration = Duration::from_secs(10);
/// `IMAGE_DOWNLOAD_TIMEOUT` (`metadata.ts:54`).
pub const IMAGE_TIMEOUT: Duration = Duration::from_secs(5);
/// `MAX_HTML_SIZE` (`metadata.ts:64`).
pub const MAX_HTML_BYTES: usize = 10 * 1024 * 1024;
/// `MAX_IMAGE_SIZE` (`metadata.ts:61`).
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;

/// The User-Agent Electron sent (`metadata.ts:57-58`), on every request.
pub const CHROME_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const ACCEPT_HTML: &str = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const ACCEPT_LANGUAGE_VALUE: &str = "en-US,en;q=0.5";
/// What Chromium's network stack, and so `net.fetch`, advertises.
const ACCEPT_ENCODING_VALUE: &str = "gzip, deflate, br, zstd";
/// The redirect limit of WHATWG fetch, which `net.fetch` follows.
const MAX_REDIRECTS: usize = 20;

/// Deadlines and size caps of one client. Production uses [`Limits::default`], Electron's
/// constants; tests shrink them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub page_timeout: Duration,
    pub image_timeout: Duration,
    pub max_html_bytes: usize,
    pub max_image_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            page_timeout: PAGE_TIMEOUT,
            image_timeout: IMAGE_TIMEOUT,
            max_html_bytes: MAX_HTML_BYTES,
            max_image_bytes: MAX_IMAGE_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WebFetchError {
    /// A metadata page answered outside 200-299 (`metadata.ts:205`).
    #[error("HTTP {0}")]
    Status(u16),
    /// An article page answered outside 200-299 (`metadata.ts:255`).
    #[error("Failed to fetch article HTML: {0}")]
    ArticleStatus(u16),
    /// `Content-Length` above the cap (`metadata.ts:258-260`).
    #[error("Response too large: {0} bytes")]
    DeclaredTooLarge(u64),
    /// The body grew past the cap while streaming.
    #[error("Response too large: more than {0} bytes")]
    TooLarge(usize),
    #[error("The request timed out")]
    Timeout,
    /// A transport failure, by kind only: wreq's own message names the URL.
    #[error("Network error: {0}")]
    Network(&'static str),
    #[error("The web client could not be built")]
    Build,
}

/// The Inbox's web client. Cheap to clone: clones share one connection pool.
#[derive(Clone)]
pub struct WebFetch {
    client: wreq::Client,
    limits: Limits,
}

impl WebFetch {
    /// The production client: Electron's limits, system proxies, webpki plus OS roots.
    pub fn new() -> Result<Self, WebFetchError> {
        Self::build(Limits::default(), true, &[])
    }

    /// A client for tests against a local server: no system proxy, `resolve` pins host names to
    /// local addresses (so the Reddit host rules run unchanged), and the given limits.
    #[doc(hidden)]
    pub fn for_tests(
        limits: Limits,
        resolve: &[(&str, SocketAddr)],
    ) -> Result<Self, WebFetchError> {
        Self::build(limits, false, resolve)
    }

    fn build(
        limits: Limits,
        system_proxy: bool,
        resolve: &[(&str, SocketAddr)],
    ) -> Result<Self, WebFetchError> {
        // The Chrome 149 TLS and HTTP/2 fingerprint without its default headers: those carry
        // `sec-ch-ua` client hints for Chrome 149, which `net.fetch` never sent (a main-process
        // request has no frame) and which would contradict the Chrome 120 User-Agent.
        let emulation = wreq_util::Emulation::builder()
            .profile(wreq_util::Profile::Chrome149)
            .headers(false)
            .build();
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static(CHROME_USER_AGENT));
        headers.insert(
            ACCEPT_ENCODING,
            HeaderValue::from_static(ACCEPT_ENCODING_VALUE),
        );
        let mut builder = wreq::Client::builder()
            .emulation(emulation)
            .default_headers(headers)
            .tls_cert_store(roots().clone())
            .redirect(wreq::redirect::Policy::limited(MAX_REDIRECTS));
        if !system_proxy {
            builder = builder.no_proxy();
        }
        for (host, addr) in resolve {
            builder = builder.resolve(host.to_string(), *addr);
        }
        let client = builder.build().map_err(|error| {
            tracing::error!(%error, "web fetch client build failed");
            WebFetchError::Build
        })?;
        Ok(Self { client, limits })
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// The page of a link for metadata scraping: the fetch half of `fetchUrlMetadata`
    /// (`metadata.ts:181-234`), after the Reddit JSON rule declined.
    pub async fn metadata_page(&self, url: &str) -> Result<String, WebFetchError> {
        self.html(url, WebFetchError::Status).await
    }

    /// `fetchUrlHtml` (`metadata.ts:236-265`): the HTML the article extractor reads.
    pub async fn article_html(&self, url: &str) -> Result<String, WebFetchError> {
        self.html(url, WebFetchError::ArticleStatus).await
    }

    async fn html(
        &self,
        url: &str,
        status_error: fn(u16) -> WebFetchError,
    ) -> Result<String, WebFetchError> {
        let request = self
            .client
            .get(rewrite_url_for_fetch(url))
            .header(ACCEPT, ACCEPT_HTML)
            .header(ACCEPT_LANGUAGE, ACCEPT_LANGUAGE_VALUE);
        let cap = self.limits.max_html_bytes;
        within(self.limits.page_timeout, async move {
            let response = send(request).await?;
            let status = response.status().as_u16();
            if !response.status().is_success() {
                return Err(status_error(status));
            }
            let content_type = header_text(&response, CONTENT_TYPE);
            let body = read_capped(response, cap).await?;
            Ok(decode_text(&body, content_type.as_deref()))
        })
        .await
    }
}

/// webpki's bundled roots plus the OS roots, loaded once per process. An OS store that fails to
/// load leaves the bundled roots.
fn roots() -> &'static CertStore {
    static ROOTS: OnceLock<CertStore> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let native = rustls_native_certs::load_native_certs();
        if !native.errors.is_empty() {
            tracing::warn!(
                errors = native.errors.len(),
                loaded = native.certs.len(),
                "some OS root certificates did not load"
            );
        }
        CertStore::builder()
            .add_der_certs(webpki_root_certs::TLS_SERVER_ROOT_CERTS)
            .add_der_certs(native.certs.iter().map(|cert| cert.as_ref()))
            .build()
            .or_else(|error| {
                tracing::warn!(%error, "OS roots rejected; using the bundled roots only");
                CertStore::from_der_certs(webpki_root_certs::TLS_SERVER_ROOT_CERTS)
            })
            .expect("the bundled webpki roots parse")
    })
}

async fn within<T>(
    deadline: Duration,
    work: impl Future<Output = Result<T, WebFetchError>>,
) -> Result<T, WebFetchError> {
    tokio::time::timeout(deadline, work)
        .await
        .unwrap_or(Err(WebFetchError::Timeout))
}

async fn send(request: wreq::RequestBuilder) -> Result<wreq::Response, WebFetchError> {
    request.send().await.map_err(network_error)
}

fn network_error(error: wreq::Error) -> WebFetchError {
    tracing::debug!(%error, "web fetch failed");
    let kind = if error.is_timeout() {
        return WebFetchError::Timeout;
    } else if error.is_connect() {
        "connect"
    } else if error.is_redirect() {
        "redirect"
    } else if error.is_body() || error.is_decode() {
        "body"
    } else {
        "request"
    };
    WebFetchError::Network(kind)
}

fn header_text(response: &wreq::Response, name: wreq::header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

/// The whole body, or an error as soon as it is known to exceed `cap`: by `Content-Length` before
/// reading, by the running count after.
async fn read_capped(response: wreq::Response, cap: usize) -> Result<Vec<u8>, WebFetchError> {
    if let Some(length) = response
        .content_length()
        .filter(|length| *length > cap as u64)
    {
        return Err(WebFetchError::DeclaredTooLarge(length));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(network_error)?;
        if body.len() + chunk.len() > cap {
            return Err(WebFetchError::TooLarge(cap));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// The body as text in the charset its `Content-Type` names, UTF-8 when it names none or an
/// unknown one; a byte order mark wins, as in a browser. Malformed sequences become U+FFFD.
pub fn decode_text(body: &[u8], content_type: Option<&str>) -> String {
    let encoding = content_type
        .and_then(charset_label)
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode(body).0.into_owned()
}

fn charset_label(content_type: &str) -> Option<&str> {
    content_type.split(';').skip(1).find_map(|param| {
        let (name, value) = param.split_once('=')?;
        name.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| value.trim().trim_matches('"'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_text_follows_the_declared_charset() {
        let body = [0x49, 0x73, 0x74, 0x61, 0x6e, 0x62, 0x75, 0x6c, 0x20, 0xfd];
        assert_eq!(
            decode_text(&body, Some("text/html; charset=windows-1254")),
            "Istanbul ı"
        );
        assert_eq!(
            decode_text(&body, Some("text/html; Charset=\"WINDOWS-1254\"")),
            "Istanbul ı"
        );
        assert_eq!(decode_text(&body, Some("text/html")), "Istanbul \u{fffd}");
        assert_eq!(
            decode_text(&body, Some("text/html; charset=bogus")),
            "Istanbul \u{fffd}"
        );
        assert_eq!(
            decode_text("\u{feff}ok".as_bytes(), Some("text/html; charset=latin1")),
            "ok"
        );
    }
}
