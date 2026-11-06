//! The task detail screen's "Related" section: search for an item to link, and
//! resolve the items a task already links (spec 004 TP027).
//!
//! Desktop is the reference: `use-related-item-search.ts` (the picker),
//! `task-detail-drawer.tsx` (the linked rows) and `open-related-vault-item.ts`
//! (what a linked id opens, or the "missing" toast).
//!
//! ## What is linkable, and where it is stored
//!
//! A task links related items through two disjoint payload fields:
//! `linkedNoteIds` and `linkedCanvasIds`. Desktop's picker offers notes and
//! canvases. A **file** (a PDF, image, audio or video filed into the vault) is
//! a `note` record with a non-markdown `fileType`, so it appears in the note
//! results and links through `linkedNoteIds` like any note; [`RelatedKind::File`]
//! only tells the shell which icon to draw. Inline attachments (the
//! `attachments` table) are not linkable on desktop and are not offered here.
//!
//! **Canvases cannot be listed on this device.** The core does not subscribe to
//! `canvas` (chapter 13 §13.1, `protocol::types::UNSUBSCRIBED_RECORD_ITEM_TYPES`),
//! so [`search`] returns no canvases and [`resolve`] answers a linked canvas id
//! with [`LinkState::NotOnDevice`] — never [`LinkState::Missing`], because this
//! device cannot tell whether the canvas exists.
//!
//! ## Search order
//!
//! - An empty query lists the most recently modified notes and files, newest
//!   first (desktop: `notesService.list({sortBy: 'modified', sortOrder:
//!   'desc', limit: 50})`, journals excluded). [`RECENT_LIMIT`] is that limit.
//! - A typed query matches over the `notes` projection in `data.db`, which is
//!   every live note on the device, so every note stays reachable. Desktop runs
//!   its FTS index (title, body, tags; every term a word prefix, title weighted
//!   2x) with a fuzzy-title fallback. The index is not in `data.db`, so this
//!   matches titles and folder paths only, in tiers that approximate that
//!   ranking; within a tier the most recently modified comes first:
//!   1. the title starts with the query;
//!   2. every query term is a prefix of a word in the title (the FTS prefix
//!      match, title column);
//!   3. every query term is a prefix of a word in the title or folder path;
//!   4. the title contains the query anywhere (a subset of the fuzzy
//!      fallback).
//!
//! Desktop drops already-linked ids from the results in the drawer, after the
//! limit; the shell does the same.

use rusqlite::{Connection, OptionalExtension as _, Row, params};

use crate::api::errors::StorageError;

/// Desktop's `RECENT_NOTES_LIMIT`: the empty-query list length.
pub const RECENT_LIMIT: usize = 50;
/// Desktop's `SEARCH_NOTES_LIMIT`: the typed-query result length.
pub const SEARCH_LIMIT: usize = 20;

/// The `fileType` desktop writes for a plain note, and assumes when absent.
const MARKDOWN: &str = "markdown";

/// What a related item is, for its icon and for opening it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelatedKind {
    /// A markdown note. Links through `linkedNoteIds`.
    Note,
    /// A filed binary (`fileType` pdf/image/audio/video). Links through
    /// `linkedNoteIds`.
    File,
    /// A journal day. Only ever reached through [`resolve`]: desktop's picker
    /// excludes journals, but a task created inside a journal day links it.
    Journal,
    /// A canvas. Links through `linkedCanvasIds`; never listed on this device.
    Canvas,
}

/// One related item as the picker or a linked row shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelatedItem {
    pub kind: RelatedKind,
    pub id: String,
    /// The note title as stored (may be empty). For a journal, its date.
    pub title: String,
    /// The subtitle: the folder the note lives in, `None` at the vault root.
    pub folder_path: Option<String>,
    pub emoji: Option<String>,
    /// `markdown`, `pdf`, `image`, `audio` or `video` as the payload carries
    /// it; `markdown` for a journal.
    pub file_type: String,
    /// Epoch milliseconds; `None` when the payload carried no instant.
    pub modified_at: Option<i64>,
    /// `YYYY-MM-DD`, exactly when `kind` is [`RelatedKind::Journal`].
    pub journal_date: Option<String>,
}

/// Which task field a linked id came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkedField {
    /// `linkedNoteIds`: notes, files and journal days.
    Note,
    /// `linkedCanvasIds`.
    Canvas,
}

/// What a linked id resolves to on this device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkState {
    Present(RelatedItem),
    /// This device holds the type and no live item has the id: the task
    /// detail's missing-item state (desktop: `drawer.relatedItemMissing`).
    Missing,
    /// The type is not synced to this device (canvases), so its existence
    /// cannot be told.
    NotOnDevice,
}

/// One linked id and what it resolved to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedItem {
    pub field: LinkedField,
    pub id: String,
    pub state: LinkState,
}

