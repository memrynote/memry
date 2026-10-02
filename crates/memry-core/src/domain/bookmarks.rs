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
//! fails the whole list, as everything in [`super::reads`] does.

use rusqlite::{Connection, params};
use serde_json::json;

use crate::api::errors::StorageError;
use crate::domain::notes::{insert_local, iso, next_clock, object, require_payload};
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox;

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

// MARK: - Writes

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

/// Desktop's `bookmarks:toggle`: bookmarks an unbookmarked item at the end of
/// the list, or tombstones every live bookmark of a bookmarked one. Returns
/// whether the item is bookmarked afterwards.
///
/// The payload is desktop's (`BookmarkSyncPayloadSchema`): `itemType`,
/// `itemId`, `position`, `clock`, `createdAt`, and no `modifiedAt`, because a
/// bookmark row has none. `bookmark` merges document-level, so a write ticks
/// the document clock and nothing else.
///
/// A bookmark removed earlier left a tombstone under the same deterministic
/// id; bookmarking again revives that row rather than failing on it, which is
/// what desktop's re-insert of the same id does on the server.
pub fn toggle(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    if item_type.is_empty() || item_id.is_empty() {
        return Err(StorageError::Invalid {
            what: "a bookmark names an item type and an item id".to_owned(),
        });
    }
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let live = live_ids(&tx, item_type, item_id)?;
    let bookmarked = if live.is_empty() {
        let id = sync_id(item_type, item_id);
        create_in(&tx, &id, item_type, item_id, device_id, now_ms)?;
        outbox::enqueue(&tx, &outbox::Change::upsert(ITEM_TYPE, &id), now_ms)?;
        true
    } else {
        for id in &live {
            delete_in(&tx, id, device_id, now_ms)?;
            outbox::enqueue(&tx, &outbox::Change::delete(ITEM_TYPE, id), now_ms)?;
        }
        false
    };
    tx.commit().map_err(failed)?;
    Ok(bookmarked)
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

fn create_in(
    tx: &Connection,
    id: &str,
    item_type: &str,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let position = next_position(tx)?;
    match sync_items::load(tx, ITEM_TYPE, id)? {
        None => {
            let payload = object(json!({
                "itemType": item_type,
                "itemId": item_id,
                "position": position,
                "clock": next_clock(&Object::new(), device_id)?,
                "createdAt": iso(now_ms)?,
            }));
            insert_local(tx, ITEM_TYPE, id, payload, now_ms)?;
        }
        Some(_) => {
            // A tombstone under the same id: revive it, keeping any key a
            // newer build wrote (§13.2 rule 3).
            let stored = require_payload(tx, ITEM_TYPE, id)?;
            tx.execute(
                "UPDATE sync_items SET deleted_at = NULL, updated_at = ?3
                  WHERE item_type = ?1 AND item_id = ?2",
                params![ITEM_TYPE, id, now_ms],
            )
            .map_err(failed)?;
            let changes = vec![
                ("itemType", Change::set(item_type)),
                ("itemId", Change::set(item_id)),
                ("position", Change::set(position)),
                ("createdAt", Change::set(iso(now_ms)?)),
                (
                    "clock",
                    Change::Set(next_clock(stored.object(), device_id)?),
                ),
            ];
            sync_items::apply_local_edit_in(tx, ITEM_TYPE, id, &changes, now_ms)?;
        }
    }
    Ok(())
}

/// Tombstones one bookmark. The pushed payload is the stored one under a
/// ticked clock, desktop's delete payload.
fn delete_in(tx: &Connection, id: &str, device_id: &str, now_ms: i64) -> Result<(), StorageError> {
    let stored = require_payload(tx, ITEM_TYPE, id)?;
    tx.execute(
        "UPDATE sync_items SET deleted_at = ?3, updated_at = ?3
          WHERE item_type = ?1 AND item_id = ?2",
        params![ITEM_TYPE, id, now_ms],
    )
    .map_err(failed)?;
    let changes = vec![(
        "clock",
        Change::Set(next_clock(stored.object(), device_id)?),
    )];
    sync_items::apply_local_edit_in(tx, ITEM_TYPE, id, &changes, now_ms)?;
    Ok(())
}

/// `getNextBookmarkPosition`: one past the largest live position.
fn next_position(tx: &Connection) -> Result<i64, StorageError> {
    let max: Option<i64> = tx
        .query_row(
            "SELECT max(position) FROM bookmarks WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(failed)?;
    Ok(max.map_or(0, |max| max + 1))
}
