//! The CalDAV object requests a pull and a push make (`caldav/caldav-client.ts:236-483`), over the
//! account's [`Transport`], with failures mapped onto [`DavError`] here so nothing above reads an
//! HTTP status. The request bodies are the ones `tsdav` 2.3.4 builds for Electron.

use reqwest::Method;
use url::Url;

use super::caldav_transport::{Reply, Transport, TransportError};
use super::caldav_xml::{DavResponse, parse_multistatus_with_token};

const NAMESPACES: &str = "xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\" \
     xmlns:cs=\"http://calendarserver.org/ns/\" xmlns:ca=\"http://apple.com/ns/ical/\"";
const XML_HEAD: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n";
/// `fetchObjects`: servers cap multiget sizes; 100 per request stays inside every limit seen.
const MULTIGET_BATCH: usize = 100;
/// `providerErrorForStatus`'s default when a 429 names no `Retry-After`.
const DEFAULT_RETRY_AFTER_MS: u64 = 60_000;

/// `ProviderError`, the taxonomy `classifyCaldavFailure` maps onto.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DavError {
    /// 401, or 403 on a read: the server refused the password.
    #[error("the CalDAV server refused the credentials ({0})")]
    Auth(u16),
    /// 412: the object changed (or exists) since the ETag the request carried.
    #[error("the CalDAV object changed on the server")]
    Conflict,
    /// The `valid-sync-token` precondition failed: the cursor is stale.
    #[error("the CalDAV sync token is no longer valid")]
    TokenGone,
    #[error("the CalDAV server asked to wait {0} ms")]
    RateLimited(u64),
    /// 5xx, a timeout, a connection that failed.
    #[error("the CalDAV server cannot answer now: {0}")]
    Transient(String),
    /// Anything else (a 403 or 409 on a write, a malformed answer).
    #[error("the CalDAV request failed: {0}")]
    Failed(String),
}

/// One object as the server answered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DavObject {
    pub href: String,
    pub etag: Option<String>,
    pub data: String,
}

/// `SyncCollectionResult`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SyncChanges {
    pub changed: Vec<String>,
    pub deleted: Vec<String>,
    pub token: Option<String>,
}

/// `If-None-Match: *` for a create, `If-Match` for an update.
pub enum Precondition<'a> {
    Create,
    Match(&'a str),
}

/// `providerErrorForStatus`.
fn for_status(status: u16, retry_after: Option<&str>, forbidden_is_auth: bool) -> Option<DavError> {
    if status == 401 || (status == 403 && forbidden_is_auth) {
        return Some(DavError::Auth(status));
    }
    if status == 412 {
        return Some(DavError::Conflict);
    }
    let seconds = retry_after.and_then(|v| v.trim().parse::<f64>().ok());
    if status == 429 || (status == 503 && seconds.is_some()) {
        let ms = seconds
            .filter(|s| *s > 0.0)
            .map_or(DEFAULT_RETRY_AFTER_MS, |s| (s * 1000.0) as u64);
        return Some(DavError::RateLimited(ms));
    }
    (status >= 500).then(|| DavError::Transient(format!("server error {status}")))
}

fn failed(reply: &Reply, what: &str, forbidden_is_auth: bool) -> DavError {
    for_status(
        reply.status,
        reply.retry_after.as_deref(),
        forbidden_is_auth,
    )
    .unwrap_or_else(|| DavError::Failed(format!("{what}: {}", reply.status)))
}

impl From<TransportError> for DavError {
    fn from(error: TransportError) -> Self {
        match error {
            TransportError::Timeout | TransportError::Network(_) => {
                Self::Transient(error.to_string())
            }
            other => Self::Failed(other.to_string()),
        }
    }
}

