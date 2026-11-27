//! The HTML half of `fetchUrlMetadata` (`metadata.ts:184-233`): metascraper 5.49.21 with the
//! author, date, description, image, logo, publisher, title and url bundles, then Electron's
//! bot-wall check and its `|| undefined` mapping.
//!
//! The input is a fetched web page and is untrusted. Parsing is html5ever's (no recursion) within
//! depth, node and time caps ([`select::parse_steps`] counts its work), every query is one pass
//! over the elements, text reads share a per-page budget ([`select::steps`] counts the work), and
//! every output is a substring of the page, the page URL or a URL resolved against it.

mod date;
mod jsonld;
mod rules;
mod select;
mod text;
mod url;

use chrono::{DateTime, Local, TimeZone};

use super::reddit::UrlMetadata;
use crate::web::extract::markdown::turndown::parse::CapHit;
use rules::Ctx;
use select::Page;

pub use select::{
    MAX_DEPTH as METASCRAPE_MAX_DEPTH, parse_steps as metascrape_parse_steps,
    steps as metascrape_steps,
};

/// Why metascraper threw; Electron's job stores the message as its error.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MetascrapeError {
    /// `MetascraperError` `INVALID_URL`: the page URL fails `isUrl`. Its `message` joins the
    /// code and the text.
    #[error("INVALID_URL, Need to provide a valid URL.")]
    InvalidUrl,
    /// A JSON-LD `@graph` that is truthy but not an array (`graph.map` throws a `TypeError`).
    #[error("{}", jsonld::GRAPH_NOT_ARRAY)]
    GraphNotArray,
    /// Departure: the page nests deeper than [`select::MAX_DEPTH`]. cheerio parsed it for minutes.
    #[error("the page nests more than {} elements deep", select::MAX_DEPTH)]
    TooDeep,
    /// Departure: the page builds more than two nodes per byte.
    #[error("the page builds too many elements")]
    TooManyNodes,
    /// Departure: the parse ran past its deadline (a tag with a flood of attributes).
    #[error("the page takes too long to parse")]
    TooSlow,
}

impl From<CapHit> for MetascrapeError {
    fn from(hit: CapHit) -> Self {
        match hit {
            CapHit::TooDeep => MetascrapeError::TooDeep,
            CapHit::TooManyNodes => MetascrapeError::TooManyNodes,
            CapHit::TooSlow => MetascrapeError::TooSlow,
        }
    }
}

/// `metadata-utils.ts:3-10`.
const BOT_PAGE_TITLES: &[&str] = &[
    "just a moment...",
    "attention required!",
    "access denied",
    "please wait",
    "verify you are human",
    "checking your browser",
];

/// `isBotPageTitle` (`metadata-utils.ts:16-20`): a bot wall's challenge title.
pub fn is_bot_page_title(title: &str) -> bool {
    let lower = title.to_lowercase();
    BOT_PAGE_TITLES.iter().any(|bot| lower.contains(bot))
}

/// The longest `data:` image kept: a base64 [`super::MAX_IMAGE_BYTES`] image and its header.
const MAX_DATA_IMAGE_BYTES: usize = super::MAX_IMAGE_BYTES * 4 / 3 + 1024;

fn starts_with_ignore_case(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
}

/// Departure from Electron: metascraper passes any URI as `url`, `image` and `logo`
/// (`javascript:alert(1)`, `vbscript:`, `file:`, `ftp:`), and Electron stored and rendered it.
/// Only http(s) stays. The vector generator applies the same filters (`httpUrl` and
/// `fetchableImage` in `scripts/generate-metadata-vectors.mjs`).
fn http_url(value: &str) -> bool {
    starts_with_ignore_case(value, "http://") || starts_with_ignore_case(value, "https://")
}

/// [`http_url`], plus a `data:image/*` URI up to [`MAX_DATA_IMAGE_BYTES`], which `net.fetch`
/// downloads for the thumbnail.
fn fetchable_image(value: &str) -> bool {
    http_url(value)
        || (starts_with_ignore_case(value, "data:image/") && value.len() <= MAX_DATA_IMAGE_BYTES)
}

/// Metadata of the page `html` fetched from `url`, dates without a timezone read in the local one.
pub fn metascrape(html: &str, url: &str) -> Result<UrlMetadata, MetascrapeError> {
    metascrape_at(html, url, &Local::now())
}

/// [`metascrape`] with the clock and timezone that relative and zoneless dates are read in.
pub fn metascrape_at<Tz: TimeZone>(
    html: &str,
    url: &str,
    now: &DateTime<Tz>,
) -> Result<UrlMetadata, MetascrapeError> {
    if !url::is_url(url) {
        return Err(MetascrapeError::InvalidUrl);
    }
    let page = Page::load(html)?;
    let items =
        jsonld::collection(&page, html.len()).map_err(|_| MetascrapeError::GraphNotArray)?;
    let cx = Ctx {
        page: &page,
        items: &items,
        url,
        now,
    };
    let title = cx.title();
    if title.as_deref().is_some_and(is_bot_page_title) {
        tracing::warn!("Bot page detected; falling back to a URL-derived title");
        return Ok(UrlMetadata {
            url: Some(url.to_owned()),
            ..UrlMetadata::default()
        });
    }
    Ok(UrlMetadata {
        title,
        description: cx.description(),
        image: cx.image().filter(|v| fetchable_image(v)),
        author: cx.author(),
        publisher: cx.publisher(),
        date: cx.date(),
        logo: cx.logo().filter(|v| fetchable_image(v)),
        url: Some(
            cx.url()
                .filter(|v| http_url(v))
                .unwrap_or_else(|| url.to_owned()),
        ),
    })
}
