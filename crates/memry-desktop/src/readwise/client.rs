//! The one HTTP client of Readwise (`apps/desktop/src/main/readwise/client.ts`, and the Reader
//! list of `reader.ts`). It owns the auth header, the `429` backoff, the page cursor and
//! cancellation. GET only: the client is read-only by construction.
//!
//! Every byte it reads is untrusted. A body is read through [`http::read_capped`], a page parses
//! with `serde_json` (whose recursion limit of 128 bounds depth), a page cursor reaches the next
//! URL only as an encoded query value, and a cursor the server repeats ends the paging.

use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use reqwest::StatusCode;
use reqwest::header::{AUTHORIZATION, RETRY_AFTER};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::limiter::RequestLimiter;
use super::types::{ReaderDocument, ReadwiseBook};
use crate::http::{self, ReadError};

pub const READWISE_ORIGIN: &str = "https://readwise.io";

/// Live API check, 2026-10-22: `/api/v2/export/?ids=` answered 200 for 400 ids and 400 for 800.
/// 100 ids is about 1 KB of URL.
pub const EXPORT_IDS_BATCH_SIZE: usize = 100;
/// Retries after the first `429`. One more `429` is [`ReadwiseError::RateLimited`].
const MAX_RATE_LIMIT_RETRIES: u32 = 3;
const DEFAULT_RETRY_AFTER_SECS: u64 = 60;
const MAX_RETRY_AFTER_SECS: u64 = 120;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The largest page read. Electron reads any size; a Reader page of 100 documents with their
/// article HTML is the biggest legitimate one.
pub const MAX_PAGE_BYTES: usize = 256 << 20;
/// An auth failure's body is read only for its `detail`.
const MAX_ERROR_BODY_BYTES: usize = 64 << 10;

/// The locations Reader sync reads. `feed` holds items the user never saved.
pub const READER_LOCATIONS: [&str; 4] = ["new", "later", "shortlist", "archive"];
/// `limit` is at most 100 on `/api/v3/list/`.
pub const READER_PAGE_SIZE: usize = 100;

/// `ReadwiseErrorCode`: what the user is told and what the scheduler does next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadwiseErrorKind {
    InvalidToken,
    SubscriptionExpired,
    RateLimited,
    Network,
    Server,
}

/// A failed Readwise call. No message holds the token, and none holds the URL.
#[derive(Debug, thiserror::Error)]
pub enum ReadwiseError {
    #[error("Readwise rejected the access token (HTTP {status})")]
    InvalidToken { status: u16 },
    #[error("Readwise subscription has expired (HTTP {status})")]
    SubscriptionExpired { status: u16 },
    #[error("Readwise rate limit reached, retry after {retry_after_secs} s")]
    RateLimited { retry_after_secs: u64 },
    #[error("could not reach Readwise")]
    Network(#[source] reqwest::Error),
    #[error("Readwise answered HTTP {status}")]
    Status { status: u16 },
    #[error("Readwise sent a page in an unknown shape")]
    UnknownShape,
    #[error("Readwise sent a page over {MAX_PAGE_BYTES} bytes")]
    TooLarge,
    #[error("Readwise repeated a page cursor")]
    RepeatedCursor,
    #[error("the Readwise request was cancelled")]
    Cancelled,
}

impl ReadwiseError {
    /// The TypeScript code of the failure; `None` when the caller cancelled.
    pub fn kind(&self) -> Option<ReadwiseErrorKind> {
        Some(match self {
            Self::InvalidToken { .. } => ReadwiseErrorKind::InvalidToken,
            Self::SubscriptionExpired { .. } => ReadwiseErrorKind::SubscriptionExpired,
            Self::RateLimited { .. } => ReadwiseErrorKind::RateLimited,
            Self::Network(_) => ReadwiseErrorKind::Network,
            Self::Status { .. } | Self::UnknownShape | Self::TooLarge | Self::RepeatedCursor => {
                ReadwiseErrorKind::Server
            }
            Self::Cancelled => return None,
        })
    }
}

/// `work`, or [`ReadwiseError::Cancelled`] as soon as `cancel` fires.
pub(crate) async fn cancellable<T>(
    cancel: &CancellationToken,
    work: impl Future<Output = T>,
) -> Result<T, ReadwiseError> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(ReadwiseError::Cancelled),
        out = work => Ok(out),
    }
}

