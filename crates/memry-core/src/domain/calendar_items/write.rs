//! Calendar record writes (spec 007 CL013), each the record shape desktop's
//! handler emits (§5 F3):
//!
//! - create: `CREATE_EVENT` (`ipc/calendar-handlers.ts:176`) + the create
//!   enqueue of `calendar-event-sync.ts` — the whole row, clock `{dev: 1}`,
//!   every field clock ticked;
//! - update / move: `UPDATE_EVENT` — only the keys given, the colour only
//!   when it changes, the changed fields' clocks ticked (never
//!   `targetCalendarId`'s, which has none);
//! - delete: the row's tombstone with a ticked clock;
//! - promote: `promote-external-event.ts`, event + binding + archived mirror;
//! - source selection: `UPDATE_SOURCE_SELECTION` + the provider's
//!   `onSelectionChanged` purge of an unselected source's mirror.
//!
//! One transaction per write with one outbox row per record it touches.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::api::errors::StorageError;
use crate::domain::notes::{
    failed, insert_local, iso, next_clock, require_payload, tombstone_local,
};
use crate::storage::repositories::{Change, sync_items};
use crate::sync::clock::{self, VectorClock};
use crate::sync::outbox;

use super::colors::{color_id_for_event_color, event_color_from_id};
use super::merge::{EVENT_SYNCABLE_FIELDS, field_clocks_or_seed};
use super::projection::provider_supports_write;
use super::{BINDING_TYPE, EVENT_TYPE, EXTERNAL_TYPE};

/// `CreateCalendarEventSchema`.
#[derive(Debug, Clone, Default)]
pub struct NewEvent {
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start_at: String,
    pub end_at: Option<String>,
    pub timezone: String,
    pub is_all_day: bool,
    pub target_calendar_id: Option<String>,
    /// An event colour name (`CalendarEventColor`), or none.
    pub color: Option<String>,
}

/// `UpdateCalendarEventSchema`: `None` = key absent; `Some(None)` = clear.
#[derive(Debug, Clone, Default)]
pub struct EventPatch {
    pub title: Option<String>,
    pub description: Option<Option<String>>,
    pub location: Option<Option<String>>,
    pub start_at: Option<String>,
    pub end_at: Option<Option<String>>,
    pub timezone: Option<String>,
    pub is_all_day: Option<bool>,
    pub target_calendar_id: Option<Option<String>>,
    pub color: Option<Option<String>>,
}

/// `nanoid()` (desktop's `generateId`).
pub fn mint_id() -> String {
    crate::domain::inbox::write::mint_id()
}

fn valid_color(color: Option<&str>) -> Result<Option<&'static str>, StorageError> {
    match color {
        None => Ok(None),
        Some(name) => color_id_for_event_color(Some(name))
            .map(Some)
            .ok_or_else(|| StorageError::Invalid {
                what: format!("`{name}` is not an event colour"),
            }),
    }
}

fn valid_range(start: &str, end: Option<&str>) -> Result<(), StorageError> {
    let invalid = |what: &str| StorageError::Invalid {
        what: what.to_owned(),
    };
    let start_ms = crate::storage::repositories::instants::to_epoch_ms(start)
        .ok_or_else(|| invalid("an event needs a start time"))?;
    if let Some(end) = end {
        let end_ms = crate::storage::repositories::instants::to_epoch_ms(end)
            .ok_or_else(|| invalid("that end time is not a time"))?;
        if end_ms < start_ms {
            return Err(invalid("an event cannot end before it starts"));
        }
    }
    Ok(())
}

fn field_clocks_value(
    clocks: &std::collections::BTreeMap<String, VectorClock>,
) -> Result<Value, StorageError> {
    serde_json::to_value(clocks).map_err(|error| StorageError::Failed {
        what: format!("field clocks will not serialise: {error}"),
    })
}

