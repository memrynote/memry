//! Saved task filters: the `filter` sync type (spec 004 TP022,
//! `FilterSyncPayloadSchema` in `packages/contracts/src/sync-payloads.ts`).
//!
//! Desktop is the reference (`apps/desktop/src/main/ipc/saved-filters-handlers.ts`,
//! `packages/sync-client/src/filter-sync.ts`,
//! `packages/sync-client/src/item-handlers/filter-handler.ts`):
//!
//! - the payload is `{name, config, position, clock, createdAt}` and nothing
//!   else: no `modifiedAt`, no `fieldClocks`. `filter` is resolved
//!   document-level (§6.8's fourth row), so a local edit ticks the document
//!   clock and only that;
//! - `config` is `{filters, sort?, starred?}` on desktop and `z.unknown()` on
//!   the wire. It is kept here as **opaque JSON**: an edit deep-merges the
//!   caller's object into the stored one ([`merge_config`]), so a key a newer
//!   build wrote survives an edit made on this device (§13.2 rule 3). Typed
//!   reads go through [`TaskFilters::from_json`] and [`TaskSort::from_json`];
//! - a new filter goes to `max(position) + 1` (`getNextSavedFilterPosition`);
//! - star and unstar write `config.starred` as a boolean, `false` included
//!   (`use-task-filters.ts` `toggleStar`).
//!
//! Every write is one transaction with its outbox row(s), through
//! [`outbox::commit`] or [`outbox::enqueue`] inside one transaction.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::crypto::sodium;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{Change, StoredPayload, sync_items};
use crate::sync::outbox::{self, Durable};

use super::notes::{failed, insert_local, iso, next_clock, object, require_payload};
use super::task_filter::{TaskFilters, TaskSort};
use super::tasks::valid_item_id;

/// The `(type, _)` half of every key this module writes.
pub const ITEM_TYPE: &str = "filter";

/// Desktop's `SavedFilterCreateSchema` / `SavedFilterUpdateSchema` bound on
/// `name`, in UTF-16 code units as zod counts them.
pub const MAX_NAME_LEN: usize = 100;

/// `nanoid()`'s length and alphabet, the id shape desktop's `generateId()`
/// mints (`apps/desktop/src/main/lib/id.ts`).
const ID_LEN: usize = 21;
const ID_ALPHABET: &[u8; 64] = b"useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/// One live saved filter, read from the `saved_filters` projection.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedFilter {
    pub id: String,
    pub name: String,
    /// The payload's `config`, verbatim; `{}` when the payload carries none.
    pub config: Value,
    pub position: i64,
    /// Epoch milliseconds, or `None` when the payload carried no readable
    /// `createdAt`.
    pub created_at_ms: Option<i64>,
}

impl SavedFilter {
    /// `config.filters`, missing or mistyped fields at desktop's defaults.
    pub fn filters(&self) -> TaskFilters {
        self.config
            .get("filters")
            .map_or_else(TaskFilters::default, TaskFilters::from_json)
    }

    /// `config.sort`, or `None` when absent, null or incomplete.
    pub fn sort(&self) -> Option<TaskSort> {
        self.config.get("sort").and_then(TaskSort::from_json)
    }

    /// `config.starred`, `false` unless it is the boolean `true`
    /// (`starred: config.starred ?? false`).
    pub fn starred(&self) -> bool {
        self.config.get("starred").and_then(Value::as_bool) == Some(true)
    }
}

/// What a new saved filter carries.
#[derive(Debug, Clone, Copy)]
pub struct NewSavedFilter<'a> {
    /// `None` mints a nanoid-shaped id.
    pub id: Option<&'a str>,
    pub name: &'a str,
    /// `{filters, sort?, starred?}`; stored as given, unknown keys included.
    pub config: &'a Value,
}

/// Every live saved filter, in `position` order with `id` as the tiebreak.
pub fn list(conn: &Connection) -> Result<Vec<SavedFilter>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id, name, config, position, created_at
               FROM saved_filters
              WHERE deleted_at IS NULL
              ORDER BY position, id",
        )
        .map_err(failed)?;
    let rows = statement.query_map([], read_row).map_err(failed)?;
    let mut filters = Vec::new();
    for row in rows {
        filters.push(finish(row.map_err(failed)?)?);
    }
    Ok(filters)
}

/// One live saved filter by id.
pub fn get(conn: &Connection, filter_id: &str) -> Result<Option<SavedFilter>, StorageError> {
    conn.query_row(
        "SELECT id, name, config, position, created_at
           FROM saved_filters
          WHERE id = ?1 AND deleted_at IS NULL",
        params![filter_id],
        read_row,
    )
    .optional()
    .map_err(failed)?
    .map(finish)
    .transpose()
}

