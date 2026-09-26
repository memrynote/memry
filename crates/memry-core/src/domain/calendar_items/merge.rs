//! Applying a remote calendar record: desktop's four handlers, rule for rule
//! (spec 007 §5 F1).
//!
//! All four run §6.3.1's document gate first (a local clock that dominates
//! skips; concurrent clocks apply under the union clock). Then:
//!
//! - **source, binding, external event** (`packages/sync-client/src/item-handlers/
//!   calendar-*-handler.ts`): the remote is laid key by key over the local
//!   payload. Desktop reads almost every key as `data.x ?? existing.x`, so a
//!   remote **`null` keeps** the local value; only the external event's rich
//!   fields (`attendees`, `reminders`, `visibility`, `colorId`,
//!   `conferenceData`) are read by presence, where `null` clears.
//! - **event** (`apps/desktop/src/main/sync/item-handlers/calendar-event-handler.ts`):
//!   the wholesale branch is the same overlay with the event's own presence
//!   set; the concurrent branch field-merges the fourteen
//!   `CALENDAR_EVENT_SYNCABLE_FIELDS`, fills a remote field it omitted with the
//!   local value first (desktop's `remoteForMerge`), and merges the routing
//!   keys (`targetCalendarId`, `parentEventId`, `originalStartTime`) by
//!   presence and `archivedAt` by `??`. A side with no `fieldClocks` seeds them
//!   from its document clock.
//!
//! Keys this build does not model ride along (§13.2 rule 3): every overlay
//! starts from the local object. Nothing here enqueues (§6.5.2 P3).

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::domain::task_merge::{self, Gate};
use crate::domain::tasks::Inbound;
use crate::storage::repositories::StoredPayload;
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::sync::clock::VectorClock;
use crate::sync::field_merge::{init_all_field_clocks, merge_fields};

use super::{BINDING_TYPE, EVENT_TYPE, EXTERNAL_TYPE, SOURCE_TYPE};

/// `CALENDAR_EVENT_SYNCABLE_FIELDS` (`field-merge-calendar.ts:4`).
pub const EVENT_SYNCABLE_FIELDS: [&str; 14] = [
    "title",
    "description",
    "location",
    "startAt",
    "endAt",
    "timezone",
    "isAllDay",
    "recurrenceRule",
    "recurrenceExceptions",
    "attendees",
    "reminders",
    "visibility",
    "colorId",
    "conferenceData",
];

/// Schema keys a remote `null` does **not** clear (desktop's `??`).
const SOURCE_NULL_KEEPS: &[&str] = &[
    "provider",
    "kind",
    "accountId",
    "remoteId",
    "title",
    "timezone",
    "color",
    "isPrimary",
    "isSelected",
    "isMemryManaged",
    "syncCursor",
    "syncStatus",
    "lastSyncedAt",
    "metadata",
    "archivedAt",
    "modifiedAt",
];

const BINDING_NULL_KEEPS: &[&str] = &[
    "sourceType",
    "sourceId",
    "provider",
    "remoteCalendarId",
    "remoteEventId",
    "ownershipMode",
    "writebackMode",
    "remoteVersion",
    "lastLocalSnapshot",
    "archivedAt",
    "modifiedAt",
];

const EXTERNAL_NULL_KEEPS: &[&str] = &[
    "sourceId",
    "remoteEventId",
    "remoteEtag",
    "remoteUpdatedAt",
    "title",
    "description",
    "location",
    "startAt",
    "endAt",
    "timezone",
    "isAllDay",
    "status",
    "recurrenceRule",
    "rawPayload",
    "archivedAt",
    "modifiedAt",
];

/// The event's wholesale overlay: `??` for these, presence for `attendees`,
/// `reminders`, `visibility`, `colorId`, `targetCalendarId`,
/// `parentEventId`, `originalStartTime`, `conferenceData`.
const EVENT_NULL_KEEPS: &[&str] = &[
    "title",
    "description",
    "location",
    "startAt",
    "endAt",
    "timezone",
    "isAllDay",
    "recurrenceRule",
    "recurrenceExceptions",
    "archivedAt",
    "modifiedAt",
];

/// The routing and recurrence-identity keys the concurrent branch merges by
/// presence (desktop's `hasMergeKey`).
const EVENT_PRESENCE_KEYS: [&str; 3] = ["targetCalendarId", "parentEventId", "originalStartTime"];

