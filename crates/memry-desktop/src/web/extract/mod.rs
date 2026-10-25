//! Readable-article extraction: a port of `packages/article-extract` (Defuddle 0.19.0 on
//! linkedom 0.18.12, then `mapToArticleCapture`) that runs no JavaScript.
//!
//! The port is built in stages (Step 26, #3543). This stage carries the foundations: the JS
//! string semantics, the arena DOM with its htmlparser2 parser, serializer and css-select
//! selector engine, the result mapping and the fetch seam. `extract_article` arrives with the
//! pipeline that feeds it.

pub mod dom;
pub mod error;
pub mod fetch;
pub mod map;
pub mod utils;

use serde::{Deserialize, Serialize};
use specta::Type;

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