fn ok(status: u16) -> bool {
    (200..300).contains(&status)
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

async fn send(
    transport: &Transport,
    method: &[u8],
    url: &Url,
    depth: Option<&'static str>,
    body: Option<String>,
    headers: Vec<(&'static str, String)>,
) -> Result<Reply, DavError> {
    let method = Method::from_bytes(method).map_err(|e| DavError::Failed(e.to_string()))?;
    Ok(transport
        .request(crate::calendar_providers::caldav_transport::DavRequest {
            method,
            url: url.clone(),
            depth,
            body,
            follow: true,
            headers,
        })
        .await?)
}

/// The responses of a 2xx multistatus, with its sync token. A read that failed maps its status.
async fn report(
    transport: &Transport,
    method: &[u8],
    url: &Url,
    depth: &'static str,
    body: String,
    what: &str,
) -> Result<(Vec<DavResponse>, Option<String>), DavError> {
    let reply = send(transport, method, url, Some(depth), Some(body), Vec::new()).await?;
    if !ok(reply.status) {
        let text = String::from_utf8_lossy(&reply.body);
        if matches!(reply.status, 400 | 403 | 409) && text.contains("valid-sync-token") {
            return Err(DavError::TokenGone);
        }
        return Err(failed(&reply, what, true));
    }
    let text = std::str::from_utf8(&reply.body)
        .map_err(|_| DavError::Failed(format!("{what}: not UTF-8")))?;
    parse_multistatus_with_token(text)
        .map_err(|e| DavError::Failed(format!("{what}: {e}")))?
        .ok_or_else(|| DavError::Failed(format!("{what}: not a multistatus")))
}

fn resolve(href: &str, base: &Url) -> Option<Url> {
    base.join(href).ok()
}

/// `isObjectHref`: a member, not the collection or a sub-collection.
fn object_url(href: &str, collection: &Url) -> Option<Url> {
    let url = resolve(href, collection)?;
    (url != *collection && !url.path().ends_with('/')).then_some(url)
}

fn status_of(response: &DavResponse) -> u16 {
    response.status.unwrap_or(200)
}

/// `objectsFrom`: the 2xx responses that carry data.
fn objects(responses: Vec<DavResponse>, collection: &Url) -> Vec<DavObject> {
    responses
        .into_iter()
        .filter(|r| ok(status_of(r)))
        .filter_map(|r| {
            let href = resolve(r.href.as_deref()?, collection)?;
            Some(DavObject {
                href: href.to_string(),
                etag: r.props.getetag,
                data: r.props.calendar_data?,
            })
        })
        .collect()
}

/// `toCaldavTime`: `20250101T000000Z`.
fn caldav_time(ms: i64) -> String {
    jiff::Timestamp::from_millisecond(ms)
        .map(|t| t.strftime("%Y%m%dT%H%M%SZ").to_string())
        .unwrap_or_default()
}

/// `queryObjectsInWindow`: the objects whose events touch the window, with data.
pub async fn query_window(
    transport: &Transport,
    collection: &Url,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<DavObject>, DavError> {
    let body = format!(
        "{XML_HEAD}<c:calendar-query {NAMESPACES}><d:prop><d:getetag/><c:calendar-data/></d:prop>\
         <c:filter><c:comp-filter name=\"VCALENDAR\"><c:comp-filter name=\"VEVENT\">\
         <c:time-range start=\"{}\" end=\"{}\"/></c:comp-filter></c:comp-filter></c:filter>\
         </c:calendar-query>",
        caldav_time(start_ms),
        caldav_time(end_ms)
    );
    let (responses, _) = report(transport, b"REPORT", collection, "1", body, "query").await?;
    Ok(objects(responses, collection))
}

/// `fetchObjects`: `calendar-multiget` for exactly these objects, by path.
pub async fn multiget(
    transport: &Transport,
    collection: &Url,
    hrefs: &[String],
) -> Result<Vec<DavObject>, DavError> {
    let mut out = Vec::new();
    for batch in hrefs.chunks(MULTIGET_BATCH) {
        let paths: String = batch
            .iter()
            .filter_map(|href| Url::parse(href).ok())
            .map(|url| format!("<d:href>{}</d:href>", escape(url.path())))
            .collect();
        let body = format!(
            "{XML_HEAD}<c:calendar-multiget {NAMESPACES}><d:prop><d:getetag/><c:calendar-data/>\
             </d:prop>{paths}</c:calendar-multiget>"
        );
        let (responses, _) =
            report(transport, b"REPORT", collection, "1", body, "multiget").await?;
        out.extend(objects(responses, collection));
    }
    Ok(out)
}

/// `listObjectEtags`: every object in the collection with its ETag, no data.
pub async fn list_etags(
    transport: &Transport,
    collection: &Url,
) -> Result<Vec<(String, Option<String>)>, DavError> {
    let body =
        format!("{XML_HEAD}<d:propfind {NAMESPACES}><d:prop><d:getetag/></d:prop></d:propfind>");
    let (responses, _) = report(transport, b"PROPFIND", collection, "1", body, "list").await?;
    Ok(responses
        .into_iter()
        .filter(|r| ok(status_of(r)))
        .filter_map(|r| {
            let url = object_url(r.href.as_deref()?, collection)?;
            Some((url.to_string(), r.props.getetag))
        })
        .collect())
}

/// `fetchCollectionCtag`: the ctag, else the sync token, else `None`.
pub async fn collection_tag(
    transport: &Transport,
    collection: &Url,
) -> Result<Option<String>, DavError> {
    let body = format!(
        "{XML_HEAD}<d:propfind {NAMESPACES}><d:prop><cs:getctag/><d:sync-token/></d:prop></d:propfind>"
    );
    let (responses, _) = report(transport, b"PROPFIND", collection, "0", body, "ctag").await?;
    let props = responses.into_iter().next().map(|r| r.props);
    Ok(props.and_then(|p| p.getctag.or(p.sync_token)))
}

/// `syncCollectionChanges` (RFC 6578). An empty token lists everything.
pub async fn sync_collection(
    transport: &Transport,
    collection: &Url,
    token: &str,
) -> Result<SyncChanges, DavError> {
    let body = format!(
        "{XML_HEAD}<d:sync-collection {NAMESPACES}><d:sync-token>{}</d:sync-token>\
         <d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>",
        escape(token)
    );
    let (responses, token) = report(
        transport,
        b"REPORT",
        collection,
        "1",
        body,
        "sync-collection",
    )
    .await?;
    let mut changes = SyncChanges {
        token,
        ..SyncChanges::default()
    };
    for response in responses {
        let Some(url) = response
            .href
            .as_deref()
            .and_then(|h| object_url(h, collection))
        else {
            continue;
        };
        match status_of(&response) {
            404 => changes.deleted.push(url.to_string()),
            status if ok(status) => changes.changed.push(url.to_string()),
            _ => {}
        }
    }
    Ok(changes)
}

/// `getObject`: `None` when it is gone (404, 410).
pub async fn get(transport: &Transport, href: &str) -> Result<Option<DavObject>, DavError> {
    let url = Url::parse(href).map_err(|e| DavError::Failed(e.to_string()))?;
    let reply = send(transport, b"GET", &url, None, None, Vec::new()).await?;
    if matches!(reply.status, 404 | 410) {
        return Ok(None);
    }
    if !ok(reply.status) {
        return Err(failed(&reply, "GET object", true));
    }
    Ok(Some(DavObject {
        href: href.to_owned(),
        etag: reply.etag,
        data: String::from_utf8_lossy(&reply.body).into_owned(),
    }))
}

/// `putObject`: the new ETag when the server sends one. A 403 is a calendar that refuses the
/// write, not the password.
pub async fn put(
    transport: &Transport,
    href: &str,
    data: &str,
    precondition: Precondition<'_>,
) -> Result<Option<String>, DavError> {
    let url = Url::parse(href).map_err(|e| DavError::Failed(e.to_string()))?;
    let mut headers = vec![("Content-Type", "text/calendar; charset=utf-8".to_owned())];
    headers.push(match precondition {
        Precondition::Create => ("If-None-Match", "*".to_owned()),
        Precondition::Match(etag) => ("If-Match", etag.to_owned()),
    });
    let reply = send(
        transport,
        b"PUT",
        &url,
        None,
        Some(data.to_owned()),
        headers,
    )
    .await?;
    if !ok(reply.status) {
        return Err(failed(&reply, "PUT object", false));
    }
    Ok(reply.etag)
}

/// `deleteObject` with `If-Match`; an object already gone counts as deleted.
pub async fn delete(transport: &Transport, href: &str, etag: Option<&str>) -> Result<(), DavError> {
    let url = Url::parse(href).map_err(|e| DavError::Failed(e.to_string()))?;
    let headers = etag
        .map(|etag| vec![("If-Match", etag.to_owned())])
        .unwrap_or_default();
    let reply = send(transport, b"DELETE", &url, None, None, headers).await?;
    if ok(reply.status) || matches!(reply.status, 404 | 410) {
        return Ok(());
    }
    Err(failed(&reply, "DELETE object", false))
}
