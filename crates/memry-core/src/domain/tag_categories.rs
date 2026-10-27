//! Tag categories: the groups of the tag hub (desktop Step 13), after
//! `database/queries/tag-categories.ts` and `ipc/tags-handlers.ts`.
//!
//! A `tag_category` is a record of its own (`name`, `sortOrder`, chapter 13
//! §13.7.8). Which category a tag sits in is the **tag's** `categoryId` and
//! `sortOrder` on its `tag_definition` (§13.7.7), so a drag in the hub is an
//! edit of definitions, and each edit lands in the outbox.
//!
//! Every write here is one transaction, the outbox rows included.
//!
//! **Two places this is not desktop's behaviour**, both on purpose:
//!
//! - Deleting a category writes `categoryId: null` onto each tag that sat in
//!   it, as synced edits. Desktop clears them in its own database and queues
//!   only the category's delete, so a peer keeps the dangling id. A reader
//!   still tolerates a dangling `categoryId` (a peer's concurrent assign can
//!   recreate one), so the edit is a repair, not a requirement.
//! - Moving a tag into a category creates its `tag_definition` when it has
//!   none (desktop updates nothing then), the same way colour and icon edits
//!   already do in [`super::tag_admin`].
//!
//! A category is soft-deleted: its payload carries `deletedAt`, or a receiving
//! device would read the delete as an update and keep the category.

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox;

use super::notes::{self, edit_in, failed, insert_local, iso, next_clock, object, tombstone_local};
use super::tag_admin::upsert_definition_in;
use super::tasks::model::new_task_id;

/// The `(type, _)` half of every key this module writes.
pub const ITEM_TYPE: &str = "tag_category";

/// One live category with the number of live tags in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagCategory {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub tag_count: i64,
}

/// Where a tag goes in a drag: a category (`None` is uncategorised) and a slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagAssignment {
    pub tag: String,
    pub category_id: Option<String>,
    pub sort_order: i64,
}

fn invalid(what: &str) -> StorageError {
    StorageError::Invalid {
        what: what.to_owned(),
    }
}

fn clean_name(name: &str) -> Result<&str, StorageError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(invalid("a tag category needs a name"));
    }
    Ok(name)
}

/// Live categories in the hub's order, with their tag counts.
pub fn list(conn: &Connection) -> Result<Vec<TagCategory>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT c.id, c.name, c.sort_order,
                    (SELECT COUNT(*) FROM tag_definitions d
                      WHERE d.category_id = c.id AND d.deleted_at IS NULL)
               FROM tag_categories c
              WHERE c.deleted_at IS NULL
              ORDER BY c.sort_order, c.name",
        )
        .map_err(failed)?;
    statement
        .query_map([], |row| {
            Ok(TagCategory {
                id: row.get(0)?,
                name: row.get(1)?,
                sort_order: row.get(2)?,
                tag_count: row.get(3)?,
            })
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

fn is_live(conn: &Connection, id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM tag_categories WHERE id = ?1 AND deleted_at IS NULL)",
        params![id],
        |row| row.get(0),
    )
    .map_err(failed)
}

fn require_live(conn: &Connection, id: &str) -> Result<(), StorageError> {
    if is_live(conn, id)? {
        Ok(())
    } else {
        Err(StorageError::NotFound {
            what: format!("tag category {id}"),
        })
    }
}

/// Creates a category after the last one.
pub fn create(
    conn: &Connection,
    name: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<TagCategory, StorageError> {
    let name = clean_name(name)?.to_owned();
    let id = new_task_id();
    let committed = outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &id),
        now_ms,
        |tx| {
            let highest: Option<i64> = tx
                .query_row(
                    "SELECT MAX(sort_order) FROM tag_categories WHERE deleted_at IS NULL",
                    [],
                    |row| row.get(0),
                )
                .map_err(failed)?;
            let sort_order = highest.map_or(0, |highest| highest + 1);
            let at = iso(now_ms)?;
            let payload = object(json!({
                "name": name,
                "sortOrder": sort_order,
                "clock": next_clock(&Object::new(), device_id)?,
                "createdAt": at,
                "updatedAt": at,
                "deletedAt": null,
            }));
            insert_local(tx, ITEM_TYPE, &id, payload, now_ms)?;
            Ok(sort_order)
        },
    )?;
    Ok(TagCategory {
        id,
        name,
        sort_order: committed.acknowledge(),
        tag_count: 0,
    })
}

/// Renames a live category.
pub fn rename(
    conn: &Connection,
    id: &str,
    name: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let name = clean_name(name)?;
    require_live(conn, id)?;
    notes::edit(
        conn,
        ITEM_TYPE,
        id,
        vec![
            ("name", Change::set(name)),
            ("updatedAt", Change::set(iso(now_ms)?)),
        ],
        device_id,
        now_ms,
    )?
    .acknowledge();
    Ok(())
}

/// Deletes a category; the tags in it become uncategorised.
///
/// Returns how many tags were released.
pub fn delete(
    conn: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<usize, StorageError> {
    require_live(conn, id)?;
    let tx = conn.unchecked_transaction().map_err(failed)?;

    let mut statement = tx
        .prepare("SELECT name FROM tag_definitions WHERE category_id = ?1 AND deleted_at IS NULL")
        .map_err(failed)?;
    let tags: Vec<String> = statement
        .query_map([id], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    drop(statement);
    for tag in &tags {
        upsert_definition_in(
            &tx,
            tag,
            None,
            vec![("categoryId", Change::Set(Value::Null))],
            device_id,
            now_ms,
        )?;
    }

    // `deletedAt` first, so the tombstone's one clock tick covers it.
    sync_items::apply_local_edit_in(
        &tx,
        ITEM_TYPE,
        id,
        &[("deletedAt", Change::set(iso(now_ms)?))],
        now_ms,
    )?;
    tombstone_local(&tx, ITEM_TYPE, id, device_id, now_ms)?;
    outbox::enqueue(&tx, &outbox::Change::delete(ITEM_TYPE, id), now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(tags.len())
}

/// Applies a drag in the tag hub: tag assignments and category order together,
/// all or nothing (desktop `tags:reorder`).
///
/// A category in `order` that is not live is skipped, as desktop's update of
/// a missing row is; a tag assigned to a category that is not live is an
/// error, because that is a write of a reference to nothing.
pub fn arrange(
    conn: &Connection,
    assignments: &[TagAssignment],
    order: &[(String, i64)],
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    for assignment in assignments {
        let tag = assignment.tag.trim();
        if tag.is_empty() {
            return Err(invalid("a tag assignment needs a tag"));
        }
        let category = match assignment.category_id.as_deref() {
            Some(id) => {
                require_live(&tx, id)?;
                json!(id)
            }
            None => Value::Null,
        };
        upsert_definition_in(
            &tx,
            tag,
            None,
            vec![
                ("categoryId", Change::Set(category)),
                ("sortOrder", Change::Set(json!(assignment.sort_order))),
            ],
            device_id,
            now_ms,
        )?;
    }
    for (id, sort_order) in order {
        if !is_live(&tx, id)? {
            continue;
        }
        edit_in(
            &tx,
            ITEM_TYPE,
            id,
            vec![
                ("sortOrder", Change::Set(json!(sort_order))),
                ("updatedAt", Change::set(iso(now_ms)?)),
            ],
            device_id,
            now_ms,
        )?;
        outbox::enqueue(&tx, &outbox::Change::upsert(ITEM_TYPE, id), now_ms)?;
    }
    tx.commit().map_err(failed)
}
