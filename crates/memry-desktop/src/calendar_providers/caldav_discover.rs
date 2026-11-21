//! CalDAV discovery (`caldav/caldav-client.ts:52-229` over tsdav 2.3.4's `createAccount`):
//! `/.well-known/caldav`, then `current-user-principal` on each candidate root, then
//! `calendar-home-set`, then the home's collections. Hosts come from the server's answers, never
//! from a list; the [`Transport`] decides where credentials go. Collections that cannot hold
//! events (VTODO-only task lists) are skipped.

use reqwest::Method;
use url::Url;

use super::caldav_transport::{DavRequest, Failure, Reply, Transport, TransportError};
use super::caldav_xml::{DavProps, parse_multistatus};

/// One collection that holds events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarInfo {
    pub url: String,
    pub display_name: String,
    pub color: Option<String>,
    pub timezone: Option<String>,
    pub ctag: Option<String>,
    pub sync_token: Option<String>,
    pub supports_sync_collection: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountInfo {
    pub server_url: String,
    pub principal_url: String,
    pub home_url: String,
    pub calendars: Vec<CalendarInfo>,
}

/// Why discovery stopped, before it is classified against the transport's last status.
#[derive(Debug, thiserror::Error)]
pub enum DiscoverError {
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error("{0}")]
    Dav(&'static str),
}

/// `CaldavConnectErrorCode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ConnectCode {
    InvalidUrl,
    Unauthorized,
    Unreachable,
    NotCaldav,
    NoCalendars,
    OutdatedDevices,
}

impl ConnectCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidUrl => "invalid_url",
            Self::Unauthorized => "unauthorized",
            Self::Unreachable => "unreachable",
            Self::NotCaldav => "not_caldav",
            Self::NoCalendars => "no_calendars",
            Self::OutdatedDevices => "outdated_devices",
        }
    }
}

/// `connectFailure(error, classifyCaldavFailure(error, transport))`: the last error status
/// first (401 and 403 are the password, 412, 429 and 5xx a server that cannot answer now), then
/// a timeout or a connection that failed, else the server is not CalDAV. A redirect nowhere is a
/// `TypeError` in Electron, so it reads as unreachable too; an answer past the size cap is not
/// CalDAV.
pub fn classify(error: &DiscoverError, last: Option<&Failure>) -> ConnectCode {
    match last.map(|failure| failure.status) {
        Some(401 | 403) => return ConnectCode::Unauthorized,
        Some(412 | 429 | 500..) => return ConnectCode::Unreachable,
        _ => {}
    }
    match error {
        DiscoverError::Transport(
            TransportError::Timeout
            | TransportError::Network(_)
            | TransportError::BadRedirect
            | TransportError::BadHeader,
        ) => ConnectCode::Unreachable,
        DiscoverError::Transport(TransportError::TooLarge(_)) | DiscoverError::Dav(_) => {
            ConnectCode::NotCaldav
        }
    }
}

const NAMESPACES: &str = "xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\" \
     xmlns:cs=\"http://calendarserver.org/ns/\" xmlns:ca=\"http://apple.com/ns/ical/\"";

fn propfind_body(props: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<d:propfind {NAMESPACES}><d:prop>{props}</d:prop></d:propfind>"
    )
}

/// One `<response>` as tsdav reports it, or the HTTP answer alone when it is not a multistatus.
struct Entry {
    href: Option<String>,
    ok: bool,
    status: u16,
    props: DavProps,
}

fn ok(status: u16) -> bool {
    (200..300).contains(&status)
}

/// `davRequest`'s answer: the parsed responses of a 2xx XML multistatus, else one entry for the
/// HTTP response itself (`href` its URL).
fn entries(reply: &Reply) -> Vec<Entry> {
    let alone = || {
        vec![Entry {
            href: Some(reply.url.to_string()),
            ok: ok(reply.status),
            status: reply.status,
            props: DavProps::default(),
        }]
    };
    let xml = reply
        .content_type
        .as_deref()
        .is_some_and(|t| t.to_ascii_lowercase().contains("xml"));
    if !ok(reply.status) || !xml || reply.body.is_empty() {
        return alone();
    }
    let Some(responses) = std::str::from_utf8(&reply.body)
        .ok()
        .and_then(|text| parse_multistatus(text).ok().flatten())
    else {
        return alone();
    };
    if responses.is_empty() {
        let mut only = alone();
        only[0].href = None;
        return only;
    }
    responses
        .into_iter()
        .map(|response| {
            let status = response.status.unwrap_or(reply.status);
            Entry {
                href: response.href,
                ok: ok(status),
                status,
                props: response.props,
            }
        })
        .collect()
}

async fn propfind(
    transport: &Transport,
    url: &Url,
    depth: &'static str,
    props: &str,
) -> Result<Vec<Entry>, DiscoverError> {
    let reply = transport
        .request(DavRequest {
            method: Method::from_bytes(b"PROPFIND").expect("PROPFIND is a method"),
            url: url.clone(),
            depth: Some(depth),
            body: Some(propfind_body(props)),
            follow: true,
        })
        .await?;
    Ok(entries(&reply))
}

