//! The sidebar's bookmarks, read-only (the phone's Notes root).
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
//! fails the whole list, as everything in [`super::reads`] does.

use rusqlite::Connection;

use crate::api::errors::StorageError;

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