type Query = Vec<(&'static str, String)>;

#[derive(Clone)]
pub struct ReadwiseClient {
    http: reqwest::Client,
    origin: Url,
}

impl Default for ReadwiseClient {
    fn default() -> Self {
        Self::new()
    }
}

impl ReadwiseClient {
    /// readwise.io over the shared HTTP client.
    pub fn new() -> Self {
        let origin = Url::parse(READWISE_ORIGIN).expect("READWISE_ORIGIN is a URL");
        Self::with_origin(http::client(), origin)
    }

    /// Another origin: the e2e fake server and the tests. The token goes only to `origin`.
    pub fn with_origin(http: reqwest::Client, origin: Url) -> Self {
        Self { http, origin }
    }

    /// `GET /api/v2/auth/`: a 2xx means the token is valid.
    pub async fn verify_token(
        &self,
        token: &str,
        cancel: &CancellationToken,
    ) -> Result<(), ReadwiseError> {
        self.get(token, "/api/v2/auth/", &[], None, cancel)
            .await
            .map(drop)
    }

    /// Every page of `GET /api/v2/export/`, one list of books per page. `updated_after`: only
    /// highlights updated after this ISO 8601 date, grouped by book.
    pub fn export_pages(
        &self,
        token: &str,
        updated_after: Option<&str>,
        include_deleted: bool,
    ) -> Pages<ReadwiseBook> {
        let mut query = Query::new();
        if let Some(after) = updated_after {
            query.push(("updatedAfter", after.to_owned()));
        }
        if include_deleted {
            query.push(("includeDeleted", "true".to_owned()));
        }
        self.pages(token, "/api/v2/export/", None, [query])
    }

    /// Full books with every highlight, by `user_book_id`, in batches of
    /// [`EXPORT_IDS_BATCH_SIZE`] with duplicates dropped. No ids, no request.
    pub fn export_books(&self, token: &str, ids: &[i64]) -> Pages<ReadwiseBook> {
        let mut seen = HashSet::new();
        let ids: Vec<i64> = ids.iter().copied().filter(|id| seen.insert(*id)).collect();
        let queries = ids.chunks(EXPORT_IDS_BATCH_SIZE).map(|batch| {
            let joined = batch.iter().map(i64::to_string).collect::<Vec<_>>();
            vec![("ids", joined.join(","))]
        });
        self.pages(token, "/api/v2/export/", None, queries)
    }

    /// Top-level Reader documents of [`READER_LOCATIONS`], one list per page, each request
    /// through `limiter`. Child documents (highlights and notes made in Reader) and `feed` items
    /// are dropped.
    pub fn reader_documents(
        &self,
        token: &str,
        updated_after: Option<&str>,
        with_html_content: bool,
        limiter: Arc<RequestLimiter>,
    ) -> ReaderDocuments {
        let queries = READER_LOCATIONS.iter().map(|location| {
            let mut query = vec![("location", (*location).to_owned())];
            if let Some(after) = updated_after {
                query.push(("updatedAfter", after.to_owned()));
            }
            query.push(("limit", READER_PAGE_SIZE.to_string()));
            if with_html_content {
                query.push(("withHtmlContent", "true".to_owned()));
            }
            query
        });
        ReaderDocuments(self.pages(token, "/api/v3/list/", Some(limiter), queries))
    }

    /// One top-level Reader document by id, or `None` when Reader no longer has it or the id
    /// names a child or a `feed` item.
    pub async fn reader_document(
        &self,
        token: &str,
        id: &str,
        with_html_content: bool,
        limiter: Arc<RequestLimiter>,
        cancel: &CancellationToken,
    ) -> Result<Option<ReaderDocument>, ReadwiseError> {
        let mut query = vec![("id", id.to_owned())];
        if with_html_content {
            query.push(("withHtmlContent", "true".to_owned()));
        }
        let mut pages = self.pages(token, "/api/v3/list/", Some(limiter), [query]);
        while let Some(page) = pages.next(cancel).await? {
            check_reader_page(&page)?;
            if let Some(document) = page.into_iter().find(|row| row.id == id) {
                return Ok(top_level(&document).then_some(document));
            }
        }
        Ok(None)
    }

    fn pages<T>(
        &self,
        token: &str,
        path: &'static str,
        throttle: Option<Arc<RequestLimiter>>,
        queries: impl IntoIterator<Item = Query>,
    ) -> Pages<T> {
        Pages {
            client: self.clone(),
            token: token.to_owned(),
            path,
            throttle,
            queries: queries.into_iter().collect(),
            cursor: None,
            _items: std::marker::PhantomData,
        }
    }

    /// A 2xx response to `GET path?query`. Waits for `throttle` before every attempt, a retry
    /// after `429` included.
    async fn get(
        &self,
        token: &str,
        path: &str,
        query: &[(&str, String)],
        throttle: Option<&RequestLimiter>,
        cancel: &CancellationToken,
    ) -> Result<reqwest::Response, ReadwiseError> {
        let url = self.url(path, query);
        for attempt in 0.. {
            if let Some(limiter) = throttle {
                limiter.acquire(cancel).await?;
            }
            let sent = self
                .http
                .get(url.clone())
                .header(AUTHORIZATION, format!("Token {token}"))
                .timeout(REQUEST_TIMEOUT)
                .send();
            let response = cancellable(cancel, sent).await?.map_err(|error| {
                tracing::warn!(
                    path,
                    timeout = error.is_timeout(),
                    "Readwise request failed"
                );
                ReadwiseError::Network(error.without_url())
            })?;
            let status = response.status();
            if status.is_success() {
                return Ok(response);
            }
            match status {
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                    let body =
                        cancellable(cancel, http::read_capped(response, MAX_ERROR_BODY_BYTES))
                            .await?
                            .unwrap_or_default();
                    let status = status.as_u16();
                    return Err(if says_subscription_expired(&body) {
                        ReadwiseError::SubscriptionExpired { status }
                    } else {
                        ReadwiseError::InvalidToken { status }
                    });
                }
                StatusCode::TOO_MANY_REQUESTS => {
                    let header = response.headers().get(RETRY_AFTER);
                    let retry_after_secs =
                        retry_after_secs(header.and_then(|value| value.to_str().ok()));
                    if attempt >= MAX_RATE_LIMIT_RETRIES {
                        return Err(ReadwiseError::RateLimited { retry_after_secs });
                    }
                    tracing::info!(path, retry_after_secs, "Readwise rate limited, waiting");
                    let wait = Duration::from_secs(retry_after_secs);
                    cancellable(cancel, tokio::time::sleep(wait)).await?;
                }
                _ => {
                    return Err(ReadwiseError::Status {
                        status: status.as_u16(),
                    });
                }
            }
        }
        unreachable!("the attempt loop returns")
    }

    fn url(&self, path: &str, query: &[(&str, String)]) -> Url {
        let mut url = self.origin.clone();
        url.set_path(path);
        if !query.is_empty() {
            url.query_pairs_mut()
                .extend_pairs(query.iter().map(|(key, value)| (*key, value.as_str())));
        }
        url
    }
}

