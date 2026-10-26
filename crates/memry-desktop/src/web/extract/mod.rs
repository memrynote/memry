//! Readable-article extraction: a port of `packages/article-extract` (Defuddle 0.19.0 on
//! linkedom 0.18.12, then `mapToArticleCapture`) that runs no JavaScript.
//!
//! The port is built in stages (Step 26, #3543). Stage 1 carries the foundations: the JS string
//! semantics, the arena DOM with its htmlparser2 parser, serializer and css-select selector
//! engine, the result mapping and the fetch seam. Stage 2a adds Defuddle's constants, the
//! metadata extractor, JSON-LD and meta-tag collection, and the content boundary. Stages 2b to
//! 2d add the removals, standardization and markdown, and stage 2e the `Defuddle` class around
//! them, so `extract_article` runs for generic pages. Site extractors, footnotes, code, image
//! and math handlers arrive with their stages.

pub mod constants;
pub mod defuddle;
pub mod dom;
pub mod elements;
pub mod error;
pub mod extractors;
pub mod fetch;
pub mod map;
pub mod markdown;
pub mod metadata;
pub mod removals;
pub mod standardize;
pub mod utils;

use serde::{Deserialize, Serialize};
use specta::Type;

use defuddle::{Defuddle, DefuddleResponse};
use error::ExtractError;
use fetch::Fetcher;
use map::to_article_capture;

/// `ArticleCapture` of `packages/article-extract/src/map.ts`, serialised with the key order
/// `mapToArticleCapture` produces. Absent optional fields are omitted, never null.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArticleCapture {
    pub url: String,
    pub mode: CaptureMode,
    pub content_markdown: String,
    pub excerpt: String,
    pub extraction_status: ExtractionStatus,
    pub properties: ArticleProperties,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hero_image: Option<String>,
    // Directives the browser extension sets; extraction never does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf_filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_id: Option<String>,
}

/// The keys follow the order `mapToArticleCapture` inserts them (title, source, created, then
/// the optional fields), which is what `JSON.stringify` prints. The TypeScript interface lists
/// `created` later, but the interface does not decide the output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArticleProperties {
    pub title: String,
    pub source: String,
    pub created: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CaptureMode {
    Article,
    Selection,
    Screenshot,
    Pdf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ExtractionStatus {
    Full,
    Partial,
    Failed,
}

/// `Defuddle(document, url, { markdown: true })` without the markdown step: parses with
/// linkedom's rules and runs `parseAsync`. `content` is the standardized HTML. An empty `url`
/// becomes `about:blank`, as `node.js` does.
pub fn run_defuddle(
    html: &str,
    url: &str,
    fetcher: &dyn Fetcher,
) -> Result<DefuddleResponse, ExtractError> {
    let page_url = if url.is_empty() { "about:blank" } else { url };
    Defuddle::new(dom::Document::parse_html(html), page_url).parse_async(fetcher)
}

/// `extractFromHtml(html, url, { now })` of `packages/article-extract/src/node.ts`, with the
/// errors JS would reject with returned instead. The fetcher serves the async extractors.
pub fn try_extract_article(
    html: &str,
    url: &str,
    now: &str,
    fetcher: &dyn Fetcher,
) -> Result<ArticleCapture, ExtractError> {
    let mut response = run_defuddle(html, url, fetcher)?;
    response.content = markdown::create_markdown_content(&response.content);
    Ok(to_article_capture(&response.to_map_input(), url, now))
}

/// `try_extract_article` where a failure (a page with no element at all, a selector error
/// outside the pipeline's own recovery) yields a `failed` capture with no content, so one bad
/// page never aborts the caller.
pub fn extract_article(html: &str, url: &str, now: &str, fetcher: &dyn Fetcher) -> ArticleCapture {
    try_extract_article(html, url, now, fetcher).unwrap_or_else(|error| {
        tracing::error!(%error, "article extraction failed");
        to_article_capture(&map::DefuddleResult::default(), url, now)
    })
}
