//! The sidebar's bookmarks: the phone's Notes root, and the note and journal
//! page's "Add to favorites" toggle.
//!
//! A bookmark names an item by `(item_type, item_id)`. What it resolves to is
//! desktop's rule (`apps/desktop/src/main/ipc/bookmarks-handlers.ts`,
//! `resolveBookmarkItem`), so the two lists agree:
//!
//! - `note` and `journal` resolve by id to a live row; `task` likewise;
//! - `folder` is its path and `tag` its name, shown without an existence
//!   check, as desktop does;
//! - any other type (`image`, `pdf`, `canvas`, ...) resolves to nothing.
//!
//! **An unresolved bookmark is left out, not an error.** Desktop hides one
//! whose item is gone (`itemExists`), and a bookmark of a deleted note is the
//! ordinary case rather than a failure. A row that will not decode still
//! fails the whole list, as everything in [`super::reads`] does. [`page`] is
//! desktop's `bookmarks:list`, which answers the unresolved rows too, each
//! with no [`Resolved`], and leaves hiding them to the renderer.

use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::api::errors::StorageError;

mod writes;

pub use writes::{
    Created, Toggled, bulk_create, bulk_delete, create, delete, reorder, toggle, toggle_rows,
};

/// One bookmark and what it points at.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BookmarkEntry {
    /// The bookmark's own id (`bmk_<type>_<id>` from current desktops).
    pub id: String,
    /// `note`, `journal`, `task`, `folder` or `tag`.
    pub item_type: String,
    /// The bookmarked item: a note, journal or task id, a folder path, or a
    /// tag name.
    pub item_id: String,
    /// The note's or task's title, the folder's last path segment, or the tag
    /// name. `None` for a journal day, which the shell names by its date.
    pub title: Option<String>,
    pub emoji: Option<String>,
    /// A journal day's `YYYY-MM-DD`: the key the journal is addressed by,
    /// since days written by older desktops carry other ids.
    pub journal_date: Option<String>,
    pub position: i64,
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Every live bookmark that resolves, in the user's order: `position`, then
/// creation, then id, so two reads of an unchanged vault agree.
pub fn list(conn: &Connection) -> Result<Vec<BookmarkEntry>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT b.id, b.item_type, b.item_id, b.position, n.title, n.emoji, j.date, t.title \
             FROM bookmarks b \
             LEFT JOIN notes n ON b.item_type = 'note' AND n.id = b.item_id AND n.deleted_at IS NULL \
             LEFT JOIN journal_entries j ON b.item_type = 'journal' AND j.id = b.item_id \
                 AND j.deleted_at IS NULL \
             LEFT JOIN tasks t ON b.item_type = 'task' AND t.id = b.item_id AND t.deleted_at IS NULL \
             WHERE b.deleted_at IS NULL AND b.item_id <> '' \
             ORDER BY b.position, COALESCE(b.created_at, 0), b.id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(failed)?;
    let rows = rows.collect::<Result<Vec<_>, _>>().map_err(failed)?;
    Ok(rows
        .into_iter()
        .filter_map(
            |(id, item_type, item_id, position, note_title, emoji, date, task_title)| {
                let (title, emoji, journal_date) = match item_type.as_str() {
                    "note" => (Some(note_title?), emoji, None),
                    "journal" => (None, None, Some(date?)),
                    "task" => (Some(task_title?), None, None),
                    "folder" => (
                        Some(item_id.rsplit('/').next().unwrap_or(&item_id).to_owned()),
                        None,
                        None,
                    ),
                    "tag" => (Some(item_id.clone()), None, None),
                    _ => return None,
                };
                Some(BookmarkEntry {
                    id,
                    item_type,
                    item_id,
                    title,
                    emoji,
                    journal_date,
                    position,
                })
            },
        )
        .collect())
}

// MARK: - Desktop reads

/// One live bookmark row: desktop's `Bookmark`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bookmark {
    pub id: String,
    pub item_type: String,
    pub item_id: String,
    pub position: i64,
    /// Epoch milliseconds; `None` for a row a peer wrote without one.
    pub created_at: Option<i64>,
}

/// What a bookmark points at: desktop's `itemTitle` and `itemMeta`
/// (`resolveBookmarkItem`, `bookmarks-handlers.ts:60-135`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Resolved {
    /// The note's or task's title, a journal day's date, the folder's last
    /// path segment, or the tag name.
    pub title: String,
    /// A note's or journal day's vault-relative file, or a folder's path.
    pub path: Option<String>,
    pub emoji: Option<String>,
    /// A note's, journal day's or task's tags.
    pub tags: Vec<String>,
}

/// `BookmarkListSchema`'s sort field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortBy {
    Position,
    CreatedAt,
}

/// One page of desktop's `bookmarks:list`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageQuery {
    pub item_type: Option<String>,
    pub sort_by: SortBy,
    pub descending: bool,
    pub limit: u32,
    pub offset: u32,
}

/// A page of bookmarks, each with what it resolves to, and how many live
/// bookmarks match the filter in all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    pub bookmarks: Vec<(Bookmark, Option<Resolved>)>,
    pub total: u32,
}

const BOOKMARK_COLUMNS: &str = "id, item_type, item_id, position, created_at";

fn bookmark(row: &Row<'_>) -> rusqlite::Result<Bookmark> {
    Ok(Bookmark {
        id: row.get(0)?,
        item_type: row.get(1)?,
        item_id: row.get(2)?,
        position: row.get(3)?,
        created_at: row.get(4)?,
    })
}

