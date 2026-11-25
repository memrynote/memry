//! Synced settings (T130, Q13.1, FR-033, FR-063).
//!
//! One sync item, id `synced_settings` (chapter 13 §13.6), payload
//! `{ settings, fieldClocks }` (§13.7.13), merged by **dotted path at arbitrary
//! depth** (chapter 06 §6.9).
//!
//! ## Why this module parses raw JSON and not a schema
//!
//! `SyncedSettingsSchema` is a closed object, so a parse **strips a group this
//! build does not model** — `experimental` among them — exactly as §13.2.1
//! describes for every other type. §13.10's answer to Q13.1 is that there is
//! no settings-specific preservation mechanism and none is needed: the verbatim
//! `sync_items.payload` is the copy.
//!
//! That answer only holds if the **write** path never re-serialises the read
//! view. So every function here walks the raw parsed object out of
//! [`StoredPayload::object`] and hands the changed object back through
//! [`StoredPayload::merge`] (§13.2 rule 3). A sibling group is carried by
//! **clone and mutate**, never by rebuild, so `experimental` survives a write
//! to `general.theme` byte for byte, and FR-063's "a preference with no
//! equivalent" comes back to desktop unchanged.
//!
//! The eleven modelled groups
//! ([`MODELLED_GROUPS`](crate::storage::repositories::projectors::settings::MODELLED_GROUPS))
//! stay where they are — in the **projector**, which is the closed read view
//! the vectors pin. This module deliberately has no group list: a dotted-path
//! write is not a claim to model the group it writes into, and adding a filter
//! here would strip on write what §13.2 exists to preserve.
//!
//! ## The dotted path is a nested [`Change`]
//!
//! [`Change::Set`] with a `null` is §13.4's explicit clear; [`Change::Remove`]
//! drops the key so a receiver keeps its own value. This module applies exactly
//! that distinction one or more levels down, rather than inventing a second
//! vocabulary for it.
//!
//! **A change always ticks the path's field clock, including a removal.** A
//! removal that did not tick would lose to the peer that still holds the old
//! value, and the setting would resurrect on the next pull.

use rusqlite::{Connection, params};
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::storage::nested_tx;
use crate::storage::repositories::projectors::settings::SETTINGS_ITEM_ID;
use crate::storage::repositories::{Change, StoredPayload, sync_items};
use crate::sync::clock::{self, VectorClock};
use crate::sync::{outbox, unknown_signer};

/// The item type half of the `(type, id)` key (§13.6).
pub const SETTINGS_ITEM_TYPE: &str = "settings";

/// The payload a vault with no settings item yet starts from.
///
/// Both keys are present because the reader marks both required (§13.7.13),
/// and it matches the committed `settings: boundary` vector exactly.
const EMPTY_PAYLOAD: &str = r#"{"settings":{},"fieldClocks":{}}"#;

/// Every synced setting, as the payload spells it — **including groups this
/// build does not model**.
///
/// This is the source of record, not the `settings` projection table. The
/// projection is the closed ten-group read view (§13.10.1); this is the raw
/// object, and reading a path out of it is not the same as modelling it.
///
/// A vault with no settings item has no settings, which is what an empty map
/// means here. A payload that will not parse is a **hard error**, never an
/// empty map: a silent empty would make the next [`set`] push a payload that
/// deleted every preference on every device.
pub fn all(conn: &Connection) -> Result<Map<String, Value>, StorageError> {
    let Some(payload) = stored(conn)? else {
        return Ok(Map::new());
    };
    settings_of(payload.object())
}

/// One setting by dotted path, for example `general.theme` or
/// `journal.weekdayTemplates.3`.
pub fn read(conn: &Connection, path: &str) -> Result<Option<Value>, StorageError> {
    let segments = segments(path)?;
    Ok(value_at(&all(conn)?, &segments).cloned())
}

/// The vector clock recorded against one dotted path (§6.9), or `None` for a
/// path no device has ticked.
pub fn field_clock(conn: &Connection, path: &str) -> Result<Option<VectorClock>, StorageError> {
    let Some(payload) = stored(conn)? else {
        return Ok(None);
    };
    let clocks = field_clocks_of(payload.object())?;
    clocks
        .get(path)
        .map(|value| read_clock(value, path))
        .transpose()
}

/// Writes one setting.
pub fn set(
    conn: &Connection,
    path: &str,
    value: Value,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    apply(conn, path, Change::Set(value), device_id, now_ms)
}

/// Clears one setting, leaving the key present and `null` (§13.4).
pub fn clear(
    conn: &Connection,
    path: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    apply(conn, path, Change::Set(Value::Null), device_id, now_ms)
}

/// Drops one setting, so a receiver keeps its own value for it (§13.4).
pub fn remove(
    conn: &Connection,
    path: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    apply(conn, path, Change::Remove, device_id, now_ms)
}