/// `ensureTrailingSlash`.
fn with_trailing_slash(url: &Url) -> Url {
    let mut out = url.clone();
    if !out.path().ends_with('/') {
        let path = format!("{}/", out.path());
        out.set_path(&path);
    }
    out
}

/// `normalizeUrl`: trimmed, one trailing slash dropped.
fn normalized(url: &str) -> &str {
    let trimmed = url.trim();
    trimmed.strip_suffix('/').unwrap_or(trimmed)
}

/// `urlMatches(a, b, base)`.
fn url_matches(a: &Url, b: Option<&str>, base: &Url) -> bool {
    let Some(b) = b else {
        return false;
    };
    match base.join(b) {
        Ok(b) => normalized(a.as_str()) == normalized(b.as_str()),
        Err(_) => normalized(a.as_str()) == normalized(b),
    }
}

/// `serviceDiscovery`: a redirect from `/.well-known/caldav`, first to a `PROPFIND`, then to a
/// `GET`; otherwise the server URL. A failure here is not a discovery failure.
async fn service_root(transport: &Transport, server: &Url) -> Url {
    let Ok(well_known) = server.join("/.well-known/caldav") else {
        return server.clone();
    };
    let attempts = [
        (
            Method::from_bytes(b"PROPFIND").expect("PROPFIND is a method"),
            Some(propfind_body("<d:resourcetype/>")),
        ),
        (Method::GET, None),
    ];
    for (method, body) in attempts {
        let reply = transport
            .request(DavRequest {
                method,
                url: well_known.clone(),
                depth: None,
                body,
                follow: false,
            })
            .await;
        let Ok(reply) = reply else { continue };
        if !(300..400).contains(&reply.status) {
            continue;
        }
        let Some(mut service) = reply.location.and_then(|l| server.join(&l).ok()) else {
            continue;
        };
        if service.host_str() == well_known.host_str()
            && well_known.port().is_some()
            && service.port().is_none()
        {
            let _ = service.set_port(well_known.port());
        }
        return service;
    }
    server.clone()
}

/// `fetchPrincipalUrl`.
async fn principal(transport: &Transport, root: &Url) -> Result<Url, DiscoverError> {
    let found = propfind(transport, root, "0", "<d:current-user-principal/>").await?;
    let first = found
        .into_iter()
        .next()
        .filter(|entry| entry.ok)
        .ok_or(DiscoverError::Dav("cannot find principalUrl"))?;
    let href = first
        .props
        .current_user_principal
        .ok_or(DiscoverError::Dav("cannot find principalUrl"))?;
    with_trailing_slash(root)
        .join(&href)
        .map_err(|_| DiscoverError::Dav("cannot find principalUrl"))
}

/// `fetchHomeUrl`.
async fn home(transport: &Transport, principal: &Url, root: &Url) -> Result<Url, DiscoverError> {
    let found = propfind(transport, principal, "0", "<c:calendar-home-set/>").await?;
    let matched = found
        .into_iter()
        .find(|entry| url_matches(principal, entry.href.as_deref(), root))
        .filter(|entry| entry.ok)
        .ok_or(DiscoverError::Dav("cannot find homeUrl"))?;
    let href = matched
        .props
        .calendar_home_set
        .ok_or(DiscoverError::Dav("cannot find homeUrl"))?;
    with_trailing_slash(root)
        .join(&href)
        .map_err(|_| DiscoverError::Dav("cannot find homeUrl"))
}

/// `normalizeColor`: `#RRGGBBAA` (Apple) and `#RRGGBB` become `#rrggbb`; anything else is
/// dropped.
fn color(value: Option<&str>) -> Option<String> {
    let hex = value?.trim().strip_prefix('#')?;
    let valid = matches!(hex.len(), 6 | 8) && hex.bytes().all(|b| b.is_ascii_hexdigit());
    valid.then(|| format!("#{}", hex[..6].to_ascii_lowercase()))
}

/// `extractTimezoneId` (`/^TZID:(.+)$/im`): the first `TZID:` line with a value, trimmed (so
/// `TZID: ` gives an empty id, as in Electron).
fn timezone_id(vcalendar: Option<&str>) -> Option<String> {
    vcalendar?
        .split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .find_map(|line| {
            let (key, value) = line.split_at_checked(5)?;
            (key.eq_ignore_ascii_case("TZID:") && !value.is_empty())
                .then(|| value.trim().to_owned())
        })
}