/// Creates a saved filter at the end of the list.
pub fn create(
    conn: &Connection,
    filter: &NewSavedFilter<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<SavedFilter>, StorageError> {
    valid_name(filter.name)?;
    let config = valid_config(filter.config)?;
    if !config.get("filters").is_some_and(Value::is_object) {
        return Err(StorageError::Failed {
            what: "a saved filter's config needs a `filters` object".to_owned(),
        });
    }
    let id = match filter.id {
        Some(id) => valid_item_id(id)?.to_owned(),
        None => mint_id(),
    };
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &id),
        now_ms,
        |tx| {
            let payload = object(json!({
                "name": filter.name,
                "config": config,
                "position": next_position(tx)?,
                "clock": next_clock(&Object::new(), device_id)?,
                "createdAt": iso(now_ms)?,
            }));
            insert_local(tx, ITEM_TYPE, &id, payload, now_ms)?;
            read_back(tx, &id)
        },
    )
}

/// Renames a filter and/or edits its config. `None` leaves a part alone.
///
/// `config` is deep-merged into the stored config ([`merge_config`]): a key
/// the caller sends replaces the stored one (an explicit `null` clears it),
/// and a key it does not send survives. Desktop replaces `config` wholesale;
/// merging is what keeps a key a newer build wrote (D7).
pub fn update(
    conn: &Connection,
    filter_id: &str,
    name: Option<&str>,
    config: Option<&Value>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<SavedFilter>, StorageError> {
    if let Some(name) = name {
        valid_name(name)?;
    }
    let config = config.map(valid_config).transpose()?;
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, filter_id),
        now_ms,
        |tx| {
            let stored = live_payload(tx, filter_id)?;
            let mut changes = Vec::new();
            if let Some(name) = name {
                changes.push(("name", Change::set(name)));
            }
            if let Some(config) = config {
                changes.push(("config", Change::Set(merged_config(&stored, config))));
            }
            edit_in(tx, filter_id, &stored, changes, device_id, now_ms)?;
            read_back(tx, filter_id)
        },
    )
}