/// The one write, and the only place the payload is rebuilt.
///
/// The merged payload and the outbox row that publishes it commit together
/// (FR-030, data-model §A.2). A change that changes nothing rolls the
/// transaction back and pushes nothing.
///
/// The path should be the **leaf** the user edited. Chapter 06 §6.9's examples
/// are all leaves and the chapter says nothing about what becomes of the field
/// clocks under a path that replaces a whole subtree, so nothing here prunes
/// them: dropping a clock is not a reversible guess.
pub fn apply(
    conn: &Connection,
    path: &str,
    change: Change,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let (merged, _) = apply_many(conn, &[(path, change)], device_id, now_ms, |_| Ok(()))?;
    Ok(merged)
}

/// [`apply`] over several paths in **one** transaction, plus `within`, which
/// runs in that same transaction after the payload is merged. That is how a
/// settings group write keeps its synced fields and its device-local blob
/// all-or-nothing.
///
/// Each path that changes ticks its own clock; one that does not is left
/// alone. The `bool` is whether anything changed. When nothing did, the
/// transaction rolls back, nothing is seeded or published, and `within` is
/// **not** run: the caller does its own write, which needs no transaction
/// with the synced item because that item did not move.
pub(crate) fn apply_many(
    conn: &Connection,
    changes: &[(&str, Change)],
    device_id: &str,
    now_ms: i64,
    within: impl FnOnce(&Connection) -> Result<(), StorageError>,
) -> Result<(String, bool), StorageError> {
    let parsed: Vec<(&str, Vec<&str>, &Change)> = changes
        .iter()
        .map(|(path, change)| Ok((*path, segments(path)?, change)))
        .collect::<Result<_, StorageError>>()?;
    let tx = nested_tx::begin(conn).map_err(failed)?;
    let seeds_deleted = sync_items::load(&tx, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID)?
        .is_some_and(|row| row.payload.is_none() && row.deleted_at.is_some());
    ensure_item(&tx, now_ms)?;
    if seeds_deleted {
        // Builds before #5434 left this row while the server copy stayed live
        // below the cursor. The push waits until a re-pull merges that copy, or
        // the seed's one key would replace the account's settings.
        unknown_signer::refused(&tx, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID)?;
    }

    let payload = stored(&tx)?.ok_or_else(|| StorageError::Failed {
        what: format!("{SETTINGS_ITEM_TYPE}/{SETTINGS_ITEM_ID} has no payload to merge into"),
    })?;
    let mut settings = settings_of(payload.object())?;
    let mut field_clocks = field_clocks_of(payload.object())?;
    let mut any = false;
    for (path, segments, change) in parsed {
        if !apply_at(&mut settings, &segments, change, path)? {
            continue;
        }
        any = true;
        let ticked = match field_clocks.get(path) {
            Some(value) => clock::increment(&read_clock(value, path)?, device_id),
            None => clock::increment(&VectorClock::new(), device_id),
        };
        field_clocks.insert(path.to_owned(), clock_value(&ticked));
    }
    if !any {
        // Nothing changed, so nothing is written — not even the seed row.
        return Ok((payload.raw().to_owned(), false));
    }

    let changes = [
        ("settings", Change::Set(Value::Object(settings))),
        ("fieldClocks", Change::Set(Value::Object(field_clocks))),
    ];
    revive(&tx)?;
    let merged = sync_items::apply_local_edit_in(
        &tx,
        SETTINGS_ITEM_TYPE,
        SETTINGS_ITEM_ID,
        &changes,
        now_ms,
    )?;
    outbox::enqueue(
        &tx,
        &outbox::Change::upsert(SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID),
        now_ms,
    )?;
    within(&tx)?;
    tx.commit().map_err(failed)?;
    Ok((merged, true))
}

/// Seeds the one settings item when the vault has never synced one.
///
/// `DO NOTHING` rather than an upsert: a row already there — including one
/// still `metadata-only`, whose body has not been pulled yet — is left exactly
/// as it is. Clobbering a body this device has not downloaded would lose every
/// preference the account already holds.
///
/// The one exception is a deleted row with no payload: an earlier build applied
/// a settings delete before this device pulled the item (#5433). No body is
/// owed for a deleted row, so it is seeded like a missing one, and [`revive`]
/// then brings it back live with the edit. [`apply`] holds its push until the
/// server copy is re-pulled and merged.
fn ensure_item(tx: &Connection, now_ms: i64) -> Result<(), StorageError> {
    tx.execute(
        "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(item_type, item_id) DO UPDATE SET
             payload = excluded.payload, payload_state = excluded.payload_state
         WHERE sync_items.payload IS NULL AND sync_items.deleted_at IS NOT NULL",
        params![
            SETTINGS_ITEM_TYPE,
            SETTINGS_ITEM_ID,
            EMPTY_PAYLOAD,
            sync_items::PAYLOAD_STATE_FULL,
            now_ms
        ],
    )
    .map_err(failed)?;
    Ok(())
}

