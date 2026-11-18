//! The Reddit rule of `fetchUrlMetadata` (`metadata.ts:100-175`): a post's metadata comes from its
//! `.json` listing, and when that fails the HTML is fetched from `old.reddit.com`, whose server
//! rendered page carries the metadata the new site builds in script.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;
use wreq::header::USER_AGENT;

use super::{CHROME_USER_AGENT, WebFetch, read_capped, send, within};

const REDDIT_LOGO: &str = "https://www.redditstatic.com/desktop2x/img/favicon/favicon-32x32.png";
const SELFTEXT_UTF16_UNITS: usize = 300;
/// `TimeClip`'s range: a `Date` further from the epoch is invalid and `toISOString` throws.
const MAX_DATE_MS: f64 = 8.64e15;

/// `UrlMetadata` (`metadata.ts:36-45`): what a link's page says about itself.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UrlMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub date: Option<String>,
    pub logo: Option<String>,
    pub url: Option<String>,
}

fn reddit_host(url: &str) -> Option<String> {
    url::Url::parse(url).ok()?.host_str().map(str::to_owned)
}

/// `isRedditUrl` (`metadata.ts:111-118`).
pub fn is_reddit_url(url: &str) -> bool {
    reddit_host(url).is_some_and(|host| {
        matches!(
            host.as_str(),
            "www.reddit.com" | "reddit.com" | "old.reddit.com"
        )
    })
}

/// `rewriteUrlForFetch` (`metadata.ts:120-131`): `reddit.com` and `www.reddit.com` become
/// `old.reddit.com`; any other URL, or one that does not parse, is returned as is.
pub fn rewrite_url_for_fetch(url: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(url) else {
        return url.to_owned();
    };
    if matches!(parsed.host_str(), Some("www.reddit.com" | "reddit.com"))
        && parsed.set_host(Some("old.reddit.com")).is_ok()
    {
        return parsed.into();
    }
    url.to_owned()
}

/// `url.replace(/\/?(\?.*)?$/, '.json$1')` (`metadata.ts:138`). JS `.` stops at any line
/// terminator, hence the class.
pub fn reddit_json_url(url: &str) -> String {
    static TAIL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"/?(\?[^\n\r\u{2028}\u{2029}]*)?$").expect("static regex"));
    TAIL.replace(url, ".json${1}").into_owned()
}

impl WebFetch {
    /// `fetchRedditMetadata` (`metadata.ts:133-175`). `None` sends the caller to the HTML path:
    /// a status outside 200-299, a body that is not JSON, a listing without a post, a timeout.
    pub async fn reddit_metadata(&self, url: &str) -> Option<UrlMetadata> {
        let request = self
            .client
            .get(reddit_json_url(url))
            .header(USER_AGENT, CHROME_USER_AGENT);
        let cap = self.limits.max_html_bytes;
        let body = within(self.limits.page_timeout, async move {
            let response = send(request).await?;
            if !response.status().is_success() {
                return Ok(None);
            }
            read_capped(response, cap).await.map(Some)
        })
        .await;
        match body {
            Ok(Some(body)) => match serde_json::from_slice::<Value>(&body) {
                Ok(listing) => reddit_metadata_from_listing(&listing, url),
                Err(_) => {
                    tracing::warn!("Reddit JSON API failed, falling back to HTML: invalid JSON");
                    None
                }
            },
            Ok(None) => None,
            Err(error) => {
                tracing::warn!(%error, "Reddit JSON API failed, falling back to HTML");
                None
            }
        }
    }
}

/// The mapping half of `fetchRedditMetadata` over a parsed `.json` listing.
pub fn reddit_metadata_from_listing(listing: &Value, url: &str) -> Option<UrlMetadata> {
    let post = ["0", "data", "children", "0", "data"]
        .iter()
        .try_fold(listing, |value, key| js_member(value, key))?;
    if !truthy(post) {
        return None;
    }
    let field = |name: &str| {
        post.get(name)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
    };

    let preview = ["preview", "images", "0", "source", "url"]
        .iter()
        .try_fold(post, |value, key| js_member(value, key))
        .and_then(Value::as_str)
        .map(|preview| preview.replace("&amp;", "&"))
        .filter(|preview| !preview.is_empty());
    let thumbnail = field("thumbnail").filter(|thumb| *thumb != "self" && *thumb != "default");
    let date = match post.get("created_utc") {
        Some(created) if truthy(created) => Some(iso_from_epoch_ms(js_number(created) * 1000.0)?),
        _ => None,
    };

    Some(UrlMetadata {
        title: field("title").map(str::to_owned),
        description: field("selftext").map(|text| utf16_prefix(text, SELFTEXT_UTF16_UNITS)),
        image: preview.or_else(|| thumbnail.map(str::to_owned)),
        author: field("author").map(|author| format!("u/{author}")),
        publisher: Some(
            field("subreddit_name_prefixed")
                .unwrap_or("Reddit")
                .to_owned(),
        ),
        date,
        logo: Some(REDDIT_LOGO.to_owned()),
        url: Some(url.to_owned()),
    })
}

/// `value?.[key]` for the keys the listing walk uses: an array index or an object member.
fn js_member<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    match value {
        Value::Array(items) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
        Value::Object(map) => map.get(key),
        _ => None,
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JS `Number(value)` for what `created_utc * 1000` coerces; anything else is `NaN`.
fn js_number(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                0.0
            } else {
                text.parse().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

/// `str.slice(0, units)`, counted in UTF-16 code units. A surrogate pair the cut would split is
/// left out whole, where JS keeps a lone high surrogate that no Rust string can hold.
fn utf16_prefix(text: &str, units: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|ch| {
            used += ch.len_utf16();
            used <= units
        })
        .collect()
}

/// `new Date(ms).toISOString()`; `None` where it throws (an invalid date).
fn iso_from_epoch_ms(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms.abs() > MAX_DATE_MS {
        return None;
    }
    let ms = ms.trunc() as i64;
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.abs())
    };
    Some(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    ))
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_dates_match_to_iso_string() {
        assert_eq!(
            iso_from_epoch_ms(0.0).as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_from_epoch_ms(1_700_000_000.5 * 1000.0).as_deref(),
            Some("2023-11-14T22:13:20.500Z")
        );
        assert_eq!(
            iso_from_epoch_ms(-1.0).as_deref(),
            Some("1969-12-31T23:59:59.999Z")
        );
        assert_eq!(
            iso_from_epoch_ms(8.64e15).as_deref(),
            Some("+275760-09-13T00:00:00.000Z")
        );
        assert_eq!(
            iso_from_epoch_ms(-8.64e15).as_deref(),
            Some("-271821-04-20T00:00:00.000Z")
        );
        assert_eq!(iso_from_epoch_ms(8.64e15 + 1.0), None);
        assert_eq!(iso_from_epoch_ms(f64::NAN), None);
    }

    #[test]
    fn selftext_is_cut_at_300_utf16_units() {
        let text = format!("{}{}", "a".repeat(299), "😀tail");
        assert_eq!(utf16_prefix(&text, 300), "a".repeat(299));
        assert_eq!(utf16_prefix("short", 300), "short");
    }
}