/// Stars or unstars a filter: `config.starred`, written as a boolean either
/// way, as desktop's `toggleStar` does.
pub fn set_starred(
    conn: &Connection,
    filter_id: &str,
    starred: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<SavedFilter>, StorageError> {
    update(
        conn,
        filter_id,
        None,
        Some(&json!({ "starred": starred })),
        device_id,
        now_ms,
    )
}

/// Tombstones a filter. The pushed payload is the stored one under a ticked
/// clock, which is desktop's delete payload (the row snapshot, clock
/// incremented).
pub fn delete(
    conn: &Connection,
    filter_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<()>, StorageError> {
    outbox::commit(
        conn,
        &outbox::Change::delete(ITEM_TYPE, filter_id),
        now_ms,
        |tx| {
            let stored = live_payload(tx, filter_id)?;
            tx.execute(
                "UPDATE sync_items SET deleted_at = ?3, updated_at = ?3
                  WHERE item_type = ?1 AND item_id = ?2",
                params![ITEM_TYPE, filter_id, now_ms],
            )
            .map_err(failed)?;
            edit_in(tx, filter_id, &stored, Vec::new(), device_id, now_ms)?;
            Ok(())
        },
    )
}

/// Sets `positions[i]` on `ids[i]`, desktop's `reorderSavedFilters` contract,
/// in **one** transaction with one outbox row per filter that moved.
///
/// An id that is not a live filter is passed over, as desktop's per-row
/// `UPDATE ... WHERE id = ?` does, so a filter deleted by a peer mid-drag does
/// not fail the whole reorder. A filter already at its position is not
/// rewritten. Returns the ids that moved.
pub fn reorder(
    conn: &Connection,
    ids: &[String],
    positions: &[i64],
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    if ids.len() != positions.len() {
        return Err(StorageError::Failed {
            what: "ids and positions arrays must have the same length".to_owned(),
        });
    }
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let mut moved = Vec::new();
    for (id, position) in ids.iter().zip(positions) {
        let Some(current) = get(&tx, id)? else {
            continue;
        };
        if current.position == *position {
            continue;
        }
        let stored = live_payload(&tx, id)?;
        edit_in(
            &tx,
            id,
            &stored,
            vec![("position", Change::set(*position))],
            device_id,
            now_ms,
        )?;
        outbox::enqueue(&tx, &outbox::Change::upsert(ITEM_TYPE, id), now_ms)?;
        moved.push(id.clone());
    }
    tx.commit().map_err(failed)?;
    Ok(moved)
}

/// Deep-merges `edit` into `stored`: objects merge key by key, recursively;
/// anything else in `edit` (arrays, scalars, `null`) replaces.
///
/// Public so the orchestrator's shell layer and the tests can state exactly
/// what an edit keeps.
pub fn merge_config(stored: &Value, edit: &Value) -> Value {
    match (stored, edit) {
        (Value::Object(base), Value::Object(patch)) => {
            let mut out = base.clone();
            for (key, value) in patch {
                let merged = match out.get(key) {
                    Some(existing) => merge_config(existing, value),
                    None => value.clone(),
                };
                out.insert(key.clone(), merged);
            }
            Value::Object(out)
        }
        _ => edit.clone(),
    }
}

/// One local edit to one filter inside the caller's transaction: the changes
/// plus the ticked document clock, merged into the stored payload.
fn edit_in(
    tx: &Connection,
    filter_id: &str,
    stored: &StoredPayload,
    mut changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    changes.push((
        "clock",
        Change::Set(next_clock(stored.object(), device_id)?),
    ));
    sync_items::apply_local_edit_in(tx, ITEM_TYPE, filter_id, &changes, now_ms)
}

/// The stored payload of a filter that exists and is not deleted.
fn live_payload(tx: &Connection, filter_id: &str) -> Result<StoredPayload, StorageError> {
    let row = sync_items::load(tx, ITEM_TYPE, filter_id)?;
    if row.as_ref().is_none_or(|row| row.deleted_at.is_some()) {
        return Err(StorageError::Failed {
            what: format!("no saved filter {filter_id}"),
        });
    }
    require_payload(tx, ITEM_TYPE, filter_id)
}

/// The stored `config` with `edit` merged in; a missing or `null` stored
/// config merges as `{}`.
fn merged_config(stored: &StoredPayload, edit: &Value) -> Value {
    match stored.object().get("config") {
        Some(existing) if !existing.is_null() => merge_config(existing, edit),
        _ => merge_config(&Value::Object(Object::new()), edit),
    }
}

fn read_back(tx: &Connection, filter_id: &str) -> Result<SavedFilter, StorageError> {
    get(tx, filter_id)?.ok_or_else(|| StorageError::Failed {
        what: format!("saved filter {filter_id} did not project"),
    })
}

/// `getNextSavedFilterPosition`: one past the largest live position, 0 for
/// the first filter.
fn next_position(tx: &Connection) -> Result<i64, StorageError> {
    let max: Option<i64> = tx
        .query_row(
            "SELECT max(position) FROM saved_filters WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(failed)?;
    Ok(max.map_or(0, |max| max + 1))
}

fn valid_name(name: &str) -> Result<(), StorageError> {
    let len = name.encode_utf16().count();
    if len == 0 || len > MAX_NAME_LEN {
        return Err(StorageError::Failed {
            what: format!("a saved filter name is 1 to {MAX_NAME_LEN} characters"),
        });
    }
    Ok(())
}

fn valid_config(config: &Value) -> Result<&Value, StorageError> {
    if !config.is_object() {
        return Err(StorageError::Failed {
            what: "a saved filter's config is a JSON object".to_owned(),
        });
    }
    Ok(config)
}

/// A nanoid: 21 symbols of the URL-safe alphabet. 64 divides 256, so masking
/// a random byte to six bits is unbiased.
fn mint_id() -> String {
    sodium::random_bytes(ID_LEN)
        .into_iter()
        .map(|byte| char::from(ID_ALPHABET[usize::from(byte & 63)]))
        .collect()
}

type RawRow = (String, String, Option<String>, i64, Option<i64>);

fn read_row(row: &Row<'_>) -> rusqlite::Result<RawRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}

fn finish(
    (id, name, config, position, created_at_ms): RawRow,
) -> Result<SavedFilter, StorageError> {
    let config = match config {
        None => Value::Object(Object::new()),
        Some(text) => serde_json::from_str(&text).map_err(|error| StorageError::Failed {
            what: format!("saved filter {id}: cached config is not JSON: {error}"),
        })?,
    };
    Ok(SavedFilter {
        id,
        name,
        config,
        position,
        created_at_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minted_id_is_nanoid_shaped() {
        let id = mint_id();
        assert_eq!(id.len(), ID_LEN);
        assert!(
            id.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        );
        assert_ne!(mint_id(), id);
    }

    #[test]
    fn merge_config_keeps_unsent_keys_at_every_depth_and_replaces_the_rest() {
        let stored = json!({
            "filters": { "search": "a", "projectIds": ["p1"], "futureFilter": 1 },
            "sort": { "field": "title", "direction": "asc" },
            "layout": "board",
        });
        let edit = json!({
            "filters": { "search": "b", "projectIds": [] },
            "sort": null,
        });
        assert_eq!(
            merge_config(&stored, &edit),
            json!({
                "filters": { "search": "b", "projectIds": [], "futureFilter": 1 },
                "sort": null,
                "layout": "board",
            })
        );
    }

    #[test]
    fn a_name_is_one_to_a_hundred_utf16_units() {
        assert!(valid_name("").is_err());
        assert!(valid_name("Due soon").is_ok());
        assert!(valid_name(&"x".repeat(MAX_NAME_LEN)).is_ok());
        assert!(valid_name(&"x".repeat(MAX_NAME_LEN + 1)).is_err());
    }
}