/// Clears a delete an earlier build applied to the settings row (#5433).
///
/// Settings are never deleted now (`sync::apply` skips a pulled settings
/// delete, as desktop does), so a deleted row can only be that build's. Left
/// deleted, every later edit would retire unsent (`push::settle::undeletes`).
/// Called by both writers before they merge, so the payload the delete kept
/// comes back live with the edit, and the projection with it.
pub(crate) fn revive(tx: &Connection) -> Result<(), StorageError> {
    tx.execute(
        "UPDATE sync_items SET deleted_at = NULL
         WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NOT NULL",
        params![SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID],
    )
    .map_err(failed)?;
    Ok(())
}

/// Applies one [`Change`] at a dotted path, reporting whether it changed
/// anything. Missing intermediate objects are created; a non-object in the way
/// is refused rather than overwritten, because overwriting it would delete
/// every sibling under it.
pub(crate) fn apply_at(
    node: &mut Map<String, Value>,
    segments: &[&str],
    change: &Change,
    path: &str,
) -> Result<bool, StorageError> {
    let (head, rest) = segments
        .split_first()
        .expect("`segments` rejects an empty path");

    if rest.is_empty() {
        return Ok(match change {
            Change::Set(value) => {
                let unchanged = node.get(*head) == Some(value);
                if !unchanged {
                    node.insert((*head).to_owned(), value.clone());
                }
                !unchanged
            }
            Change::Remove => node.remove(*head).is_some(),
        });
    }

    if !matches!(node.get(*head), Some(Value::Object(_))) {
        match node.get(*head) {
            None | Some(Value::Null) => {}
            Some(_) => {
                return Err(StorageError::Failed {
                    what: format!("settings `{path}`: `{head}` is not an object"),
                });
            }
        }
        if matches!(change, Change::Remove) {
            return Ok(false);
        }
        node.insert((*head).to_owned(), Value::Object(Map::new()));
    }

    let Some(Value::Object(child)) = node.get_mut(*head) else {
        unreachable!("an object was just ensured at `{head}`");
    };
    apply_at(child, rest, change, path)
}

/// The value at a dotted path, or `None` when any segment is missing.
pub(crate) fn value_at<'a>(node: &'a Map<String, Value>, segments: &[&str]) -> Option<&'a Value> {
    let (head, rest) = segments.split_first()?;
    let value = node.get(*head)?;
    if rest.is_empty() {
        return Some(value);
    }
    value_at(value.as_object()?, rest)
}

/// Splits a dotted path. An empty path, or one with an empty segment, is
/// refused: `general.` would write a `""` key that no peer could address.
pub(crate) fn segments(path: &str) -> Result<Vec<&str>, StorageError> {
    let parts: Vec<&str> = path.split('.').collect();
    if parts.iter().any(|part| part.is_empty()) {
        return Err(StorageError::Failed {
            what: format!("`{path}` is not a settings path"),
        });
    }
    Ok(parts)
}

/// The stored payload, or `None` when the vault has no settings item yet.
fn stored(conn: &Connection) -> Result<Option<StoredPayload>, StorageError> {
    let Some(row) = sync_items::load(conn, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID)? else {
        return Ok(None);
    };
    let Some(stored) = row.payload else {
        return Ok(None);
    };
    StoredPayload::parse(&stored)
        .map(Some)
        .map_err(|error| StorageError::Failed {
            what: format!(
                "{SETTINGS_ITEM_TYPE}/{SETTINGS_ITEM_ID} payload will not parse: {error}"
            ),
        })
}

pub(crate) fn settings_of(object: &Map<String, Value>) -> Result<Map<String, Value>, StorageError> {
    object_at(object, "settings")
}

pub(crate) fn field_clocks_of(
    object: &Map<String, Value>,
) -> Result<Map<String, Value>, StorageError> {
    object_at(object, "fieldClocks")
}

/// One of the payload's two top-level objects. Absent and `null` are both
/// empty; anything else is an error rather than a substituted empty map.
fn object_at(object: &Map<String, Value>, key: &str) -> Result<Map<String, Value>, StorageError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(values)) => Ok(values.clone()),
        Some(_) => Err(StorageError::Failed {
            what: format!("settings payload: `{key}` is not an object"),
        }),
    }
}

/// A field clock as ticks. A clock that will not read is a hard error rather
/// than an empty clock: an empty one lowers `clockTotal` and changes who wins
/// the next merge (chapter 06 §6.10).
pub(crate) fn read_clock(value: &Value, path: &str) -> Result<VectorClock, StorageError> {
    let refuse = || StorageError::Failed {
        what: format!("settings `{path}`: field clock is not a vector clock"),
    };
    value
        .as_object()
        .ok_or_else(refuse)?
        .iter()
        .map(|(device, tick)| Ok((device.clone(), tick.as_u64().ok_or_else(refuse)?)))
        .collect()
}

fn clock_value(clock: &VectorClock) -> Value {
    Value::Object(
        clock
            .iter()
            .map(|(device, tick)| (device.clone(), Value::from(*tick)))
            .collect(),
    )
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

#[cfg(test)]
mod tests;
