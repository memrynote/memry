//! `reader.ts`: what a saved Reader document's note looks like, in the shape of `plan_note` so
//! the writer needs no second path.

use std::collections::HashSet;

use super::highlights::EPOCH;
use super::plan_note::{NotePlan, folder_under, section_head, set_text};
use super::section::seal_section;
use super::text::book_tag_names;
use super::types::{
    FolderLayout, Frontmatter, FrontmatterValue, PublishedDate, ReaderDocument, SavedImages,
};
use crate::web::extract::utils::date::iso_string;
use crate::web::extract::utils::js::trim as js_trim;

/// Documents without highlights go into this subfolder of the root.
const READER_FOLDER: &str = "Reader";

/// The JS Date range: `new Date(ms)` outside it is an invalid date.
const MAX_TIME: f64 = 8.64e15;

pub struct PlanReaderNoteOptions<'a> {
    pub root: &'a str,
    pub folder_layout: FolderLayout,
    pub images: &'a SavedImages,
    /// The full article text as markdown, converted from `html_content` by the caller.
    /// Written once, below the section, when the note is created.
    pub full_text: Option<&'a str>,
    /// Ids of Reader documents that already have a v2 book (`external_id`). Their highlights
    /// render into that book's note, so the document gets no second note.
    pub book_external_ids: &'a HashSet<String>,
}

/// `ReaderNotePlan`.
#[derive(Debug, Clone, PartialEq)]
pub struct ReaderNotePlan {
    pub note: NotePlan,
    /// Markdown for below the section, for a new note only.
    pub full_text: Option<String>,
}

/// `readerDocumentUrl`.
pub fn reader_document_url(document: &ReaderDocument) -> String {
    match document.url.as_deref() {
        Some(url) if !url.is_empty() => url.to_string(),
        _ => format!("https://read.readwise.io/read/{}", document.id),
    }
}

/// `publishedDay`: `YYYY-MM-DD` for a date string or a Unix time in seconds or milliseconds.
fn published_day(value: Option<&PublishedDate>) -> Option<String> {
    match value? {
        PublishedDate::Number(value) => {
            let ms = if *value < 1e11 {
                value * 1000.0
            } else {
                *value
            };
            // `new Date(ms)`: TimeClip, then `toISOString().slice(0, 10)`.
            if !ms.is_finite() || ms.abs() > MAX_TIME {
                return None;
            }
            iso_string(Some(ms.trunc()))
                .ok()
                .map(|iso| iso.chars().take(10).collect())
        }
        PublishedDate::Text(text) => {
            let trimmed = js_trim(text);
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
    }
}

/// A canonical array index (`0` to `2^32 - 2`): JS orders these keys first, ascending.
fn array_index(key: &str) -> Option<u32> {
    let canonical =
        key == "0" || (!key.starts_with('0') && key.bytes().all(|b| b.is_ascii_digit()));
    key.parse::<u32>()
        .ok()
        .filter(|n| canonical && *n < u32::MAX)
}

/// `Object.entries(document.tags ?? {}).map(([key, tag]) => tag.name || key)`.
fn tag_names(tags: Option<&serde_json::Map<String, serde_json::Value>>) -> Vec<String> {
    let Some(tags) = tags else {
        return Vec::new();
    };
    let mut indexed: Vec<(u32, &String, &serde_json::Value)> = Vec::new();
    let mut named: Vec<(&String, &serde_json::Value)> = Vec::new();
    for (key, tag) in tags {
        match array_index(key) {
            Some(index) => indexed.push((index, key, tag)),
            None => named.push((key, tag)),
        }
    }
    indexed.sort_by_key(|(index, ..)| *index);
    indexed
        .into_iter()
        .map(|(_, key, tag)| (key, tag))
        .chain(named)
        .map(
            |(key, tag)| match tag.get("name").and_then(|n| n.as_str()) {
                Some(name) if !name.is_empty() => name.to_string(),
                _ => key.clone(),
            },
        )
        .collect()
}

/// `planReaderNote`: `None` for a document that never becomes a note: a child (`parent_id`
/// set), a `feed` item, or one whose highlights already live in a v2 book's note. Frontmatter
/// holds only fields that stay put.
pub fn plan_reader_note(
    document: &ReaderDocument,
    options: &PlanReaderNoteOptions,
) -> Option<ReaderNotePlan> {
    if document.parent_id.as_deref().is_some_and(|p| !p.is_empty())
        || document.location.as_deref() == Some("feed")
        || options.book_external_ids.contains(&document.id)
    {
        return None;
    }

    let cover_url = document.image_url.as_deref().filter(|url| !url.is_empty());
    let saved_cover = cover_url.and_then(|url| options.images.get(url));
    let category = document
        .category
        .as_deref()
        .map(|c| js_trim(c).to_lowercase());
    let is_article = category.as_deref() == Some("article");

    let mut frontmatter = Frontmatter::new();
    set_text(&mut frontmatter, "author", document.author.as_deref());
    set_text(&mut frontmatter, "category", category.as_deref());
    set_text(&mut frontmatter, "source", document.source.as_deref());
    set_text(
        &mut frontmatter,
        "source_url",
        document.source_url.as_deref(),
    );
    frontmatter.push((
        "readwise_url",
        FrontmatterValue::Text(reader_document_url(document)),
    ));
    let names = tag_names(document.tags.as_ref());
    let tags = book_tag_names(names.iter().map(String::as_str));
    if !tags.is_empty() {
        frontmatter.push(("tags", FrontmatterValue::List(tags)));
    }
    set_text(&mut frontmatter, "site_name", document.site_name.as_deref());
    set_text(
        &mut frontmatter,
        "published_date",
        published_day(document.published_date.as_ref()).as_deref(),
    );
    if let Some(count) = &document.word_count {
        frontmatter.push(("word_count", FrontmatterValue::Number(count.clone())));
    }
    if let (true, Some(cover)) = (is_article, saved_cover) {
        frontmatter.push(("cover", FrontmatterValue::Text(cover.clone())));
    }

    let mut parts = section_head(
        saved_cover.map(String::as_str),
        is_article,
        document.notes.as_deref(),
        document.summary.as_deref(),
    );
    parts.push("## Highlights".to_string());

    let title = js_trim(document.title.as_deref().unwrap_or_default());
    let full_text = js_trim(options.full_text.unwrap_or_default());
    Some(ReaderNotePlan {
        note: NotePlan {
            folder: folder_under(options.root, options.folder_layout, READER_FOLDER),
            title: if title.is_empty() { "Untitled" } else { title }.to_string(),
            frontmatter,
            section: seal_section(&parts.join("\n\n"), EPOCH),
            last: EPOCH.to_string(),
            image_urls: cover_url.map(str::to_string).into_iter().collect(),
        },
        full_text: (!full_text.is_empty()).then(|| full_text.to_string()),
    })
}
