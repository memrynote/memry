//! Home boards: the `home_page` sync type (`HomePageSyncPayloadSchema`,
//! `packages/contracts/src/sync-payloads.ts`; chapter 13 §13.7.24), desktop's
//! `database/queries/home-pages.ts` over the record. Step 30 (#3547) builds
//! the Home service on these functions.
//!
//! The record in `sync_items` is the owner and `home_pages` its projection
//! ([`crate::storage::repositories::projectors::home_pages`]). The payload
//! carries every schema key, `{name, icon, position, widgets, cover, clock,
//! createdAt, updatedAt}`, the row Electron pushes less its `id` and `syncedAt`
//! (`packages/sync-client/src/item-handlers/home-page-handler.ts:145-155`), and
//! [`merge`] applies a peer's.

pub mod merge;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::desktop_records::{self, live};
use crate::domain::notes::{failed, insert_local, iso, next_clock, object};
use crate::domain::saved_filters::mint_id;
use crate::storage::repositories::Change;
use crate::storage::repositories::projectors::home_pages::is_readable_cover;
use crate::storage::repositories::schema::Object;
use crate::sync::outbox;

/// The sync type of a board record.
pub const ITEM_TYPE: &str = "home_page";

/// One live board. Instants are epoch milliseconds.
#[derive(Debug, Clone, PartialEq)]
pub struct HomePage {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub position: f64,
    /// The widgets as the opaque JSON array text the record carries.
    pub widgets: String,
    /// The banner as JSON text (`HomePageCoverSyncSchema`), or `None`.
    pub cover: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What a new board carries.
#[derive(Debug, Clone, Copy)]
pub struct NewHomePage<'a> {
    pub name: &'a str,
    pub icon: Option<&'a str>,
    pub position: f64,
    /// JSON array text.
    pub widgets: &'a str,
    pub cover: Option<&'a Value>,
}

/// A change to a board: `None` leaves a field as it is, and `Some(None)`
/// clears `icon` or `cover`.
#[derive(Debug, Clone, Copy, Default)]
pub struct HomePagePatch<'a> {
    pub name: Option<&'a str>,
    pub icon: Option<Option<&'a str>>,
    pub position: Option<f64>,
    /// JSON array text.
    pub widgets: Option<&'a str>,
    pub cover: Option<Option<&'a Value>>,
}

/// Creates a board and queues it. A board needs a name, and its widgets must
/// be JSON array text: a peer skips a create without the one and a board
/// without the other (§13.7.24). A cover must be one a peer reads.
pub fn create(
    conn: &Connection,
    board: &NewHomePage<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<HomePage, StorageError> {
    if board.name.is_empty() {
        return Err(StorageError::Invalid {
            what: "a home board needs a name".to_owned(),
        });
    }
    valid_widgets(board.widgets)?;
    board.cover.map(valid_cover).transpose()?;
    let id = mint_id();
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &id),
        now_ms,
        |tx| {
            let created = iso(now_ms)?;
            let payload = object(json!({
                "name": board.name,
                "icon": board.icon,
                "position": number(board.position)?,
                "widgets": board.widgets,
                "cover": board.cover,
                "clock": next_clock(&Object::new(), device_id)?,
                "createdAt": created,
                "updatedAt": created,
            }));
            insert_local(tx, ITEM_TYPE, &id, payload, now_ms)?;
            read_back(tx, &id)
        },
    )
    .map(outbox::Durable::acknowledge)
}

