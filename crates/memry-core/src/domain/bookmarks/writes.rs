//! Bookmark writes: desktop's `bookmarks:*` handlers
//! (`apps/desktop/src/main/ipc/bookmarks-handlers.ts`) over the queries of
//! `apps/desktop/src/main/database/queries/bookmarks.ts`.
//!
//! The payload is desktop's (`BookmarkSyncPayloadSchema`): `itemType`,
//! `itemId`, `position`, `clock`, `createdAt`, and no `modifiedAt`, because a
//! bookmark row has none. `bookmark` merges document-level, so a write ticks
//! the document clock and nothing else. Each call is one transaction that
//! writes the record and queues its push, so a crash leaves either both or
//! neither.
//!
//! A bookmark removed earlier left a tombstone under the same deterministic
//! id; bookmarking again revives that row rather than failing on it, which is
//! what desktop's re-insert of the same id does on the server.

use rusqlite::{Connection, params};
use serde_json::json;

use super::{Bookmark, ITEM_TYPE, failed, get, live_ids, sync_id};
use crate::api::errors::StorageError;
use crate::domain::notes::{insert_local, iso, next_clock, object, require_payload};
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox;

/// What [`create`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Created {
    Created(Bookmark),
    /// A live bookmark already names the item, whatever its id: a result,
    /// not an error, as desktop answers it (`bookmarks-handlers.ts:170-176`).
    AlreadyBookmarked,
}

/// What [`toggle_rows`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Toggled {
    Created(Bookmark),
    /// Every live bookmark of the item, as they were before the tombstone.
    Removed(Vec<Bookmark>),
}

fn require_item(item_type: &str, item_id: &str) -> Result<(), StorageError> {
    if item_type.is_empty() || item_id.is_empty() {
        return Err(StorageError::Invalid {
            what: "a bookmark names an item type and an item id".to_owned(),
        });
    }
    Ok(())
}

/// Desktop's `bookmarks:toggle`: bookmarks an unbookmarked item at the end of
/// the list, or tombstones every live bookmark of a bookmarked one. Returns
/// whether the item is bookmarked afterwards.
pub fn toggle(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    Ok(matches!(
        toggle_rows(conn, item_type, item_id, device_id, now_ms)?,
        Toggled::Created(_)
    ))
}

/// [`toggle`], answering the row it created or the rows it removed, which
/// desktop's events carry.
pub fn toggle_rows(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Toggled, StorageError> {
    require_item(item_type, item_id)?;
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let live = live_ids(&tx, item_type, item_id)?;
    let toggled = if live.is_empty() {
        Toggled::Created(create_queued(&tx, item_type, item_id, device_id, now_ms)?)
    } else {
        let mut removed = Vec::with_capacity(live.len());
        for id in &live {
            removed.extend(delete_queued(&tx, id, device_id, now_ms)?);
        }
        Toggled::Removed(removed)
    };
    tx.commit().map_err(failed)?;
    Ok(toggled)
}

/// Desktop's `bookmarks:create`: bookmarks the item at the end of the list
/// under its deterministic id.
pub fn create(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Created, StorageError> {
    require_item(item_type, item_id)?;
    let tx = conn.unchecked_transaction().map_err(failed)?;
    if !live_ids(&tx, item_type, item_id)?.is_empty() {
        return Ok(Created::AlreadyBookmarked);
    }
    let bookmark = create_queued(&tx, item_type, item_id, device_id, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(Created::Created(bookmark))
}

/// Desktop's `bookmarks:bulk-create`: bookmarks each item not bookmarked yet,
/// in order, at consecutive positions after the last one. Answers the rows it
/// created; an item already bookmarked, or named twice, is skipped.
pub fn bulk_create(
    conn: &Connection,
    items: &[(String, String)],
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<Bookmark>, StorageError> {
    for (item_type, item_id) in items {
        require_item(item_type, item_id)?;
    }
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let mut created = Vec::new();
    for (item_type, item_id) in items {
        if live_ids(&tx, item_type, item_id)?.is_empty() {
            created.push(create_queued(&tx, item_type, item_id, device_id, now_ms)?);
        }
    }
    tx.commit().map_err(failed)?;
    Ok(created)
}

/// Desktop's `bookmarks:delete`: tombstones one bookmark by id. Answers the
/// row as it was, or `None` when no live bookmark has that id.
pub fn delete(
    conn: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<Bookmark>, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let deleted = delete_queued(&tx, id, device_id, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(deleted)
}

/// Desktop's `bookmarks:bulk-delete`: tombstones each live bookmark named.
/// Answers the rows it removed; an unknown or removed id is skipped.
pub fn bulk_delete(
    conn: &Connection,
    ids: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<Bookmark>, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let mut deleted = Vec::new();
    for id in ids {
        deleted.extend(delete_queued(&tx, id, device_id, now_ms)?);
    }
    tx.commit().map_err(failed)?;
    Ok(deleted)
}

/// Desktop's `reorderBookmarks` (`queries/bookmarks.ts:189-193`): the
/// bookmark at index `i` of `ids` takes position `i`. An unknown or removed id
/// is skipped without shifting the others, so the positions match the order
/// the shell shows. Each moved row ticks its clock and queues its push.
pub fn reorder(
    conn: &Connection,
    ids: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    for (index, id) in ids.iter().enumerate() {
        if get(&tx, id)?.is_none() {
            continue;
        }
        let position = i64::try_from(index).map_err(|_| StorageError::Invalid {
            what: "too many bookmarks to reorder".to_owned(),
        })?;
        let stored = require_payload(&tx, ITEM_TYPE, id)?;
        let changes = vec![
            ("position", Change::set(position)),
            (
                "clock",
                Change::Set(next_clock(stored.object(), device_id)?),
            ),
        ];
        sync_items::apply_local_edit_in(&tx, ITEM_TYPE, id, &changes, now_ms)?;
        outbox::enqueue(&tx, &outbox::Change::upsert(ITEM_TYPE, id), now_ms)?;
    }
    tx.commit().map_err(failed)
}

/// Creates the item's bookmark under its deterministic id, queues its push
/// and answers the stored row.
fn create_queued(
    tx: &Connection,
    item_type: &str,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Bookmark, StorageError> {
    let id = sync_id(item_type, item_id);
    create_in(tx, &id, item_type, item_id, device_id, now_ms)?;
    outbox::enqueue(tx, &outbox::Change::upsert(ITEM_TYPE, &id), now_ms)?;
    get(tx, &id)?.ok_or_else(|| StorageError::Failed {
        what: format!("bookmark {id} did not read back"),
    })
}

/// Tombstones the live bookmark `id` and queues its delete, answering the row
/// as it was; `None` when there is none.
fn delete_queued(
    tx: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<Bookmark>, StorageError> {
    let Some(bookmark) = get(tx, id)? else {
        return Ok(None);
    };
    delete_in(tx, id, device_id, now_ms)?;
    outbox::enqueue(tx, &outbox::Change::delete(ITEM_TYPE, id), now_ms)?;
    Ok(Some(bookmark))
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