/// §6.8's calendar rows.
pub(crate) fn apply_remote(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    let null_keeps = match record.item_type.as_str() {
        SOURCE_TYPE => SOURCE_NULL_KEEPS,
        BINDING_TYPE => BINDING_NULL_KEEPS,
        EXTERNAL_TYPE => EXTERNAL_NULL_KEEPS,
        EVENT_TYPE => EVENT_NULL_KEEPS,
        other => {
            return Err(StorageError::Failed {
                what: format!("`{other}` is not a calendar type"),
            });
        }
    };
    let is_event = record.item_type == EVENT_TYPE;
    match task_merge::document_gate(conn, record)? {
        Gate::Skip => Ok(Inbound::Skipped),
        Gate::Wholesale => {
            let Some(local) = live_local(conn, record)? else {
                // Desktop's insert: `insertedFC = remoteFieldClocks ??
                // initAllFieldClocks(remoteClock)`.
                if is_event
                    && record.deleted_at.is_none()
                    && let Ok(remote) = StoredPayload::parse(&record.payload_json)
                    && remote
                        .object()
                        .get("fieldClocks")
                        .is_none_or(Value::is_null)
                {
                    let mut seeded = remote.object().clone();
                    let clocks = field_clocks_or_seed(remote.object(), "remote")?;
                    seeded.insert("fieldClocks".to_owned(), to_json(&clocks)?);
                    return store(conn, record, seeded, now_ms);
                }
                return task_merge::wholesale(conn, record, now_ms);
            };
            let Ok(remote) = StoredPayload::parse(&record.payload_json) else {
                return task_merge::wholesale(conn, record, now_ms);
            };
            let mut merged = overlay(local.object(), remote.object(), null_keeps);
            if is_event {
                // `appliedFC = remoteFieldClocks ?? initAllFieldClocks(remoteClock)`.
                let clocks = field_clocks_or_seed(remote.object(), "remote")?;
                merged.insert("fieldClocks".to_owned(), to_json(&clocks)?);
            }
            store(conn, record, merged, now_ms)
        }
        Gate::Merge {
            local,
            remote,
            merged_clock,
        } => {
            let mut merged = if is_event {
                merge_event(local.object(), remote.object())?
            } else {
                overlay(local.object(), remote.object(), null_keeps)
            };
            merged.insert("clock".to_owned(), to_json(&merged_clock)?);
            store(conn, record, merged, now_ms)
        }
    }
}

/// The local payload with every remote key laid over it. A remote `null` in a
/// `null_keeps` key keeps the local value (desktop's `data.x ?? existing.x`).
pub fn overlay(
    local: &Map<String, Value>,
    remote: &Map<String, Value>,
    null_keeps: &[&str],
) -> Map<String, Value> {
    let mut merged = local.clone();
    for (key, value) in remote {
        if value.is_null() && null_keeps.contains(&key.as_str()) && merged.contains_key(key) {
            continue;
        }
        merged.insert(key.clone(), value.clone());
    }
    merged
}