fn calendar(entry: Entry, home: &Url) -> Option<CalendarInfo> {
    let props = entry.props;
    let is_calendar = props
        .resource_types
        .as_ref()
        .is_some_and(|types| types.iter().any(|t| t == "calendar"));
    if !is_calendar {
        return None;
    }
    let components = props.components.unwrap_or_default();
    if !components.is_empty() && !components.iter().any(|c| c == "VEVENT") {
        return None;
    }
    let url = home.join(&entry.href?).ok()?;
    let fallback = || {
        url.path()
            .split('/')
            .rfind(|segment| !segment.is_empty())
            .map_or_else(|| url.to_string(), str::to_owned)
    };
    let reports = props.reports.unwrap_or_default();
    Some(CalendarInfo {
        display_name: props
            .display_name
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(fallback),
        color: color(props.calendar_color.as_deref()),
        timezone: timezone_id(props.calendar_timezone.as_deref()),
        supports_sync_collection: reports.iter().any(|r| r == "sync-collection")
            || props.sync_token.is_some(),
        ctag: props.getctag,
        sync_token: props.sync_token,
        url: url.to_string(),
    })
}

const LISTING_PROPS: &str = "<d:displayname/><d:resourcetype/><cs:getctag/><d:sync-token/>\
     <ca:calendar-color/><c:calendar-timezone/><c:supported-calendar-component-set/>\
     <d:supported-report-set/>";

/// `discoverCaldavAccount`: every root candidate (`getCandidateRootUrls`: the discovered root,
/// the server URL, the server's `/`) until one names a principal, then its home and the home's
/// calendars.
pub async fn discover(transport: &Transport, server: &Url) -> Result<AccountInfo, DiscoverError> {
    let discovered = service_root(transport, server).await;
    let mut candidates: Vec<Url> = Vec::new();
    for candidate in [
        Some(discovered),
        Some(server.clone()),
        server.join("/").ok(),
    ]
    .into_iter()
    .flatten()
    {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    let mut found = None;
    let mut last_error = DiscoverError::Dav("cannot find principalUrl");
    for root in candidates {
        match principal(transport, &root).await {
            Ok(principal) => {
                found = Some((root, principal));
                break;
            }
            Err(error) => last_error = error,
        }
    }
    let (root, principal) = found.ok_or(last_error)?;
    let home = home(transport, &principal, &root).await?;

    let listing = propfind(transport, &home, "1", LISTING_PROPS).await?;
    if listing.iter().any(|entry| !entry.ok && entry.status != 404) {
        return Err(DiscoverError::Dav("Calendar listing failed"));
    }
    let calendars = listing
        .into_iter()
        .filter_map(|entry| calendar(entry, &home))
        .collect();
    Ok(AccountInfo {
        server_url: server.to_string(),
        principal_url: principal.to_string(),
        home_url: home.to_string(),
        calendars,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors_and_zones_read_as_electron_reads_them() {
        assert_eq!(color(Some("#FF2968FF")).as_deref(), Some("#ff2968"));
        assert_eq!(color(Some(" #a1B2c3 ")).as_deref(), Some("#a1b2c3"));
        assert_eq!(color(Some("#abc")), None);
        assert_eq!(color(Some("red")), None);
        let zone = "BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\ntzid:Europe/Istanbul \r\nEND:VTIMEZONE";
        assert_eq!(timezone_id(Some(zone)).as_deref(), Some("Europe/Istanbul"));
        assert_eq!(timezone_id(Some("X-TZID:Nope")), None);
        assert_eq!(timezone_id(Some("TZID:\nTZID:UTC")).as_deref(), Some("UTC"));
        assert_eq!(timezone_id(Some("TZID: ")).as_deref(), Some(""));
    }

    #[test]
    fn the_last_status_decides_before_the_error() {
        let failure = |status| Failure {
            status,
            retry_after: None,
        };
        let dav = DiscoverError::Dav("cannot find homeUrl");
        assert_eq!(
            classify(&dav, Some(&failure(401))),
            ConnectCode::Unauthorized
        );
        assert_eq!(
            classify(&dav, Some(&failure(403))),
            ConnectCode::Unauthorized
        );
        assert_eq!(
            classify(&dav, Some(&failure(503))),
            ConnectCode::Unreachable
        );
        assert_eq!(
            classify(&dav, Some(&failure(429))),
            ConnectCode::Unreachable
        );
        assert_eq!(classify(&dav, Some(&failure(405))), ConnectCode::NotCaldav);
        assert_eq!(classify(&dav, None), ConnectCode::NotCaldav);
        let timeout = DiscoverError::Transport(TransportError::Timeout);
        assert_eq!(classify(&timeout, None), ConnectCode::Unreachable);
        assert_eq!(
            classify(&timeout, Some(&failure(401))),
            ConnectCode::Unauthorized
        );
    }

    #[test]
    fn hrefs_match_after_resolving_and_one_trailing_slash() {
        let base = Url::parse("https://dav.example/").unwrap();
        let principal = Url::parse("https://dav.example/p/u/").unwrap();
        assert!(url_matches(&principal, Some("/p/u"), &base));
        assert!(url_matches(
            &principal,
            Some("https://dav.example/p/u/"),
            &base
        ));
        assert!(!url_matches(&principal, Some("/p/other/"), &base));
        assert!(!url_matches(&principal, None, &base));
    }
}
