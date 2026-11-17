//! The HTTP half of a subscribed calendar (`ics/ics-fetch.ts`): a conditional GET of the feed,
//! redirects followed by hand so each hop is checked, one deadline over every hop and the body,
//! and the body read under a cap. The feed text is untrusted; the core parses it under its own
//! bounds (`ical::budget`).
//!
//! Unlike Electron, only `https` is fetched: an `http://` link is refused as `invalid_url` and a
//! redirect to `http://` as `unsupported_redirect` (`webcal(s)://` is already `https://` after
//! `ics::normalize_url`).

use std::time::Duration;

use memry_core::api::calendar_providers::CalendarFetchedFeed;
use reqwest::header::{
    ACCEPT, ETAG, HeaderMap, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, LOCATION,
};
use reqwest::redirect::Policy;
use serde::Serialize;
use url::Url;

use crate::http::{ReadError, read_capped};

/// `FETCH_TIMEOUT_MS`: one deadline for the whole exchange.
pub const TIMEOUT: Duration = Duration::from_secs(30);
/// `MAX_FEED_BYTES`.
pub const MAX_FEED_BYTES: usize = 20 * 1024 * 1024;
/// `MAX_REDIRECTS`: feed hosts redirect once or twice; more is a loop or a hop chain.
pub const MAX_REDIRECTS: usize = 5;
const REDIRECT_STATUSES: [u16; 5] = [301, 302, 303, 307, 308];
const ACCEPT_FEED: &str = "text/calendar, text/plain;q=0.9, */*;q=0.5";

/// `IcsFeedErrorCode` (`packages/contracts/src/calendar-api.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum IcsFeedCode {
    InvalidUrl,
    Unreachable,
    Timeout,
    NotFound,
    Unauthorized,
    HttpError,
    TooLarge,
    NotACalendar,
    TooManyRedirects,
    UnsupportedRedirect,
}

impl IcsFeedCode {
    const ALL: [Self; 10] = [
        Self::InvalidUrl,
        Self::Unreachable,
        Self::Timeout,
        Self::NotFound,
        Self::Unauthorized,
        Self::HttpError,
        Self::TooLarge,
        Self::NotACalendar,
        Self::TooManyRedirects,
        Self::UnsupportedRedirect,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidUrl => "invalid_url",
            Self::Unreachable => "unreachable",
            Self::Timeout => "timeout",
            Self::NotFound => "not_found",
            Self::Unauthorized => "unauthorized",
            Self::HttpError => "http_error",
            Self::TooLarge => "too_large",
            Self::NotACalendar => "not_a_calendar",
            Self::TooManyRedirects => "too_many_redirects",
            Self::UnsupportedRedirect => "unsupported_redirect",
        }
    }

    /// A code the core returned (`StorageError::Invalid { what }` of `feed_*`).
    pub fn from_code(code: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == code)
    }
}

impl std::fmt::Display for IcsFeedCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fetched {
    NotModified,
    Body(CalendarFetchedFeed),
}

pub struct IcsFetcher {
    client: reqwest::Client,
    timeout: Duration,
}

