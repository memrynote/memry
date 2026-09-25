//! Tag and property writes on a journal day, addressed by date (JP021).
//!
//! Each write resolves the day through [`journal::live_entry`] and, when the
//! day has no live entry, creates or revives it in the **same** transaction as
//! the write ([`journal::open_day_in`], D2). A write that would leave an absent
//! day empty (no tags, a cleared property) creates nothing.
//!
//! The payload keeps desktop's shape (D5, `JournalSyncPayloadSchema`): the
//! changed key is merged into the stored payload, so unknown keys survive, and
//! an update also writes `content: null`, the advanced document clock and
//! `modifiedAt`. A day created by the write keeps its create-time
//! `content: ""`. `journal` merges document-level (chapter 06 §6.8), so there
//! are no field clocks to tick.
//!
//! The `date` property is reserved: a write naming it is refused, and the maps
//! returned here never contain it. A stored `date` property written by desktop
//! is kept in the payload untouched.
//!
//! Property order is not written: the core's payload map is sorted by key
//! (`storage/repositories/payload.rs`), so a reorder has no representation.

use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::domain::journal::{self, ITEM_TYPE};
use crate::domain::notes::{failed, iso, next_clock, require_payload};
use crate::domain::properties::{self, PropertyError};
use crate::domain::tags;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox;

/// The property name the journal payload reserves for the day itself.
pub const RESERVED_PROPERTY: &str = "date";

/// Replaces the day's tags, deduped case-insensitively as [`tags::set`] does
/// (first spelling wins, `pinnedTags` loses dropped tags only when present).
///
/// Returns the stored list. An empty list on an absent day creates nothing.
pub fn set_tags(
    conn: &Connection,
    date: &str,
    tags: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let creates = !tags::dedupe(tags.iter().cloned()).is_empty();
    write_day(conn, date, creates, device_id, now_ms, |object| {
        let (next, changes) = tags::set_changes(object, ITEM_TYPE, date, tags)?;
        Ok((changes, next))
    })
}

/// Writes one property value, keeping the type it already holds
/// ([`properties::refuse_retype`], [`PropertyError::Retyped`]).
///
/// `Value::Null` is the explicit clear; see [`clear_property`]. Returns the
/// day's properties without `date`.
pub fn set_property(
    conn: &Connection,
    date: &str,
    name: &str,
    value: Value,
    device_id: &str,
    now_ms: i64,
) -> Result<Map<String, Value>, PropertyError> {
    refuse_reserved(name)?;
    if value.is_null() && journal::live_entry(conn, date)?.is_none() {
        // Clearing on a day with no entry leaves it absent.
        return Ok(Map::new());
    }
    write_day(conn, date, true, device_id, now_ms, |object| {
        let mut values = properties::read_values(object, ITEM_TYPE, date)?;
        properties::refuse_retype(name, values.get(name), &value)?;
        if values.get(name) == Some(&value) {
            return Ok((Vec::new(), visible(values)));
        }
        values.insert(name.to_owned(), value.clone());
        Ok((properties_change(&values), visible(values)))
    })
}

/// Clears one property, leaving the key present and `null` (§13.4). An absent
/// day stays absent.
pub fn clear_property(
    conn: &Connection,
    date: &str,
    name: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Map<String, Value>, PropertyError> {
    set_property(conn, date, name, Value::Null, device_id, now_ms)
}

/// Drops one property key. Removing a key the day does not carry writes
/// nothing.
pub fn remove_property(
    conn: &Connection,
    date: &str,
    name: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Map<String, Value>, StorageError> {
    refuse_reserved(name)?;
    write_day(conn, date, false, device_id, now_ms, |object| {
        let mut values = properties::read_values(object, ITEM_TYPE, date)?;
        if values.remove(name).is_none() {
            return Ok((Vec::new(), visible(values)));
        }
        Ok((properties_change(&values), visible(values)))
    })
}

/// Renames one property, keeping its value, as desktop's `properties:rename`
/// does: a missing `from` is [`StorageError::NotFound`], an existing `to` is
/// [`StorageError::Invalid`], and `from == to` writes nothing.
pub fn rename_property(
    conn: &Connection,
    date: &str,
    from: &str,
    to: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Map<String, Value>, StorageError> {
    refuse_reserved(from)?;
    refuse_reserved(to)?;
    write_day(conn, date, false, device_id, now_ms, |object| {
        let mut values = properties::read_values(object, ITEM_TYPE, date)?;
        if !values.contains_key(from) {
            return Err(StorageError::NotFound {
                what: format!("journal {date} has no property `{from}`"),
            });
        }
        if from == to {
            return Ok((Vec::new(), visible(values)));
        }
        if values.contains_key(to) {
            return Err(StorageError::Invalid {
                what: format!("journal {date} already has a property `{to}`"),
            });
        }
        if let Some(value) = values.remove(from) {
            values.insert(to.to_owned(), value);
        }
        Ok((properties_change(&values), visible(values)))
    })
}

/// One metadata write on the day for `date`, in one transaction.
///
/// `plan` reads the stored payload and returns the changes to merge (empty
/// means unchanged) and the caller's result. `creates` says whether the write
/// may create or revive a day with no live entry; when it may not, `plan` runs
/// against an empty payload and nothing is written.
fn write_day<T, E>(
    conn: &Connection,
    date: &str,
    creates: bool,
    device_id: &str,
    now_ms: i64,
    plan: impl FnOnce(&Object) -> Result<(Vec<(&'static str, Change)>, T), E>,
) -> Result<T, E>
where
    E: From<StorageError>,
{
    let tx = conn.unchecked_transaction().map_err(failed)?;
    if journal::live_entry(&tx, date)?.is_none() && !creates {
        return plan(&Object::new()).map(|(_, out)| out);
    }
    let opened = journal::open_day_in(&tx, date, device_id, now_ms)?;
    let stored = require_payload(&tx, ITEM_TYPE, &opened.id)?;
    let (mut changes, out) = plan(stored.object())?;
    let opened_now = opened.created || opened.revived;
    if changes.is_empty() {
        // Dropping the transaction rolls back; a revive alone is still a write.
        if opened_now {
            tx.commit().map_err(failed)?;
        }
        return Ok(out);
    }
    if !opened.created {
        changes.push(("content", Change::Set(Value::Null)));
    }
    if !opened_now {
        // `open_day_in` already stamped a created or revived day.
        changes.push((
            "clock",
            Change::Set(next_clock(stored.object(), device_id)?),
        ));
        changes.push(("modifiedAt", Change::set(iso(now_ms)?)));
    }
    sync_items::apply_local_edit_in(&tx, ITEM_TYPE, &opened.id, &changes, now_ms)?;
    outbox::enqueue(&tx, &outbox::Change::upsert(ITEM_TYPE, &opened.id), now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(out)
}

fn refuse_reserved(name: &str) -> Result<(), StorageError> {
    if name == RESERVED_PROPERTY {
        return Err(StorageError::Invalid {
            what: format!("the `{RESERVED_PROPERTY}` property is reserved on a journal day"),
        });
    }
    Ok(())
}

fn properties_change(values: &Map<String, Value>) -> Vec<(&'static str, Change)> {
    vec![("properties", Change::Set(Value::Object(values.clone())))]
}

/// The property map a caller sees: everything but the reserved `date`.
fn visible(mut values: Map<String, Value>) -> Map<String, Value> {
    values.remove(RESERVED_PROPERTY);
    values
}