/// Notes and files to offer in the related-item picker, best first.
///
/// A query with no non-whitespace character lists the `limit` most recently
/// modified; anything else matches as the module documentation describes.
/// Never returns canvases (not synced to this device) or journals (desktop's
/// picker excludes them).
pub fn search(
    conn: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<RelatedItem>, StorageError> {
    let needle = query.trim().to_lowercase();
    let terms = words(&needle);
    let notes = live_notes(conn)?;
    if needle.is_empty() {
        return Ok(notes.into_iter().take(limit).collect());
    }
    let mut ranked: Vec<(u8, RelatedItem)> = notes
        .into_iter()
        .filter_map(|note| tier(&note, &needle, &terms).map(|tier| (tier, note)))
        .collect();
    // Stable: equal tiers keep the recency order `live_notes` read them in.
    ranked.sort_by_key(|(tier, _)| *tier);
    Ok(ranked
        .into_iter()
        .take(limit)
        .map(|(_, note)| note)
        .collect())
}

/// Resolves a task's linked ids, `linkedNoteIds` first and then
/// `linkedCanvasIds`, each in stored order (desktop's `relatedRefs`).
///
/// A note id resolves the way `open-related-vault-item.ts` opens it: a live
/// note or file; else a live journal entry with that id; else, for an id of
/// the form `jYYYY-MM-DD`, the journal day by date — desktop opens that day
/// even without an entry, so it is never missing; else [`LinkState::Missing`].
pub fn resolve(
    conn: &Connection,
    linked_note_ids: &[String],
    linked_canvas_ids: &[String],
) -> Result<Vec<LinkedItem>, StorageError> {
    let mut resolved = Vec::with_capacity(linked_note_ids.len() + linked_canvas_ids.len());
    for id in linked_note_ids {
        resolved.push(LinkedItem {
            field: LinkedField::Note,
            id: id.clone(),
            state: resolve_note(conn, id)?,
        });
    }
    resolved.extend(linked_canvas_ids.iter().map(|id| LinkedItem {
        field: LinkedField::Canvas,
        id: id.clone(),
        state: LinkState::NotOnDevice,
    }));
    Ok(resolved)
}

fn resolve_note(conn: &Connection, id: &str) -> Result<LinkState, StorageError> {
    let note = conn
        .query_row(
            &format!("{NOTE_COLUMNS} WHERE id = ?1 AND deleted_at IS NULL"),
            params![id],
            read_note,
        )
        .optional()
        .map_err(failed)?;
    if let Some(note) = note {
        return Ok(LinkState::Present(note));
    }
    let entry_date = conn
        .query_row(
            "SELECT date FROM journal_entries WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(
        match entry_date.or_else(|| date_from_journal_id(id).map(str::to_owned)) {
            Some(date) => LinkState::Present(RelatedItem {
                kind: RelatedKind::Journal,
                id: id.to_owned(),
                title: date.clone(),
                folder_path: None,
                emoji: None,
                file_type: MARKDOWN.to_owned(),
                modified_at: None,
                journal_date: Some(date),
            }),
            None => LinkState::Missing,
        },
    )
}

/// Desktop's `dateFromJournalId`: `/^j\d{4}-\d{2}-\d{2}$/`, ASCII digits.
fn date_from_journal_id(id: &str) -> Option<&str> {
    let date = id.strip_prefix('j')?;
    let shaped = date.len() == 10
        && date.bytes().enumerate().all(|(index, byte)| match index {
            4 | 7 => byte == b'-',
            _ => byte.is_ascii_digit(),
        });
    shaped.then_some(date)
}

const NOTE_COLUMNS: &str =
    "SELECT id, title, folder_path, emoji, file_type, modified_at FROM notes";

/// Every live note and file, newest first, with a total order.
fn live_notes(conn: &Connection) -> Result<Vec<RelatedItem>, StorageError> {
    let mut statement = conn
        .prepare(&format!(
            "{NOTE_COLUMNS} WHERE deleted_at IS NULL \
             ORDER BY COALESCE(modified_at, created_at, 0) DESC, id"
        ))
        .map_err(failed)?;
    let rows = statement.query_map([], read_note).map_err(failed)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(failed)
}

fn read_note(row: &Row<'_>) -> rusqlite::Result<RelatedItem> {
    // Null-tolerant like desktop's `COALESCE(file_type, 'markdown')`: a row
    // written before filed binaries existed is a note.
    let file_type = row
        .get::<_, Option<String>>(4)?
        .unwrap_or_else(|| MARKDOWN.to_owned());
    Ok(RelatedItem {
        kind: if file_type == MARKDOWN {
            RelatedKind::Note
        } else {
            RelatedKind::File
        },
        id: row.get(0)?,
        title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        folder_path: row.get(2)?,
        emoji: row.get(3)?,
        file_type,
        modified_at: row.get(5)?,
        journal_date: None,
    })
}

/// The match tier of one note for a non-empty lower-cased `needle`, lower is
/// better; `None` when it does not match.
fn tier(note: &RelatedItem, needle: &str, terms: &[String]) -> Option<u8> {
    let title = note.title.to_lowercase();
    if title.starts_with(needle) {
        return Some(0);
    }
    let title_words = words(&title);
    let prefixes = |haystack: &[String]| {
        !terms.is_empty()
            && terms
                .iter()
                .all(|term| haystack.iter().any(|word| word.starts_with(term.as_str())))
    };
    if prefixes(&title_words) {
        return Some(1);
    }
    let mut searchable = title_words;
    if let Some(folder) = &note.folder_path {
        searchable.extend(words(&folder.to_lowercase()));
    }
    if prefixes(&searchable) {
        return Some(2);
    }
    title.contains(needle).then_some(3)
}

/// Splits on every non-alphanumeric character, as the FTS `unicode61`
/// tokenizer and `search::match_expression` do.
fn words(text: &str) -> Vec<String> {
    text.split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_journal_id_is_j_then_an_ascii_date() {
        assert_eq!(date_from_journal_id("j2026-04-16"), Some("2026-04-16"));
        for not_one in [
            "2026-04-16",
            "j2026-4-16",
            "j2026-04-16x",
            "j2026/04/16",
            "j２026-04-16",
        ] {
            assert_eq!(date_from_journal_id(not_one), None, "{not_one}");
        }
    }
}