impl IcsFetcher {
    /// `builder` is the app's ([`crate::http::builder`]); redirects are turned off on it, since
    /// each hop is checked here. `timeout` is [`TIMEOUT`] in the app.
    pub fn new(builder: reqwest::ClientBuilder, timeout: Duration) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: builder.redirect(Policy::none()).build()?,
            timeout,
        })
    }

    /// `fetchIcsFeed`: GETs `url` (normalised), sending the validators of this device's last
    /// good response.
    pub async fn fetch(
        &self,
        url: &str,
        etag: Option<&str>,
        last_modified: Option<&str>,
    ) -> Result<Fetched, IcsFeedCode> {
        tokio::time::timeout(self.timeout, self.exchange(url, etag, last_modified))
            .await
            .unwrap_or(Err(IcsFeedCode::Timeout))
    }

    async fn exchange(
        &self,
        url: &str,
        etag: Option<&str>,
        last_modified: Option<&str>,
    ) -> Result<Fetched, IcsFeedCode> {
        let mut current = Url::parse(url)
            .ok()
            .filter(|u| u.scheme() == "https" && u.has_host())
            .ok_or(IcsFeedCode::InvalidUrl)?;
        let mut redirects = 0;
        let response = loop {
            let mut request = self.client.get(current.clone()).header(ACCEPT, ACCEPT_FEED);
            if let Some(etag) = etag {
                request = request.header(IF_NONE_MATCH, etag);
            }
            if let Some(last_modified) = last_modified {
                request = request.header(IF_MODIFIED_SINCE, last_modified);
            }
            let response = request.send().await.map_err(|error| {
                tracing::debug!(scope = "calendar_ics", "feed request failed: {error}");
                IcsFeedCode::Unreachable
            })?;
            if !REDIRECT_STATUSES.contains(&response.status().as_u16()) {
                break response;
            }
            if redirects >= MAX_REDIRECTS {
                return Err(IcsFeedCode::TooManyRedirects);
            }
            redirects += 1;
            current = redirect_target(response.headers(), &current)?;
        };

        let status = response.status().as_u16();
        if status == 304 {
            return Ok(Fetched::NotModified);
        }
        if !response.status().is_success() {
            return Err(match status {
                404 | 410 => IcsFeedCode::NotFound,
                401 | 403 => IcsFeedCode::Unauthorized,
                _ => IcsFeedCode::HttpError,
            });
        }
        let header = |name| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let (etag, last_modified) = (header(ETAG), header(LAST_MODIFIED));
        let body = read_capped(response, MAX_FEED_BYTES)
            .await
            .map_err(|error| match error {
                ReadError::TooLarge { .. } => IcsFeedCode::TooLarge,
                ReadError::Transport(_) => IcsFeedCode::Unreachable,
            })?;
        Ok(Fetched::Body(CalendarFetchedFeed {
            text: decode(&body),
            etag,
            last_modified,
        }))
    }
}

/// `redirectTarget`: where a redirect points, or why a feed cannot live there.
fn redirect_target(headers: &HeaderMap, current: &Url) -> Result<Url, IcsFeedCode> {
    let location = headers.get(LOCATION).ok_or(IcsFeedCode::HttpError)?;
    let next = location
        .to_str()
        .ok()
        .and_then(|l| current.join(l).ok())
        .ok_or(IcsFeedCode::UnsupportedRedirect)?;
    if next.scheme() != "https" {
        return Err(IcsFeedCode::UnsupportedRedirect);
    }
    Ok(next)
}

/// `TextDecoder().decode`: UTF-8 with U+FFFD for bad bytes and a leading BOM dropped.
fn decode(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_round_trip_the_contract_names() {
        for code in IcsFeedCode::ALL {
            assert_eq!(IcsFeedCode::from_code(code.as_str()), Some(code));
            assert_eq!(
                serde_json::to_value(code).unwrap(),
                serde_json::Value::String(code.as_str().to_owned())
            );
        }
        assert_eq!(IcsFeedCode::from_code("nope"), None);
    }

    #[test]
    fn the_body_decodes_as_text_decoder_does() {
        assert_eq!(decode(b"\xef\xbb\xbfBEGIN"), "BEGIN");
        assert_eq!(decode(b"A\xffB"), "A\u{fffd}B");
    }

    #[test]
    fn a_redirect_resolves_against_the_hop_and_stays_on_https() {
        let current = Url::parse("https://feeds.example/a/cal.ics").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(LOCATION, "../b.ics".parse().unwrap());
        assert_eq!(
            redirect_target(&headers, &current).unwrap().as_str(),
            "https://feeds.example/b.ics"
        );
        for target in [
            "http://feeds.example/x",
            "ftp://feeds.example/x",
            "webcal://x/y",
        ] {
            headers.insert(LOCATION, target.parse().unwrap());
            assert_eq!(
                redirect_target(&headers, &current),
                Err(IcsFeedCode::UnsupportedRedirect),
                "{target}"
            );
        }
        assert_eq!(
            redirect_target(&HeaderMap::new(), &current),
            Err(IcsFeedCode::HttpError)
        );
    }
}
