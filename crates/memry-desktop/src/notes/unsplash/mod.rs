//! Unsplash cover source: a port of `apps/desktop/src/main/unsplash/service.ts`.
//!
//! The picker hotlinks the thumbnails Unsplash returns, as the API licence requires, but a chosen
//! cover is copied into the vault so it keeps working offline and on every other device. Nothing
//! here leaves a hotlinked URL in a note, and saving the bytes is the caller's job (a note's
//! attachments, a Home board's cover folder).
//!
//! The service builds its own client from the builder the caller gives it (`crate::http::builder()`
//! in the app, so the shared rustls stack), adding a redirect policy. The access key belongs to the
//! build (`RuntimeConfig::unsplash_access_key`); without one every call answers
//! [`UnsplashFailure::NotConfigured`] and the renderer hides the Photos tab.
//!
//! The network is untrusted input. The key goes only to `api.unsplash.com` (a photo that names
//! another host for its tracking endpoint is refused before any request). Only a request that
//! started on an image host follows a redirect, and only to another `https` image host, so an API
//! request never leaves the API (nor sends its query to the CDN as a `Referer`) and a request to
//! any other host is never sent. The URL every response came from is checked again before its
//! status. Every response body has a byte cap, and
//! every request has a timeout, which the shared client does not have.
//!
//! A photo served with a content type outside `EXTENSION_BY_MIME` is refused. Electron saved it
//! as `.jpg`; refusing is stricter on purpose, since such a body is a captive portal's page, not a
//! cover.

mod photo;

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use reqwest::redirect::Policy;
use reqwest::{Client, ClientBuilder, Response};
use serde::Serialize;
use serde_json::Value;
use url::Url;

pub use photo::{InvalidPhoto, UnsplashPhoto};

const SEARCH_ENDPOINT: &str = "https://api.unsplash.com/search/photos";
const PER_PAGE: &str = "30";

/// Enough to make paging back and forth free without holding a session's worth of results.
const CACHE_LIMIT: usize = 50;

const MAX_QUERY_CHARS: usize = 200;
const MAX_PAGE: u32 = 100;

/// A page of 30 results is about 150 KB.
const MAX_SEARCH_BYTES: usize = 4 * 1024 * 1024;
/// `urls.regular` is a 1080 px wide JPEG, well under 2 MB.
const MAX_PHOTO_BYTES: usize = 16 * 1024 * 1024;
/// An error body is read only to look for the words "rate limit".
const MAX_ERROR_BYTES: usize = 64 * 1024;

const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);
const PING_TIMEOUT: Duration = Duration::from_secs(10);
const PHOTO_TIMEOUT: Duration = Duration::from_secs(60);
/// Redirects followed in one chain, reqwest's default.
const MAX_REDIRECTS: usize = 10;

const EXTENSION_BY_MIME: [(&str, &str); 4] = [
    ("image/jpeg", "jpg"),
    ("image/png", "png"),
    ("image/webp", "webp"),
    ("image/gif", "gif"),
];

/// Why an Unsplash request produced nothing. The wire names are the contract's
/// `UnsplashFailureReason`; `NotConfigured` is "hide the Photos tab", not an error to show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum UnsplashFailure {
    NotConfigured,
    Offline,
    RateLimited,
    Failed,
}

/// A validated search: a query of at most 200 characters and a page from 1 to 100.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchRequest {
    query: String,
    page: u32,
}

/// A search the contract's schema would have refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InvalidSearch {
    #[error("the query is longer than {MAX_QUERY_CHARS} characters")]
    QueryTooLong,
    #[error("the page must be from 1 to {MAX_PAGE}")]
    PageOutOfRange,
}