/// Changes a live board, ticks its clock and `updatedAt`, and queues it.
pub fn update(
    conn: &Connection,
    id: &str,
    patch: &HomePagePatch<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<HomePage, StorageError> {
    if patch.name == Some("") {
        return Err(StorageError::Invalid {
            what: "a home board needs a name".to_owned(),
        });
    }
    if let Some(widgets) = patch.widgets {
        valid_widgets(widgets)?;
    }
    patch.cover.flatten().map(valid_cover).transpose()?;
    let mut changes: Vec<(&'static str, Change)> = Vec::new();
    if let Some(name) = patch.name {
        changes.push(("name", Change::set(name)));
    }
    if let Some(icon) = patch.icon {
        changes.push(("icon", Change::Set(json!(icon))));
    }
    if let Some(position) = patch.position {
        changes.push(("position", Change::Set(number(position)?)));
    }
    if let Some(widgets) = patch.widgets {
        changes.push(("widgets", Change::set(widgets)));
    }
    if let Some(cover) = patch.cover {
        changes.push(("cover", Change::Set(json!(cover))));
    }
    changes.push(("updatedAt", Change::set(iso(now_ms)?)));
    outbox::commit(conn, &outbox::Change::upsert(ITEM_TYPE, id), now_ms, |tx| {
        let stored = live(tx, ITEM_TYPE, id, "home board")?;
        desktop_records::edit(tx, ITEM_TYPE, id, &stored, changes, device_id, now_ms)?;
        read_back(tx, id)
    })
    .map(outbox::Durable::acknowledge)
}

/// Deletes a board and queues the delete. `false` when there was none.
pub fn delete(
    conn: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    if get(conn, id)?.is_none() {
        return Ok(false);
    }
    outbox::commit(conn, &outbox::Change::delete(ITEM_TYPE, id), now_ms, |tx| {
        let stored = live(tx, ITEM_TYPE, id, "home board")?;
        desktop_records::tombstone(tx, ITEM_TYPE, id, &stored, Vec::new(), device_id, now_ms)
    })?;
    Ok(true)
}

/// One live board by id.
pub fn get(conn: &Connection, id: &str) -> Result<Option<HomePage>, StorageError> {
    conn.query_row(
        &format!("{SELECT} WHERE id = ?1 AND deleted_at IS NULL"),
        params![id],
        read_row,
    )
    .optional()
    .map_err(failed)
}

/// Every live board by `position`, then `createdAt`, then id, the order every
/// device agrees on (`listHomePages`).
pub fn list(conn: &Connection) -> Result<Vec<HomePage>, StorageError> {
    let mut statement = conn
        .prepare_cached(&format!(
            "{SELECT} WHERE deleted_at IS NULL ORDER BY position, created_at, id"
        ))
        .map_err(failed)?;
    statement
        .query_map([], read_row)
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

const SELECT: &str = "SELECT id, name, icon, position, widgets, cover, created_at, updated_at
                      FROM home_pages";

fn read_row(row: &Row<'_>) -> rusqlite::Result<HomePage> {
    Ok(HomePage {
        id: row.get(0)?,
        name: row.get(1)?,
        icon: row.get(2)?,
        position: row.get(3)?,
        widgets: row.get(4)?,
        cover: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn read_back(tx: &Connection, id: &str) -> Result<HomePage, StorageError> {
    get(tx, id)?.ok_or_else(|| StorageError::Failed {
        what: format!("home board {id} did not project"),
    })
}

/// `isWidgetsBlob`: text that parses to a JSON array.
pub(crate) fn is_widgets_blob(text: &str) -> bool {
    serde_json::from_str::<Value>(text).is_ok_and(|value| value.is_array())
}

fn valid_widgets(widgets: &str) -> Result<(), StorageError> {
    if is_widgets_blob(widgets) {
        Ok(())
    } else {
        Err(StorageError::Invalid {
            what: "a home board's widgets are JSON array text".to_owned(),
        })
    }
}

/// A cover a peer reads: one it cannot read is dropped there
/// (`HomePageCoverSyncSchema`'s `.catch(undefined)`).
fn valid_cover(cover: &Value) -> Result<(), StorageError> {
    if is_readable_cover(cover) {
        Ok(())
    } else {
        Err(StorageError::Invalid {
            what: "a home board's cover is not one the cover schema reads".to_owned(),
        })
    }
}

/// A position as Electron writes it: an integer when it is one.
fn number(position: f64) -> Result<Value, StorageError> {
    if !position.is_finite() {
        return Err(StorageError::Invalid {
            what: "a home board's position is a finite number".to_owned(),
        });
    }
    // Exact for every integer an f64 holds below 2^53.
    if position.fract() == 0.0 && position.abs() < 9_007_199_254_740_992.0 {
        return Ok(json!(position as i64));
    }
    Ok(json!(position))
}

#[cfg(test)]
mod tests;