/// Desktop's `listBookmarks` and `countBookmarks`: live bookmarks of
/// `item_type` (every type when `None`), ordered by `sort_by` then id, so two
/// reads of an unchanged vault agree.
pub fn page(conn: &Connection, query: &PageQuery) -> Result<Page, StorageError> {
    let order = match (query.sort_by, query.descending) {
        (SortBy::Position, false) => "position ASC, id",
        (SortBy::Position, true) => "position DESC, id",
        (SortBy::CreatedAt, false) => "COALESCE(created_at, 0) ASC, id",
        (SortBy::CreatedAt, true) => "COALESCE(created_at, 0) DESC, id",
    };
    let filter = "deleted_at IS NULL AND (?1 IS NULL OR item_type = ?1)";
    let mut statement = conn
        .prepare(&format!(
            "SELECT {BOOKMARK_COLUMNS} FROM bookmarks WHERE {filter} \
             ORDER BY {order} LIMIT ?2 OFFSET ?3"
        ))
        .map_err(failed)?;
    let rows = statement
        .query_map(
            params![query.item_type, query.limit, query.offset],
            bookmark,
        )
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    let total: u32 = conn
        .query_row(
            &format!("SELECT count(*) FROM bookmarks WHERE {filter}"),
            params![query.item_type],
            |row| row.get(0),
        )
        .map_err(failed)?;
    let mut bookmarks = Vec::with_capacity(rows.len());
    for row in rows {
        let resolved = resolve(conn, &row.item_type, &row.item_id)?;
        bookmarks.push((row, resolved));
    }
    Ok(Page { bookmarks, total })
}

/// The live bookmark `id`.
pub fn get(conn: &Connection, id: &str) -> Result<Option<Bookmark>, StorageError> {
    conn.query_row(
        &format!("SELECT {BOOKMARK_COLUMNS} FROM bookmarks WHERE id = ?1 AND deleted_at IS NULL"),
        params![id],
        bookmark,
    )
    .optional()
    .map_err(failed)
}

/// The live bookmark naming `(item_type, item_id)`. Older desktops minted
/// other ids, so an item can have more than one; the first in list order is
/// answered.
pub fn get_by_item(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Option<Bookmark>, StorageError> {
    conn.query_row(
        &format!(
            "SELECT {BOOKMARK_COLUMNS} FROM bookmarks \
             WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL \
             ORDER BY position, id LIMIT 1"
        ),
        params![item_type, item_id],
        bookmark,
    )
    .optional()
    .map_err(failed)
}

fn present(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

/// What `(item_type, item_id)` resolves to, `None` when the item is gone or
/// its type resolves to nothing (`resolveBookmarkItem`).
pub fn resolve(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Option<Resolved>, StorageError> {
    let resolved = match item_type {
        "note" | "journal" => {
            let found = conn
                .query_row(
                    "SELECT COALESCE(n.title, j.date), n.emoji, f.path FROM (SELECT ?1 AS id) k \
                     LEFT JOIN notes n ON n.id = k.id AND n.deleted_at IS NULL \
                     LEFT JOIN journal_entries j ON j.id = k.id AND j.deleted_at IS NULL \
                     LEFT JOIN note_files f ON f.note_id = k.id \
                     WHERE n.id IS NOT NULL OR j.id IS NOT NULL",
                    params![item_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(failed)?;
            let Some((title, emoji, path)) = found else {
                return Ok(None);
            };
            Resolved {
                title: title.unwrap_or_default(),
                path: present(path),
                emoji: present(emoji),
                tags: note_tags(conn, item_id)?,
            }
        }
        "task" => {
            let found = conn
                .query_row(
                    "SELECT title, tags FROM tasks WHERE id = ?1 AND deleted_at IS NULL",
                    params![item_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .optional()
                .map_err(failed)?;
            let Some((title, tags)) = found else {
                return Ok(None);
            };
            Resolved {
                title,
                tags: tags
                    .and_then(|tags| serde_json::from_str::<Vec<String>>(&tags).ok())
                    .unwrap_or_default(),
                ..Resolved::default()
            }
        }
        // Folder and tag bookmarks are shown without an existence check, as
        // desktop does: a stale one opens an empty view.
        "folder" => Resolved {
            title: item_id.rsplit('/').next().unwrap_or(item_id).to_owned(),
            path: Some(item_id.to_owned()),
            ..Resolved::default()
        },
        "tag" => Resolved {
            title: item_id.to_owned(),
            ..Resolved::default()
        },
        _ => return Ok(None),
    };
    Ok(Some(resolved))
}

fn note_tags(conn: &Connection, note_id: &str) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT tag FROM note_tags WHERE note_id = ?1 AND deleted_at IS NULL \
             ORDER BY position, tag",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![note_id], |row| row.get::<_, String>(0))
        .map_err(failed)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(failed)
}

// MARK: - Identity

/// The sync type every bookmark write queues under.
pub const ITEM_TYPE: &str = "bookmark";

/// Desktop's `bookmarkSyncId`: `bmk_<type>_<id>`
/// (`packages/contracts/src/bookmark-types.ts`). Deterministic so two
/// devices bookmarking the same item converge on one row.
pub fn sync_id(item_type: &str, item_id: &str) -> String {
    format!("bmk_{item_type}_{item_id}")
}

/// Whether a live bookmark names `(item_type, item_id)`, whatever its id:
/// older desktops minted other ids, and desktop's `isBookmarked` matches by
/// item, not by id.
pub fn is_bookmarked(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<bool, StorageError> {
    Ok(!live_ids(conn, item_type, item_id)?.is_empty())
}

fn live_ids(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id FROM bookmarks \
             WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL ORDER BY id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![item_type, item_id], |row| row.get::<_, String>(0))
        .map_err(failed)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(failed)
}

#[cfg(test)]
mod tests;