/// `parseRetryAfterSeconds`: whole seconds, rounded up, at most 120; 60 for a header that is
/// missing, negative or not a decimal number.
pub(crate) fn retry_after_secs(header: Option<&str>) -> u64 {
    let seconds = header.and_then(|value| value.trim().parse::<f64>().ok());
    match seconds {
        Some(seconds) if seconds.is_finite() && seconds >= 0.0 => {
            // In range after `min`, so the cast is exact.
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let capped = seconds.ceil().min(MAX_RETRY_AFTER_SECS as f64) as u64;
            capped
        }
        _ => DEFAULT_RETRY_AFTER_SECS,
    }
}

/// `saysSubscriptionExpired`: an auth failure whose JSON `detail` names the subscription. JS's
/// `/i` without `u` folds only ASCII letters, as `to_ascii_lowercase` does.
pub(crate) fn says_subscription_expired(body: &[u8]) -> bool {
    let Ok(Value::Object(fields)) = serde_json::from_slice::<Value>(body) else {
        return false;
    };
    let Some(Value::String(detail)) = fields.get("detail") else {
        return false;
    };
    let detail = detail.to_ascii_lowercase();
    ["subscription", "expired", "trial"]
        .iter()
        .any(|word| detail.contains(word))
}

#[derive(Deserialize)]
struct RawPage<T> {
    #[serde(rename = "nextPageCursor")]
    next_page_cursor: Option<String>,
    results: Vec<T>,
}