/// Creates a memrynote event. Returns its id.
pub fn create_event(
    conn: &Connection,
    input: &NewEvent,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    if input.title.trim().is_empty() {
        return Err(StorageError::Invalid {
            what: "an event needs a title".to_owned(),
        });
    }
    valid_range(&input.start_at, input.end_at.as_deref())?;
    let color_id = valid_color(input.color.as_deref())?;
    let id = mint_id();
    let durable = outbox::commit(
        conn,
        &outbox::Change::upsert(EVENT_TYPE, &id),
        now_ms,
        |tx| {
            let at = iso(now_ms)?;
            let clock = next_clock(&Map::new(), device_id)?;
            let doc_clock: VectorClock = crate::domain::task_merge::as_clock(&clock)?;
            let field_clocks: std::collections::BTreeMap<String, VectorClock> =
                EVENT_SYNCABLE_FIELDS
                    .iter()
                    .map(|field| ((*field).to_owned(), doc_clock.clone()))
                    .collect();
            let payload = crate::domain::notes::object(json!({
                "id": id,
                "title": input.title,
                "description": input.description,
                "location": input.location,
                "startAt": input.start_at,
                "endAt": input.end_at,
                "timezone": input.timezone,
                "isAllDay": input.is_all_day,
                "recurrenceRule": null,
                "recurrenceExceptions": null,
                "attendees": null,
                "reminders": null,
                "visibility": null,
                "colorId": color_id,
                "conferenceData": null,
                "parentEventId": null,
                "originalStartTime": null,
                "targetCalendarId": input.target_calendar_id,
                "archivedAt": null,
                "clock": clock,
                "fieldClocks": field_clocks_value(&field_clocks)?,
                "syncedAt": null,
                "createdAt": at,
                "modifiedAt": at,
            }));
            insert_local(tx, EVENT_TYPE, &id, payload, now_ms)?;
            Ok(())
        },
    )?;
    durable.acknowledge();
    Ok(id)
}