impl SearchRequest {
    pub fn parse(query: &str, page: Option<u32>) -> Result<Self, InvalidSearch> {
        if query.chars().count() > MAX_QUERY_CHARS {
            return Err(InvalidSearch::QueryTooLong);
        }
        let page = page.unwrap_or(1);
        if !(1..=MAX_PAGE).contains(&page) {
            return Err(InvalidSearch::PageOutOfRange);
        }
        Ok(Self {
            query: query.trim().to_owned(),
            page,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchPage {
    pub photos: Vec<UnsplashPhoto>,
    /// `X-Ratelimit-Remaining` of the response, when it was a number.
    pub rate_limit_remaining: Option<i64>,
}

/// Who to credit for a photo, as the licence asks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct Credit {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedPhoto {
    pub bytes: Vec<u8>,
    /// `unsplash-<id>.<ext>`, the extension from the content type.
    pub filename: String,
    pub credit: Credit,
}

pub struct Unsplash {
    http: Client,
    access_key: Option<String>,
    cache: Mutex<SearchCache>,
}

impl Unsplash {
    /// Fails only when `http` cannot build a client (no process default crypto provider).
    pub fn new(http: ClientBuilder, access_key: Option<String>) -> Result<Self, reqwest::Error> {
        let redirects = Policy::custom(|attempt| {
            // `previous` holds the first URL of the chain and every URL followed since.
            let started_on_image_host = attempt.previous().first().is_some_and(photo::is_image_url);
            if !started_on_image_host || !photo::is_image_url(attempt.url()) {
                // The 3xx itself becomes the response, which every caller refuses.
                attempt.stop()
            } else if attempt.previous().len() > MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else {
                attempt.follow()
            }
        });
        Ok(Self {
            http: http.redirect(redirects).build()?,
            access_key: access_key
                .map(|key| key.trim().to_owned())
                .filter(|key| !key.is_empty()),
            cache: Mutex::default(),
        })
    }

    pub fn is_available(&self) -> bool {
        self.access_key.is_some()
    }

    pub async fn search(&self, request: &SearchRequest) -> Result<SearchPage, UnsplashFailure> {
        let key = self.key()?;
        if request.query.is_empty() {
            return Ok(SearchPage {
                photos: Vec::new(),
                rate_limit_remaining: None,
            });
        }
        let cache_key = (request.query.clone(), request.page);
        if let Some(page) = self.cache().get(&cache_key) {
            return Ok(page);
        }

        let url = Url::parse_with_params(
            SEARCH_ENDPOINT,
            [
                ("query", request.query.as_str()),
                ("page", request.page.to_string().as_str()),
                ("per_page", PER_PAGE),
                ("content_filter", "high"),
            ],
        )
        .map_err(|error| {
            tracing::error!(scope = "Unsplash", "search url could not be built: {error}");
            UnsplashFailure::Failed
        })?;
        let response = self.api_get(key, url, SEARCH_TIMEOUT).await?;
        if !response.status().is_success() {
            return Err(self.refusal("search", response).await);
        }
        let remaining = rate_limit_remaining(&response);
        let body = read_capped(response, MAX_SEARCH_BYTES)
            .await
            .map_err(|error| {
                tracing::error!(scope = "Unsplash", "search body could not be read: {error}");
                UnsplashFailure::Failed
            })?;
        let value = serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null);
        let Some(results) = value.get("results").and_then(Value::as_array) else {
            tracing::error!(scope = "Unsplash", "search returned no results array");
            return Err(UnsplashFailure::Failed);
        };

        let page = SearchPage {
            photos: results.iter().filter_map(UnsplashPhoto::from_api).collect(),
            rate_limit_remaining: remaining,
        };
        self.cache().put(cache_key, page.clone());
        Ok(page)
    }

    /// Fetches a photo's bytes after the download-tracking ping the API guidelines require.
    ///
    /// The ping is a tracking event and not a prerequisite for the bytes, so a failure there is
    /// logged and never blocks the cover; the image comes from a CDN that does not share the API's
    /// rate limit and gets no key.
    pub async fn fetch_photo(
        &self,
        photo: &UnsplashPhoto,
    ) -> Result<FetchedPhoto, UnsplashFailure> {
        let key = self.key()?;
        if let Err(error) = photo.validate() {
            tracing::warn!(scope = "Unsplash", "refused a photo: {error}");
            return Err(UnsplashFailure::Failed);
        }
        self.ping_download_location(key, photo).await;

        let response = self
            .http
            .get(&photo.full_url)
            .timeout(PHOTO_TIMEOUT)
            .send()
            .await
            .map_err(|error| send_failure("photo fetch", &error))?;
        // The redirect policy follows only image hosts; the URL the response came from is checked
        // again, before anything of the response is read.
        if !photo::is_image_url(response.url()) || response.status().is_redirection() {
            tracing::error!(
                scope = "Unsplash",
                "a photo was redirected away from the image hosts"
            );
            return Err(UnsplashFailure::Failed);
        }
        if !response.status().is_success() {
            return Err(self.refusal("photo fetch", response).await);
        }
        // A 200 that is not an image (a captive portal's page) is not a cover.
        let Some(extension) = extension_for(&response) else {
            tracing::error!(
                scope = "Unsplash",
                "a photo came back with a content type that is not an image"
            );
            return Err(UnsplashFailure::Failed);
        };
        let bytes = read_capped(response, MAX_PHOTO_BYTES)
            .await
            .map_err(|error| {
                tracing::error!(scope = "Unsplash", "photo body could not be read: {error}");
                UnsplashFailure::Failed
            })?;
        Ok(FetchedPhoto {
            bytes,
            filename: format!("unsplash-{}.{extension}", photo.id),
            credit: Credit {
                name: photo.author_name.clone(),
                url: photo.html_url.clone(),
            },
        })
    }

    fn key(&self) -> Result<&str, UnsplashFailure> {
        self.access_key
            .as_deref()
            .ok_or(UnsplashFailure::NotConfigured)
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, SearchCache> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }

    async fn ping_download_location(&self, key: &str, photo: &UnsplashPhoto) {
        let Ok(url) = Url::parse(&photo.download_location) else {
            return;
        };
        match self.api_get(key, url, PING_TIMEOUT).await {
            Ok(response) if !response.status().is_success() => tracing::warn!(
                scope = "Unsplash",
                "download tracking ping was rejected: {}",
                response.status()
            ),
            Ok(_) => {}
            Err(_) => tracing::warn!(
                scope = "Unsplash",
                "download tracking ping could not be sent"
            ),
        }
    }

    /// A GET that carries the access key. The URL is on `api.unsplash.com`; the redirect policy
    /// never follows a redirect from it, and the URL the response came from is checked again.
    async fn api_get(
        &self,
        key: &str,
        url: Url,
        timeout: Duration,
    ) -> Result<Response, UnsplashFailure> {
        debug_assert!(photo::is_api_url(&url), "the key goes to the API host only");
        let mut authorization =
            HeaderValue::from_str(&format!("Client-ID {key}")).map_err(|_| {
                tracing::error!(
                    scope = "Unsplash",
                    "the access key is not a valid header value"
                );
                UnsplashFailure::Failed
            })?;
        authorization.set_sensitive(true);
        let response = self
            .http
            .get(url)
            .header(AUTHORIZATION, authorization)
            .header("Accept-Version", "v1")
            .timeout(timeout)
            .send()
            .await
            .map_err(|error| send_failure("API request", &error))?;
        if !photo::is_api_url(response.url()) || response.status().is_redirection() {
            tracing::error!(
                scope = "Unsplash",
                "a request to the API was redirected away"
            );
            return Err(UnsplashFailure::Failed);
        }
        Ok(response)
    }

    /// The failure of a non-success response: rate-limited when Unsplash says so.
    async fn refusal(&self, what: &str, response: Response) -> UnsplashFailure {
        let status = response.status();
        if is_rate_limited(response).await {
            return UnsplashFailure::RateLimited;
        }
        tracing::error!(scope = "Unsplash", "{what} failed: {status}");
        UnsplashFailure::Failed
    }
}

/// A request that got no response: a redirect chain over the cap is a refusal, anything else is
/// the network.
fn send_failure(what: &str, error: &reqwest::Error) -> UnsplashFailure {
    if error.is_redirect() {
        tracing::error!(scope = "Unsplash", "{what} was redirected too many times");
        return UnsplashFailure::Failed;
    }
    tracing::warn!(
        scope = "Unsplash",
        "{what} could not reach the network: {error}"
    );
    UnsplashFailure::Offline
}

fn rate_limit_remaining(response: &Response) -> Option<i64> {
    response
        .headers()
        .get("x-ratelimit-remaining")?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// 429, or 403 with the quota spent (`X-Ratelimit-Remaining: 0`) or saying so in its body.
async fn is_rate_limited(response: Response) -> bool {
    match response.status().as_u16() {
        429 => true,
        403 if rate_limit_remaining(&response) == Some(0) => true,
        403 => read_capped(response, MAX_ERROR_BYTES)
            .await
            .is_ok_and(|body| {
                String::from_utf8_lossy(&body)
                    .to_ascii_lowercase()
                    .contains("rate limit")
            }),
        _ => false,
    }
}

fn extension_for(response: &Response) -> Option<&'static str> {
    let mime = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase());
    EXTENSION_BY_MIME
        .iter()
        .find(|(known, _)| mime.as_deref() == Some(known))
        .map(|(_, extension)| *extension)
}

#[derive(Debug, thiserror::Error)]
enum ReadError {
    #[error("the body is larger than {cap} bytes")]
    TooLarge { cap: usize },
    #[error("the connection failed while reading the body")]
    Transport,
}

/// The whole body, or an error as soon as it is known to exceed `cap`: by `Content-Length` before
/// reading, by the running count after.
async fn read_capped(mut response: Response, cap: usize) -> Result<Vec<u8>, ReadError> {
    if response
        .content_length()
        .is_some_and(|length| length > cap as u64)
    {
        return Err(ReadError::TooLarge { cap });
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ReadError::Transport)? {
        if body.len() + chunk.len() > cap {
            return Err(ReadError::TooLarge { cap });
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

type CacheKey = (String, u32);

/// The last [`CACHE_LIMIT`] successful searches, oldest evicted first. Failures are not cached.
#[derive(Default)]
struct SearchCache {
    pages: HashMap<CacheKey, SearchPage>,
    order: VecDeque<CacheKey>,
}

impl SearchCache {
    fn get(&self, key: &CacheKey) -> Option<SearchPage> {
        self.pages.get(key).cloned()
    }

    fn put(&mut self, key: CacheKey, page: SearchPage) {
        if !self.pages.contains_key(&key) {
            if self.order.len() >= CACHE_LIMIT
                && let Some(oldest) = self.order.pop_front()
            {
                self.pages.remove(&oldest);
            }
            self.order.push_back(key.clone());
        }
        self.pages.insert(key, page);
    }
}
