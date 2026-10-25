//! Port of `mapToArticleCapture` (`packages/article-extract/src/map.ts`).

use super::utils::js::{trim, utf16_slice};
use super::{ArticleCapture, ArticleProperties, CaptureMode, ExtractionStatus};

/// Below this many words a page is `partial` (`PARTIAL_WORD_THRESHOLD`).
const PARTIAL_WORD_THRESHOLD: u64 = 100;

/// `DefuddleLikeResult`: the fields of Defuddle's result the mapping reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DefuddleResult {
    pub content: Option<String>,
    pub title: Option<String>,
    pub author: Option<String>,
    pub published: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub word_count: Option<u64>,
}

fn extraction_status(content: &str, word_count: u64) -> ExtractionStatus {
    if trim(content).is_empty() {
        ExtractionStatus::Failed
    } else if word_count < PARTIAL_WORD_THRESHOLD {
        ExtractionStatus::Partial
    } else {
        ExtractionStatus::Full
    }
}

/// `value?.trim()` kept only when non-empty, as in `if (result.x?.trim())`.
fn trimmed(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

/// `mapToArticleCapture(result, url, { now })`.
pub fn to_article_capture(result: &DefuddleResult, url: &str, now: &str) -> ArticleCapture {
    let content_markdown = result.content.clone().unwrap_or_default();
    let word_count = result.word_count.unwrap_or(0);
    let description = trimmed(&result.description);

    let properties = ArticleProperties {
        title: trimmed(&result.title).unwrap_or_else(|| url.to_string()),
        source: url.to_string(),
        created: now.to_string(),
        author: trimmed(&result.author),
        published: trimmed(&result.published),
        description: description.clone(),
    };

    ArticleCapture {
        url: url.to_string(),
        mode: CaptureMode::Article,
        excerpt: description.unwrap_or_else(|| utf16_slice(&content_markdown, 0, 200)),
        extraction_status: extraction_status(&content_markdown, word_count),
        content_markdown,
        properties,
        tags: Some(vec!["clippings".to_string()]),
        hero_image: trimmed(&result.image),
        force: None,
        screenshot_data_url: None,
        pdf_data_url: None,
        pdf_filename: None,
        folder: None,
        vault_id: None,
    }
}