/// Applies a patch. Returns the fields whose clocks ticked.
pub fn update_event(
    conn: &Connection,
    id: &str,
    patch: &EventPatch,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let durable = outbox::commit(
        conn,
        &outbox::Change::upsert(EVENT_TYPE, id),
        now_ms,
        |tx| {
            let stored = require_live(tx, EVENT_TYPE, id)?;
            let object = stored.object();
            let mut changes: Vec<(&'static str, Change)> = Vec::new();
            let mut changed: Vec<&'static str> = Vec::new();
            let set =
                |value: Option<&str>| value.map_or(Value::Null, |v| Value::String(v.to_owned()));
            if let Some(title) = &patch.title {
                if title.trim().is_empty() {
                    return Err(StorageError::Invalid {
                        what: "an event needs a title".to_owned(),
                    });
                }
                changes.push(("title", Change::Set(json!(title))));
                changed.push("title");
            }
            if let Some(description) = &patch.description {
                changes.push(("description", Change::Set(set(description.as_deref()))));
                changed.push("description");
            }
            if let Some(location) = &patch.location {
                changes.push(("location", Change::Set(set(location.as_deref()))));
                changed.push("location");
            }
            if let Some(start) = &patch.start_at {
                changes.push(("startAt", Change::Set(json!(start))));
                changed.push("startAt");
            }
            if let Some(end) = &patch.end_at {
                changes.push(("endAt", Change::Set(set(end.as_deref()))));
                changed.push("endAt");
            }
            if let Some(timezone) = &patch.timezone {
                changes.push(("timezone", Change::Set(json!(timezone))));
                changed.push("timezone");
            }
            if let Some(all_day) = patch.is_all_day {
                changes.push(("isAllDay", Change::Set(json!(all_day))));
                changed.push("isAllDay");
            }
            if let Some(target) = &patch.target_calendar_id {
                changes.push(("targetCalendarId", Change::Set(set(target.as_deref()))));
            }
            if let Some(color) = &patch.color {
                let current = event_color_from_id(object.get("colorId").and_then(Value::as_str));
                if current != color.as_deref() {
                    let color_id = valid_color(color.as_deref())?;
                    changes.push(("colorId", Change::Set(set(color_id))));
                    changed.push("colorId");
                }
            }
            let start = changes
                .iter()
                .find(|(k, _)| *k == "startAt")
                .and_then(|(_, c)| {
                    if let Change::Set(v) = c {
                        v.as_str().map(str::to_owned)
                    } else {
                        None
                    }
                })
                .or_else(|| {
                    object
                        .get("startAt")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_default();
            let end = match changes.iter().find(|(k, _)| *k == "endAt") {
                Some((_, Change::Set(v))) => v.as_str().map(str::to_owned),
                _ => object
                    .get("endAt")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            };
            valid_range(&start, end.as_deref())?;

            let mut clocks = field_clocks_or_seed(object, "stored")?;
            for field in &changed {
                let current = clocks.get(*field).cloned().unwrap_or_default();
                clocks.insert((*field).to_owned(), clock::increment(&current, device_id));
            }
            changes.push(("clock", Change::Set(next_clock(object, device_id)?)));
            changes.push(("fieldClocks", Change::Set(field_clocks_value(&clocks)?)));
            changes.push(("modifiedAt", Change::Set(json!(iso(now_ms)?))));
            sync_items::apply_local_edit_in(tx, EVENT_TYPE, id, &changes, now_ms)?;
            Ok(changed.iter().map(|f| (*f).to_owned()).collect::<Vec<_>>())
        },
    )?;
    Ok(durable.acknowledge())
}

/// `DELETE_EVENT`.
pub fn delete_event(
    conn: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let durable = outbox::commit(
        conn,
        &outbox::Change::delete(EVENT_TYPE, id),
        now_ms,
        |tx| {
            require_live(tx, EVENT_TYPE, id)?;
            tombstone_local(tx, EVENT_TYPE, id, device_id, now_ms)
        },
    )?;
    durable.acknowledge();
    Ok(())
}

/// Why a promote could not run (desktop's three error classes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromoteRefusal {
    NotFound,
    SourceMissing,
    ReadOnly,
}

/// `promoteExternalEvent`. Returns the memrynote event id.
pub fn promote(
    conn: &Connection,
    external_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Result<String, PromoteRefusal>, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let Some(mirror) = live_payload(&tx, EXTERNAL_TYPE, external_id)? else {
        return Ok(Err(PromoteRefusal::NotFound));
    };
    let source_id = mirror
        .get("sourceId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let source: Option<(String, String)> = tx
        .query_row(
            "SELECT provider, remote_id FROM calendar_sources WHERE id = ?1 AND deleted_at IS NULL",
            [&source_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(failed)?;
    let Some((provider, remote_calendar_id)) = source else {
        return Ok(Err(PromoteRefusal::SourceMissing));
    };
    if !provider_supports_write(&provider) {
        return Ok(Err(PromoteRefusal::ReadOnly));
    }
    let at = iso(now_ms)?;
    let remote_event_id = mirror
        .get("remoteEventId")
        .and_then(Value::as_str)
        .map_or_else(|| external_id.to_owned(), str::to_owned);

    let existing: Option<String> = tx
        .query_row(
            "SELECT source_id FROM calendar_bindings
              WHERE deleted_at IS NULL AND provider = ?1 AND remote_calendar_id = ?2
                AND remote_event_id = ?3
              ORDER BY created_at_raw, id LIMIT 1",
            params![provider, remote_calendar_id, remote_event_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    if let Some(event_id) = existing {
        if mirror.get("archivedAt").is_none_or(Value::is_null) {
            archive_mirror(&tx, external_id, &at, device_id, now_ms)?;
        }
        tx.commit().map_err(failed)?;
        return Ok(Ok(event_id));
    }

    let event_id = mint_id();
    let binding_id = mint_id();
    let mirror_clock = mirror
        .get("clock")
        .cloned()
        .filter(|c| !c.is_null())
        .unwrap_or_else(|| json!({}));
    let copy = |key: &str| mirror.get(key).cloned().unwrap_or(Value::Null);
    let event = crate::domain::notes::object(json!({
        "id": event_id,
        "title": copy("title"),
        "description": copy("description"),
        "location": copy("location"),
        "startAt": copy("startAt"),
        "endAt": copy("endAt"),
        "timezone": mirror.get("timezone").cloned().filter(|v| !v.is_null()).unwrap_or_else(|| json!("UTC")),
        "isAllDay": mirror.get("isAllDay").cloned().unwrap_or(json!(false)),
        "recurrenceRule": copy("recurrenceRule"),
        "recurrenceExceptions": null,
        "attendees": copy("attendees"),
        "reminders": copy("reminders"),
        "visibility": copy("visibility"),
        "colorId": copy("colorId"),
        "conferenceData": copy("conferenceData"),
        "parentEventId": null,
        "originalStartTime": null,
        "targetCalendarId": remote_calendar_id,
        "archivedAt": null,
        "clock": mirror_clock,
        "fieldClocks": null,
        "syncedAt": null,
        "createdAt": at,
        "modifiedAt": at,
    }));
    insert_local(&tx, EVENT_TYPE, &event_id, event, now_ms)?;
    // The create enqueue ticks the clock and every field clock
    // (`calendar-event-sync.ts` `operation === 'create'`).
    tick_create(&tx, EVENT_TYPE, &event_id, device_id, now_ms, true)?;
    outbox::enqueue(&tx, &outbox::Change::upsert(EVENT_TYPE, &event_id), now_ms)?;

    let binding = crate::domain::notes::object(json!({
        "id": binding_id,
        "sourceType": "event",
        "sourceId": event_id,
        "provider": provider,
        "remoteCalendarId": remote_calendar_id,
        "remoteEventId": remote_event_id,
        "ownershipMode": "provider_managed",
        "writebackMode": "time_and_text",
        "remoteVersion": copy("remoteEtag"),
        "lastLocalSnapshot": null,
        "archivedAt": null,
        "clock": mirror.get("clock").cloned().filter(|c| !c.is_null()).unwrap_or_else(|| json!({})),
        "syncedAt": null,
        "createdAt": at,
        "modifiedAt": at,
    }));
    insert_local(&tx, BINDING_TYPE, &binding_id, binding, now_ms)?;
    tick_create(&tx, BINDING_TYPE, &binding_id, device_id, now_ms, false)?;
    outbox::enqueue(
        &tx,
        &outbox::Change::upsert(BINDING_TYPE, &binding_id),
        now_ms,
    )?;

    archive_mirror(&tx, external_id, &at, device_id, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(Ok(event_id))
}

/// The enqueue's clock step: tick the document clock (and, for an event
/// create, every field clock seeded from the pre-tick clock).
fn tick_create(
    tx: &Connection,
    item_type: &str,
    id: &str,
    device_id: &str,
    now_ms: i64,
    field_clocks: bool,
) -> Result<(), StorageError> {
    let stored = require_payload(tx, item_type, id)?;
    let object = stored.object();
    let mut changes = vec![("clock", Change::Set(next_clock(object, device_id)?))];
    if field_clocks {
        let mut clocks = field_clocks_or_seed(object, "stored")?;
        for field in EVENT_SYNCABLE_FIELDS {
            let current = clocks.get(field).cloned().unwrap_or_default();
            clocks.insert(field.to_owned(), clock::increment(&current, device_id));
        }
        changes.push(("fieldClocks", Change::Set(field_clocks_value(&clocks)?)));
    }
    sync_items::apply_local_edit_in(tx, item_type, id, &changes, now_ms)?;
    Ok(())
}

fn archive_mirror(
    tx: &Connection,
    external_id: &str,
    at: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let stored = require_payload(tx, EXTERNAL_TYPE, external_id)?;
    let changes = vec![
        ("archivedAt", Change::Set(json!(at))),
        ("modifiedAt", Change::Set(json!(at))),
        (
            "clock",
            Change::Set(next_clock(stored.object(), device_id)?),
        ),
    ];
    sync_items::apply_local_edit_in(tx, EXTERNAL_TYPE, external_id, &changes, now_ms)?;
    outbox::enqueue(
        tx,
        &outbox::Change::upsert(EXTERNAL_TYPE, external_id),
        now_ms,
    )?;
    Ok(())
}

/// The stored payload of a live row, or `None`.
pub fn live_payload(
    conn: &Connection,
    item_type: &str,
    id: &str,
) -> Result<Option<Map<String, Value>>, StorageError> {
    let Some(row) = sync_items::load(conn, item_type, id)? else {
        return Ok(None);
    };
    if row.deleted_at.is_some() {
        return Ok(None);
    }
    Ok(row
        .payload
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        }))
}

fn require_live(
    conn: &Connection,
    item_type: &str,
    id: &str,
) -> Result<crate::storage::repositories::StoredPayload, StorageError> {
    let row = sync_items::load(conn, item_type, id)?;
    if row.as_ref().is_none_or(|r| r.deleted_at.is_some()) {
        return Err(StorageError::NotFound {
            what: format!("no calendar event {id}"),
        });
    }
    require_payload(conn, item_type, id)
}
