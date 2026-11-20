//! `plan-note.ts`: what a book's note looks like.

use std::collections::HashSet;

use chrono_tz::Tz;

use super::highlights::{
    image_highlight_url, image_target, is_live_highlight, newest_created_at, render_highlights,
};
use super::section::seal_section;
use super::text::{book_tag_names, escape_paragraphs};
use super::types::{
    CategorySwitches, FolderLayout, Frontmatter, FrontmatterValue, ReadwiseBook, ReadwiseCategory,
    SavedImages,
};
use super::{PlanError, step};
use crate::web::extract::utils::js::trim as js_trim;

/// `DEFAULT_CATEGORY_SWITCHES`: which categories sync when the user has not chosen.
pub fn default_category_switch(category: ReadwiseCategory) -> bool {
    category != ReadwiseCategory::Supplementals
}

fn category_folder(category: Option<ReadwiseCategory>) -> &'static str {
    match category {
        Some(ReadwiseCategory::Books) => "Books",
        Some(ReadwiseCategory::Articles) => "Articles",
        Some(ReadwiseCategory::Tweets) => "Tweets",
        Some(ReadwiseCategory::Podcasts) => "Podcasts",
        Some(ReadwiseCategory::Supplementals) => "Supplementals",
        None => "Other",
    }
}

pub struct PlanNoteOptions<'a> {
    pub root: &'a str,
    pub folder_layout: FolderLayout,
    pub categories: CategorySwitches,
    /// The pulling device's IANA time zone, for the date of each highlight.
    pub time_zone: Tz,
    pub images: &'a SavedImages,
}

/// `NotePlan`.
#[derive(Debug, Clone, PartialEq)]
pub struct NotePlan {
    pub folder: String,
    pub title: String,
    /// Written once, when the note is created.
    pub frontmatter: Frontmatter,
    /// The whole section, markers included.
    pub section: String,
    /// The `last` in the section's end marker.
    pub last: String,
    /// Remote images the plan needs, for the writer to save.
    pub image_urls: Vec<String>,
}

/// What `planNote` decides for a book.
#[derive(Debug, Clone, PartialEq)]
pub enum BookPlan {
    Note(NotePlan),
    /// A book deleted in Readwise. The note stays and the book stops syncing.
    Deleted {
        readwise_url: String,
    },
    /// A book in a category the user switched off.
    Skipped,
}

/// `bookUrl`.
pub fn book_url(book: &ReadwiseBook) -> String {
    match book.readwise_url.as_deref() {
        Some(url) if !url.is_empty() => url.to_string(),
        _ => format!("https://readwise.io/bookreview/{}", book.user_book_id),
    }
}

/// `folderUnder`: the root, or `sub` under it for the `by-category` layout.
pub fn folder_under(root: &str, layout: FolderLayout, sub: &str) -> String {
    let base = root.trim_end_matches('/');
    match layout {
        FolderLayout::Flat => base.to_string(),
        FolderLayout::ByCategory if base.is_empty() => sub.to_string(),
        FolderLayout::ByCategory => format!("{base}/{sub}"),
    }
}

/// `value?.trim()` kept when it is not empty.
pub(crate) fn set_text(frontmatter: &mut Frontmatter, key: &'static str, value: Option<&str>) {
    let trimmed = js_trim(value.unwrap_or_default());
    if !trimmed.is_empty() {
        frontmatter.push((key, FrontmatterValue::Text(trimmed.to_string())));
    }
}

/// The parts of a section above `## Highlights`: the cover of a non-article, the document note
/// and the summary.
pub(crate) fn section_head(
    saved_cover: Option<&str>,
    is_article: bool,
    document_note: Option<&str>,
    summary: Option<&str>,
) -> Vec<String> {
    let mut parts = Vec::new();
    if let (false, Some(cover)) = (is_article, saved_cover) {
        parts.push(format!("![]({})", image_target(cover)));
    }
    let note = escape_paragraphs(document_note.unwrap_or_default());
    if !note.is_empty() {
        parts.push(format!("## Document note\n\n{note}"));
    }
    let summary = escape_paragraphs(summary.unwrap_or_default());
    if !summary.is_empty() {
        parts.push(format!("## Summary\n\n{summary}"));
    }
    parts
}

/// `planNote`: what a book's note should look like, from the full book: never pass the
/// changed-highlights-only entry of an `updatedAfter` export, or the section would drop every
/// other highlight.
pub fn plan_note(book: &ReadwiseBook, options: &PlanNoteOptions) -> Result<BookPlan, PlanError> {
    if book.is_deleted.unwrap_or(false) {
        return Ok(BookPlan::Deleted {
            readwise_url: book_url(book),
        });
    }

    let category = js_trim(book.category.as_deref().unwrap_or_default()).to_lowercase();
    let known = ReadwiseCategory::parse(&category);
    let enabled = known.is_none_or(|c| {
        options
            .categories
            .get(c)
            .unwrap_or_else(|| default_category_switch(c))
    });
    if !enabled {
        return Ok(BookPlan::Skipped);
    }

    let highlights: Vec<_> = book
        .highlights
        .iter()
        .flatten()
        .filter(|h| is_live_highlight(h))
        .collect();
    let mut image_urls = Vec::new();
    let mut seen = HashSet::new();
    let cover_url = book
        .cover_image_url
        .as_deref()
        .filter(|url| !url.is_empty());
    let urls = cover_url
        .map(str::to_string)
        .into_iter()
        .chain(highlights.iter().filter_map(|h| image_highlight_url(h)));
    for url in urls {
        step();
        if seen.insert(url.clone()) {
            image_urls.push(url);
        }
    }

    let saved_cover = cover_url.and_then(|url| options.images.get(url));
    let is_article = category == "articles";

    let mut frontmatter = Frontmatter::new();
    set_text(&mut frontmatter, "author", book.author.as_deref());
    set_text(&mut frontmatter, "category", Some(&category));
    set_text(&mut frontmatter, "source", book.source.as_deref());
    set_text(&mut frontmatter, "source_url", book.source_url.as_deref());
    frontmatter.push(("readwise_url", FrontmatterValue::Text(book_url(book))));
    let tags = book_tag_names(book.book_tags.iter().flatten().map(|t| t.name.as_str()));
    if !tags.is_empty() {
        frontmatter.push(("tags", FrontmatterValue::List(tags)));
    }
    if let (true, Some(cover)) = (is_article, saved_cover) {
        frontmatter.push(("cover", FrontmatterValue::Text(cover.clone())));
    }

    let mut parts = section_head(
        saved_cover.map(String::as_str),
        is_article,
        book.document_note.as_deref(),
        book.summary.as_deref(),
    );
    let rendered = render_highlights(&highlights, options.time_zone, options.images);
    parts.push(if rendered.markdown.is_empty() {
        "## Highlights".to_string()
    } else {
        format!("## Highlights\n\n{}", rendered.markdown)
    });
    let last = newest_created_at(&rendered.rendered, &rendered.missing, "")?;

    let title = [book.readable_title.as_deref(), book.title.as_deref()]
        .into_iter()
        .flatten()
        .find(|t| !t.is_empty())
        .map(js_trim)
        .filter(|t| !t.is_empty())
        .unwrap_or("Untitled");
    Ok(BookPlan::Note(NotePlan {
        folder: folder_under(options.root, options.folder_layout, category_folder(known)),
        title: title.to_string(),
        frontmatter,
        section: seal_section(&parts.join("\n\n"), &last),
        last,
        image_urls,
    }))
}