/// The concurrent branch of `calendar-event-handler.ts`.
pub fn merge_event(
    local: &Map<String, Value>,
    remote: &Map<String, Value>,
) -> Result<Map<String, Value>, StorageError> {
    let local_fc = field_clocks_or_seed(local, "local")?;
    let remote_fc = field_clocks_or_seed(remote, "remote")?;

    // `remoteForMerge`: an omitted remote field reads as the local value.
    let mut remote_for_merge = Map::new();
    for field in EVENT_SYNCABLE_FIELDS {
        let value = remote.get(field).or_else(|| local.get(field));
        if let Some(value) = value {
            remote_for_merge.insert(field.to_owned(), value.clone());
        }
    }
    let result = merge_fields(
        local,
        &remote_for_merge,
        &local_fc,
        &remote_fc,
        &EVENT_SYNCABLE_FIELDS,
    );

    // Unknown remote keys ride along; schema keys are decided below.
    let mut merged = local.clone();
    for (key, value) in remote {
        if !is_event_schema_key(key) {
            merged.insert(key.clone(), value.clone());
        }
    }
    for (field, value) in result.merged {
        merged.insert(field, value);
    }
    for key in EVENT_PRESENCE_KEYS {
        if let Some(value) = remote.get(key) {
            merged.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(archived) = remote.get("archivedAt").filter(|v| !v.is_null()) {
        merged.insert("archivedAt".to_owned(), archived.clone());
    }
    if let Some(modified) = remote.get("modifiedAt").filter(|v| !v.is_null()) {
        merged.insert("modifiedAt".to_owned(), modified.clone());
    }
    merged.insert(
        "fieldClocks".to_owned(),
        to_json(&result.merged_field_clocks)?,
    );
    Ok(merged)
}

fn is_event_schema_key(key: &str) -> bool {
    EVENT_SYNCABLE_FIELDS.contains(&key)
        || EVENT_PRESENCE_KEYS.contains(&key)
        || matches!(
            key,
            "archivedAt" | "clock" | "fieldClocks" | "createdAt" | "modifiedAt"
        )
}

/// A payload's `fieldClocks`, or all fourteen seeded from its `clock`
/// (`initAllFieldClocks`).
pub fn field_clocks_or_seed(
    payload: &Map<String, Value>,
    whose: &str,
) -> Result<BTreeMap<String, VectorClock>, StorageError> {
    match payload.get("fieldClocks") {
        Some(value) if !value.is_null() => {
            serde_json::from_value(value.clone()).map_err(|error| StorageError::Failed {
                what: format!("{whose} fieldClocks is not a map of vector clocks: {error}"),
            })
        }
        _ => {
            let clock: VectorClock = match payload.get("clock") {
                Some(value) if !value.is_null() => task_merge::as_clock(value)?,
                _ => VectorClock::new(),
            };
            Ok(init_all_field_clocks(&clock, &EVENT_SYNCABLE_FIELDS))
        }
    }
}

fn store(
    conn: &Connection,
    record: &InboundRecord,
    merged: Map<String, Value>,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    let payload_json =
        serde_json::to_string(&Value::Object(merged)).map_err(|error| StorageError::Failed {
            what: format!("merged calendar payload will not serialise: {error}"),
        })?;
    let merged = InboundRecord {
        payload_json,
        ..record.clone()
    };
    task_merge::wholesale(conn, &merged, now_ms)
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<Value, StorageError> {
    serde_json::to_value(value).map_err(|error| StorageError::Failed {
        what: format!("clock will not serialise: {error}"),
    })
}

/// The stored payload of a live local row, if any.
fn live_local(
    conn: &Connection,
    record: &InboundRecord,
) -> Result<Option<StoredPayload>, StorageError> {
    let Some(row) = sync_items::load(conn, &record.item_type, &record.item_id)? else {
        return Ok(None);
    };
    if row.deleted_at.is_some() {
        return Ok(None);
    }
    Ok(row.payload.and_then(|raw| StoredPayload::parse(&raw).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => Map::new(),
        }
    }

    #[test]
    fn a_null_keeps_the_local_value_on_sources() {
        let out = overlay(
            &obj(json!({"title": "Work", "color": "#fff", "archivedAt": "x", "extra": 1})),
            &obj(json!({"title": null, "color": "#000", "archivedAt": null})),
            SOURCE_NULL_KEEPS,
        );
        assert_eq!(out["title"], "Work");
        assert_eq!(out["color"], "#000");
        assert_eq!(out["archivedAt"], "x");
        assert_eq!(out["extra"], 1);
    }

    #[test]
    fn external_rich_fields_clear_on_null() {
        let out = overlay(
            &obj(json!({"attendees": [{"email": "a"}], "location": "Here"})),
            &obj(json!({"attendees": null, "location": null})),
            EXTERNAL_NULL_KEEPS,
        );
        assert_eq!(out["attendees"], Value::Null);
        assert_eq!(out["location"], "Here");
    }

    #[test]
    fn the_concurrent_event_merge_keeps_each_sides_newer_field() {
        let local = obj(json!({
            "title": "Local title", "location": "Old", "targetCalendarId": "cal-a",
            "clock": {"a": 2, "b": 1},
            "fieldClocks": {"title": {"a": 2}, "location": {"a": 1}}
        }));
        let remote = obj(json!({
            "title": "Remote title", "location": "New",
            "clock": {"a": 1, "b": 2},
            "fieldClocks": {"title": {"a": 1}, "location": {"a": 1, "b": 1}}
        }));
        let out = merge_event(&local, &remote).expect("merge");
        assert_eq!(out["title"], "Local title");
        assert_eq!(out["location"], "New");
        // Absent in the remote: the local routing key stands.
        assert_eq!(out["targetCalendarId"], "cal-a");
        assert_eq!(out["fieldClocks"]["location"], json!({"a": 1, "b": 1}));
    }

    #[test]
    fn a_side_without_field_clocks_seeds_them_from_its_clock() {
        let clocks = field_clocks_or_seed(&obj(json!({"clock": {"d": 3}})), "t").expect("seed");
        assert_eq!(clocks.len(), 14);
        assert_eq!(clocks["title"].get("d"), Some(&3));
    }
}
