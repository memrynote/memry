//! A wiki link's hover card (#3530 13i): `notes:preview-by-title` of desktop
//! `ipc/notes-handlers.ts`, in its shape.
//!
//! The note is resolved as `resolveLinkTarget` resolves it (a whole title, alias or path, no
//! heading split) and read through [`read::get`]. Differences, stated:
//! - `snippet` is measured from the file now (`measure`, as a note event's `changes` is), so it
//!   needs none of `cleanCachedSnippet`'s repairs of snippets cached by older Electron builds.
//! - `bodyText` is not computed here: the card's opening is `markdownPreviewText` of the body,
//!   which the renderer runs on `body` (the same function Electron's main ran).
//! - A journal day reads as no card until its reads are ported (13m): `read::get` lists notes.

use memry_core::domain::note_stats::measure;
use memry_core::domain::wiki_target::MatchedBy;
use memry_core::markdown::shared::cover_image::is_cover_text;
use memry_core::storage::repositories::instants::to_iso8601;
use serde::Serialize;
use serde_json::Value;

use super::error::NotesError;
use super::read;
use crate::session::OpenVault;

/// A tag on the card, with its colour (`stone` when the tag has no definition).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct PreviewTagView {
    pub name: String,
    pub color: String,
}

/// `WikiLinkPreview`, with the body in place of `bodyText`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WikiLinkPreviewView {
    pub id: String,
    pub title: String,
    pub emoji: Option<String>,
    pub snippet: Option<String>,
    pub tags: Vec<PreviewTagView>,
    /// ISO 8601.
    pub created_at: String,
    /// The other name the link was written with, `None` when it named the title or path.
    pub matched_name: Option<String>,
    pub path: String,
    /// The raw frontmatter `cover`.
    pub cover: Option<String>,
    /// The note's `description` property when it is text that is not blank.
    pub description: Option<String>,
    /// The body after the frontmatter, for the card's opening; `None` when the card shows the
    /// description instead, or the note is too large for its text to be read.
    pub body: Option<String>,
}

/// The card for the note `title` names, `None` when it names none or not a markdown note.
pub fn preview_by_title(
    open: &OpenVault,
    title: &str,
) -> Result<Option<WikiLinkPreviewView>, NotesError> {
    let Some(target) = open
        .search
        .resolve_link_titles(vec![title.to_owned()])?
        .pop()
        .flatten()
    else {
        return Ok(None);
    };
    if target.file_type != "markdown" {
        return Ok(None);
    }
    let Some(note) = read::get(open, &target.id, None)? else {
        return Ok(None);
    };
    let colors = open.search.tag_colors(note.tags.clone())?;
    let tags = note
        .tags
        .into_iter()
        .zip(colors)
        .map(|(name, color)| PreviewTagView {
            name,
            color: color.unwrap_or_else(|| "stone".to_owned()),
        })
        .collect();
    let description = match note.properties.get("description") {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.clone()),
        _ => None,
    };
    let snippet = measure(&note.content).snippet;
    let cover = match note.frontmatter.get("cover") {
        Some(Value::String(cover)) if is_cover_text(cover) => Some(cover.clone()),
        _ => None,
    };
    Ok(Some(WikiLinkPreviewView {
        body: (description.is_none() && !note.content_omitted).then_some(note.content),
        id: note.id,
        title: note.title,
        emoji: note.emoji,
        snippet: (!snippet.is_empty()).then_some(snippet),
        tags,
        created_at: to_iso8601(note.created).unwrap_or_default(),
        matched_name: (target.matched_by == MatchedBy::Alias).then(|| title.trim().to_owned()),
        path: note.path,
        cover,
        description,
    }))
}
