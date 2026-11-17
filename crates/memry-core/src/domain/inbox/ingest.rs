//! A readable article written into the Inbox (`ingestArticleCapture`,
//! `apps/desktop/src/main/inbox/ingest.ts`): the browser extension's
//! `/capture` and the article-extract job.
//!
//! The shell does the I/O first: it picks the target (a live capture of the
//! same URL unless `force`, through [`super::duplicate_by_url`]), stores the
//! screenshot, the PDF and the hero image under `attachments/inbox/<id>/`,
//! then calls [`capture_article`] for a new capture or [`enrich_article`] for
//! an existing one. Every stored path must lie in that capture's folder.

use rusqlite::Connection;
use serde_json::{Map, Value, json};

use crate::api::errors::StorageError;
use crate::storage::repositories::Change;
use crate::sync::outbox::Durable;

use super::InboxItem;
use super::attachments::capture_file_name;
use super::write::{NewCapture, capture, edit};

/// `ArticleCapture.extractionStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum InboxExtractionStatus {
    Full,
    Partial,
    Failed,
}

impl InboxExtractionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Partial => "partial",
            Self::Failed => "failed",
        }
    }
}

/// `ArticlePropertiesSchema`; an absent optional key stays absent in the
/// stored metadata, as zod's output omits it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxArticleProperties {
    pub title: String,
    pub source: String,
    pub author: Option<String>,
    pub published: Option<String>,
    pub created: String,
    pub description: Option<String>,
}

/// The part of an `ArticleCapture` the row keeps.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxArticle {
    pub url: String,
    pub content_markdown: String,
    pub excerpt: String,
    pub extraction_status: InboxExtractionStatus,
    pub properties: InboxArticleProperties,
    pub hero_image: Option<String>,
}

/// The PDF the extension sent, stored by the shell.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxArticlePdf {
    pub path: String,
    /// `pdfFilename`, or `document.pdf`.
    pub filename: String,
    pub size: u64,
}

/// What the shell stored for a new capture, each under
/// `attachments/inbox/<id>/`. A file that failed to store is `None`: the
/// capture degrades (no screenshot body, a link instead of a pdf), as desktop's
/// does, rather than being lost.
#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct InboxArticleFiles {
    pub screenshot_path: Option<String>,
    pub pdf: Option<InboxArticlePdf>,
    /// The downloaded hero image; the screenshot wins as thumbnail.
    pub hero_path: Option<String>,
}

fn properties(article: &InboxArticle) -> Value {
    let p = &article.properties;
    let mut map = Map::new();
    map.insert("title".into(), json!(p.title));
    map.insert("source".into(), json!(p.source));
    if let Some(author) = &p.author {
        map.insert("author".into(), json!(author));
    }
    if let Some(published) = &p.published {
        map.insert("published".into(), json!(published));
    }
    map.insert("created".into(), json!(p.created));
    if let Some(description) = &p.description {
        map.insert("description".into(), json!(description));
    }
    Value::Object(map)
}

fn own_path(item_id: &str, path: &str) -> Result<String, StorageError> {
    match capture_file_name(item_id, path) {
        Some(_) => Ok(path.to_owned()),
        None => Err(StorageError::Invalid {
            what: format!("a capture's file must lie in attachments/inbox/{item_id}/"),
        }),
    }
}

/// A new capture from an article (`ingestArticleCapture`, create path): a
/// `pdf` when the PDF was stored (no content, its file marked for upload),
/// else a `link` whose content is the markdown, or the screenshot when there
/// is one. `tags` `None` gives desktop's default `clippings`.
#[allow(clippy::too_many_arguments)]
pub fn capture_article(
    conn: &Connection,
    item_id: &str,
    article: &InboxArticle,
    files: &InboxArticleFiles,
    tags: Option<&[String]>,
    capture_source: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    let screenshot = files
        .screenshot_path
        .as_deref()
        .map(|path| own_path(item_id, path))
        .transpose()?;
    let hero = files
        .hero_path
        .as_deref()
        .map(|path| own_path(item_id, path))
        .transpose()?;
    let pdf = files
        .pdf
        .as_ref()
        .map(|pdf| own_path(item_id, &pdf.path).map(|path| (path, pdf)))
        .transpose()?;

    let mut metadata = Map::new();
    metadata.insert("url".into(), json!(article.url));
    metadata.insert("fetchStatus".into(), json!("complete"));
    metadata.insert("excerpt".into(), json!(article.excerpt));
    metadata.insert(
        "extractionStatus".into(),
        json!(article.extraction_status.as_str()),
    );
    if let Some(hero_image) = &article.hero_image {
        metadata.insert("heroImage".into(), json!(hero_image));
    }
    metadata.insert("properties".into(), properties(article));
    if let Some((_, pdf)) = &pdf {
        metadata.insert("originalFilename".into(), json!(pdf.filename));
        metadata.insert("fileSize".into(), json!(pdf.size));
        metadata.insert("mimeType".into(), json!("application/pdf"));
    }

    let content = match (&pdf, &screenshot) {
        (Some(_), _) => None,
        (None, Some(path)) => Some(format!("![screenshot]({path})")),
        (None, None) => Some(article.content_markdown.clone()),
    };
    let default_tags = ["clippings".to_owned()];
    capture(
        conn,
        &NewCapture {
            id: Some(item_id.to_owned()),
            item_type: if pdf.is_some() { "pdf" } else { "link" }.to_owned(),
            title: article.properties.title.clone(),
            content,
            metadata: Some(Value::Object(metadata)),
            source_url: Some(article.url.clone()),
            capture_source: Some(capture_source.to_owned()),
            processing_status: "complete".to_owned(),
            attachment_path: pdf.map(|(path, _)| path),
            thumbnail_path: screenshot.or(hero),
            tags: tags.unwrap_or(&default_tags).to_vec(),
            ..NewCapture::default()
        },
        device_id,
        now_ms,
    )
}

/// An existing capture enriched with an article (`ingestArticleCapture`,
/// `itemId` path: a duplicate URL from the extension, or the article-extract
/// job): the markdown replaces `content`, `url`, `excerpt`,
/// `extractionStatus` and `properties` overwrite those metadata keys (the
/// rest stay), and a downloaded hero becomes the thumbnail.
pub fn enrich_article(
    conn: &Connection,
    item_id: &str,
    article: &InboxArticle,
    hero_path: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    let hero = hero_path.map(|path| own_path(item_id, path)).transpose()?;
    let item = super::write::require_live(conn, item_id)?;
    let mut metadata = match item.metadata {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    metadata.insert("url".into(), json!(article.url));
    metadata.insert("excerpt".into(), json!(article.excerpt));
    metadata.insert(
        "extractionStatus".into(),
        json!(article.extraction_status.as_str()),
    );
    metadata.insert("properties".into(), properties(article));
    let mut changes = vec![
        ("content", Change::set(article.content_markdown.as_str())),
        ("metadata", Change::Set(Value::Object(metadata))),
    ];
    if let Some(hero) = hero {
        changes.push(("thumbnailPath", Change::set(hero)));
    }
    edit(conn, item_id, changes, device_id, now_ms)
}