pub(crate) fn parse_page<T: DeserializeOwned>(
    body: &[u8],
) -> Result<(Vec<T>, Option<String>), ReadwiseError> {
    let page: RawPage<T> = serde_json::from_slice(body).map_err(|_| ReadwiseError::UnknownShape)?;
    Ok((page.results, page.next_page_cursor))
}

/// Every page of a cursor-paginated endpoint, for each query in turn (one per id batch or
/// Reader location).
pub struct Pages<T> {
    client: ReadwiseClient,
    token: String,
    path: &'static str,
    throttle: Option<Arc<RequestLimiter>>,
    queries: VecDeque<Query>,
    cursor: Option<Cursor>,
    _items: std::marker::PhantomData<fn() -> T>,
}

/// Where the current query stands.
enum Cursor {
    Next(String, HashSet<String>),
    /// The server sent a cursor it sent before. Its page was handed out; the next call fails.
    Repeated,
}

impl<T: DeserializeOwned> Pages<T> {
    /// The next page, or `None` after the last.
    pub async fn next(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<Option<Vec<T>>, ReadwiseError> {
        let (query, seen) = match self.cursor.take() {
            Some(Cursor::Repeated) => return Err(ReadwiseError::RepeatedCursor),
            Some(Cursor::Next(cursor, seen)) => {
                let mut query = self.queries.front().cloned().unwrap_or_default();
                query.push(("pageCursor", cursor));
                (query, seen)
            }
            None => match self.queries.front() {
                Some(query) => (query.clone(), HashSet::new()),
                None => return Ok(None),
            },
        };
        let throttle = self.throttle.as_deref();
        let response = (self.client)
            .get(&self.token, self.path, &query, throttle, cancel)
            .await?;
        let body = match cancellable(cancel, http::read_capped(response, MAX_PAGE_BYTES)).await? {
            Ok(body) => body,
            Err(ReadError::TooLarge { .. }) => return Err(ReadwiseError::TooLarge),
            // Electron reads a body it could not finish as no JSON: an unknown shape.
            Err(ReadError::Transport(_)) => return Err(ReadwiseError::UnknownShape),
        };
        let (results, next) = parse_page::<T>(&body)?;
        self.cursor = next.map(|cursor| {
            let mut seen = seen;
            if seen.insert(cursor.clone()) {
                Cursor::Next(cursor, seen)
            } else {
                Cursor::Repeated
            }
        });
        if self.cursor.is_none() {
            self.queries.pop_front();
        }
        Ok(Some(results))
    }
}

/// [`ReadwiseClient::reader_documents`].
pub struct ReaderDocuments(Pages<ReaderDocument>);

impl ReaderDocuments {
    /// The next page's top-level documents (possibly none), or `None` after the last page.
    pub async fn next(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<Option<Vec<ReaderDocument>>, ReadwiseError> {
        let Some(page) = self.0.next(cancel).await? else {
            return Ok(None);
        };
        check_reader_page(&page)?;
        let documents: Vec<ReaderDocument> = page.into_iter().filter(top_level).collect();
        Ok(Some(documents))
    }
}

fn top_level(document: &ReaderDocument) -> bool {
    document.parent_id.is_none() && document.location.as_deref() != Some("feed")
}

/// The page refusal Electron's schema makes on `tags`
/// (`z.record(z.string(), z.object({ name: z.string().nullish() }))`): an object of objects
/// whose `name` is a string or null. The planner keeps any JSON, so its own `ReaderTag` failure
/// is for input that did not come through here.
fn check_reader_page(page: &[ReaderDocument]) -> Result<(), ReadwiseError> {
    let tag_ok = |tag: &Value| match tag {
        Value::Object(fields) => matches!(
            fields.get("name"),
            None | Some(Value::Null | Value::String(_))
        ),
        _ => false,
    };
    let ok = page.iter().all(|document| match &document.tags {
        None => true,
        Some(Value::Object(tags)) => tags.values().all(tag_ok),
        Some(_) => false,
    });
    if ok {
        Ok(())
    } else {
        Err(ReadwiseError::UnknownShape)
    }
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
