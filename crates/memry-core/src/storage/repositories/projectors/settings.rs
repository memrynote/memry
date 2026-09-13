//! `settings`: one sync item, id `synced_settings` (chapter 13 §13.7.13,
//! §13.10, chapter 06 §6.9, data-model §A.4).
//!
//! This is the type where §13.2 earns its keep most visibly. `SyncedSettings`
//! is a closed object, so a parse strips a group this build does not model —
//! and the answer to Q13.1 is that **there is no settings-specific
//! preservation mechanism and none is needed**: the verbatim
//! `sync_items.payload` is the copy, exactly as it is for every other type. A
//! client that implements §13.2 round-trips an unmodelled group for free; a
//! client that re-serialises a projection deletes another device's preferences.
//!
//! Two levels, and they behave differently on purpose (§13.10):
//!
//! - the **group** level is closed, so `experimental` is not in the read view;
//! - the **key** level inside a modelled group is open, because the schemas
//!   leave those keys as unconstrained strings precisely so one malformed or
//!   future key cannot stall every other synced setting.
//!
//! `fieldClocks` is keyed by **dotted path at arbitrary depth** and is never
//! filtered: a clock for a path this build cannot model still has to survive,
//! or the next merge loses the ordering for it.

use rusqlite::{Connection, params};
use serde_json::{Map, Value};

use crate::api::errors::StorageError;

use super::super::payload;
use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{ItemContext, failed};

/// The one item id `settings` ever has (§13.6).
pub const SETTINGS_ITEM_ID: &str = "synced_settings";

/// The modelled groups of `SyncedSettingsSchema`.
///
/// A group outside this list is stripped from the read view and survives only
/// in the verbatim payload, which is what FR-063 requires: a preference with no
/// phone equivalent must come back unchanged.
pub const MODELLED_GROUPS: [&str; 10] = [
    "general", "editor", "tasks", "calendar", "keyboard", "notes", "sync", "inbox", "journal",
    "sidebar",
];

const SETTINGS_FIELDS: &[Field] = &[
    Field::req("settings", Kind::Object),
    Field::req("fieldClocks", Kind::ClockMap),
];

pub fn read_settings(parsed: &Object) -> Result<Object, ProjectionError> {
    let mut view = read_fields("settings", parsed, SETTINGS_FIELDS)?;

    // The group filter is the closed half of §13.10 and cannot be expressed as
    // a field table, because the closed level is one below the payload's own
    // keys.
    let groups = view
        .get("settings")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut modelled = Map::new();
    for (name, contents) in groups {
        if MODELLED_GROUPS.contains(&name.as_str()) {
            modelled.insert(name, contents);
        }
    }
    view.insert("settings".to_owned(), Value::Object(modelled));

    Ok(view)
}

pub fn project_settings(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    let field_clocks = view
        .get("fieldClocks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    // Both tables are a flattened index of one item, so the item's payload is
    // the whole truth for them and they are rebuilt rather than diffed.
    conn.execute("DELETE FROM settings", []).map_err(failed)?;
    conn.execute("DELETE FROM settings_field_clocks", [])
        .map_err(failed)?;

    for (path, clock) in &field_clocks {
        conn.execute(
            "INSERT INTO settings_field_clocks (path, clock) VALUES (?1, ?2)
             ON CONFLICT(path) DO UPDATE SET clock = excluded.clock",
            params![path, payload::json_text(clock)],
        )
        .map_err(failed)?;
    }

    let groups = view
        .get("settings")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (group, contents) in &groups {
        let Some(keys) = contents.as_object() else {
            continue;
        };
        for (key, value) in keys {
            // The per-path clock this key merges under (§6.9). A path with no
            // clock yet is a key no device has ticked.
            let clock = field_clocks
                .get(&format!("{group}.{key}"))
                .map(payload::json_text);
            conn.execute(
                "INSERT INTO settings (\"group\", key, value, clock, synced_at, deleted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(\"group\", key) DO UPDATE SET
                     value = excluded.value,
                     clock = excluded.clock,
                     synced_at = excluded.synced_at,
                     deleted_at = excluded.deleted_at",
                params![
                    group,
                    key,
                    // JSON text, not the bare string: a boolean, a number and
                    // the string "true" have to stay distinguishable in one
                    // TEXT column.
                    payload::json_text(value),
                    clock,
                    item.synced_at,
                    item.deleted_at,
                ],
            )
            .map_err(failed)?;
        }
    }
    Ok(())
}
