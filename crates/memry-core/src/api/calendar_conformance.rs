//! The conformance seam for the `calendar` class (spec 007 CL011-CL013).
//!
//! `calendar.json` pins desktop's four apply rules, its range projection and
//! search over fixed rows in a fixed zone, and the record shapes its writes
//! emit. Like [`crate::api::inbox_conformance`], this takes the vector's own
//! JSON and runs it through the **same** production paths — `apply_inbound`
//! into a throwaway in-memory database, [`projection::range`], the write
//! functions `Calendar` calls — and answers JSON in the file's shape.

use rusqlite::Connection;
use serde_json::{Map, Value, json};

use crate::api::calendar_records::{CalendarZone, CalendarZoneTransition};
use crate::api::errors::StorageError;
use crate::domain::calendar_items::projection::{self, ProjectionItem, RangeInput};
use crate::domain::calendar_items::write::{self, EventPatch, NewEvent};
use crate::storage::Db;
use crate::storage::migrations;
use crate::storage::repositories::sync_items::InboundRecord;
use crate::storage::repositories::{instants, sync_items};
use crate::sync::apply::apply_inbound;

fn fresh() -> Result<Db, StorageError> {
    let db = Db::open_in_memory()?;
    db.call_blocking(|conn| migrations::run(conn, migrations::DATA_MIGRATIONS))?;
    Ok(db)
}

fn record(item_type: &str, id: &str, payload: &Value, deleted_at: Option<i64>) -> InboundRecord {
    InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: None,
        signer_device_id: None,
        updated_at: 0,
        deleted_at,
    }
}

/// `(key, column, kind)`: `t` text, `b` bool, `j` JSON text.
fn columns(item_type: &str) -> (&'static str, &'static [(&'static str, &'static str, char)]) {
    match item_type {
        "calendar_source" => (
            "calendar_sources",
            &[
                ("provider", "provider", 't'),
                ("kind", "kind", 't'),
                ("accountId", "account_id", 't'),
                ("remoteId", "remote_id", 't'),
                ("title", "title", 't'),
                ("timezone", "timezone", 't'),
                ("color", "color", 't'),
                ("isPrimary", "is_primary", 'b'),
                ("isSelected", "is_selected", 'b'),
                ("isMemryManaged", "is_memry_managed", 'b'),
                ("syncCursor", "sync_cursor", 't'),
                ("syncStatus", "sync_status", 't'),
                ("lastSyncedAt", "last_synced_at", 't'),
                ("metadata", "metadata", 'j'),
                ("archivedAt", "archived_at", 't'),
                ("clock", "clock", 'j'),
            ],
        ),
        "calendar_binding" => (
            "calendar_bindings",
            &[
                ("sourceType", "source_type", 't'),
                ("sourceId", "source_id", 't'),
                ("provider", "provider", 't'),
                ("remoteCalendarId", "remote_calendar_id", 't'),
                ("remoteEventId", "remote_event_id", 't'),
                ("ownershipMode", "ownership_mode", 't'),
                ("writebackMode", "writeback_mode", 't'),
                ("remoteVersion", "remote_version", 't'),
                ("lastLocalSnapshot", "last_local_snapshot", 'j'),
                ("archivedAt", "archived_at", 't'),
                ("clock", "clock", 'j'),
            ],
        ),
        "calendar_external_event" => (
            "calendar_external_events",
            &[
                ("sourceId", "source_id", 't'),
                ("remoteEventId", "remote_event_id", 't'),
                ("remoteEtag", "remote_etag", 't'),
                ("remoteUpdatedAt", "remote_updated_at", 't'),
                ("title", "title", 't'),
                ("description", "description", 't'),
                ("location", "location", 't'),
                ("startAt", "start_at", 't'),
                ("endAt", "end_at", 't'),
                ("timezone", "timezone", 't'),
                ("isAllDay", "is_all_day", 'b'),
                ("status", "status", 't'),
                ("recurrenceRule", "recurrence_rule", 'j'),
                ("attendees", "attendees", 'j'),
                ("reminders", "reminders", 'j'),
                ("visibility", "visibility", 't'),
                ("colorId", "color_id", 't'),
                ("conferenceData", "conference_data", 'j'),
                ("rawPayload", "raw_payload", 'j'),
                ("archivedAt", "archived_at", 't'),
                ("clock", "clock", 'j'),
            ],
        ),
        _ => (
            "calendar_events",
            &[
                ("title", "title", 't'),
                ("description", "description", 't'),
                ("location", "location", 't'),
                ("startAt", "start_at", 't'),
                ("endAt", "end_at", 't'),
                ("timezone", "timezone", 't'),
                ("isAllDay", "is_all_day", 'b'),
                ("recurrenceRule", "recurrence_rule", 'j'),
                ("recurrenceExceptions", "recurrence_exceptions", 'j'),
                ("attendees", "attendees", 'j'),
                ("reminders", "reminders", 'j'),
                ("visibility", "visibility", 't'),
                ("colorId", "color_id", 't'),
                ("conferenceData", "conference_data", 'j'),
                ("archivedAt", "archived_at", 't'),
                ("targetCalendarId", "target_calendar_id", 't'),
                ("parentEventId", "parent_event_id", 't'),
                ("originalStartTime", "original_start_time", 't'),
                ("clock", "clock", 'j'),
                ("fieldClocks", "field_clocks", 'j'),
            ],
        ),
    }
}

/// The projected row in desktop's camelCase row shape, or `null` when gone.
fn projected_row(conn: &Connection, item_type: &str, id: &str) -> Result<Value, StorageError> {
    let (table, cols) = columns(item_type);
    let select = cols
        .iter()
        .map(|(_, c, _)| *c)
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT {select} FROM {table} WHERE id = ?1 AND deleted_at IS NULL");
    let mut stmt = conn.prepare(&sql).map_err(crate::domain::notes::failed)?;
    let mut rows = stmt.query([id]).map_err(crate::domain::notes::failed)?;
    let Some(row) = rows.next().map_err(crate::domain::notes::failed)? else {
        return Ok(Value::Null);
    };
    let mut out = Map::new();
    for (index, (key, _, kind)) in cols.iter().enumerate() {
        let value = match kind {
            'b' => json!(
                row.get::<_, i64>(index)
                    .map_err(crate::domain::notes::failed)?
                    != 0
            ),
            'j' => row
                .get::<_, Option<String>>(index)
                .map_err(crate::domain::notes::failed)?
                .and_then(|text| serde_json::from_str(&text).ok())
                .unwrap_or(Value::Null),
            _ => row
                .get::<_, Option<String>>(index)
                .map_err(crate::domain::notes::failed)?
                .map_or(Value::Null, Value::String),
        };
        out.insert((*key).to_owned(), value);
    }
    Ok(Value::Object(out))
}

fn apply_case(case: &Value) -> Result<Value, StorageError> {
    let db = fresh()?;
    let id = case["id"].as_str().unwrap_or_default().to_owned();
    let item_type = case["type"].as_str().unwrap_or_default().to_owned();
    let steps = case["steps"].as_array().cloned().unwrap_or_default();
    db.call_blocking(move |conn| {
        for (index, step) in steps.iter().enumerate() {
            let at = (index as i64 + 1) * 1_000;
            let deleted = step["deleted"].as_bool() == Some(true);
            let step_type = step["type"].as_str().unwrap_or_default();
            apply_inbound(
                conn,
                &record(step_type, &id, &step["payload"], deleted.then_some(at)),
                at,
            )?;
        }
        projected_row(conn, &item_type, &id)
    })
}

pub(crate) fn zone(value: &Value) -> CalendarZone {
    CalendarZone {
        identifier: value["identifier"].as_str().unwrap_or("UTC").to_owned(),
        base_offset_ms: value["baseOffsetMs"].as_i64().unwrap_or(0),
        transitions: value["transitions"]
            .as_array()
            .map(|all| {
                all.iter()
                    .map(|t| CalendarZoneTransition {
                        at_ms: t["atMs"].as_i64().unwrap_or(0),
                        offset_ms: t["offsetMs"].as_i64().unwrap_or(0),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn input(query: &Value, timezone: &str) -> RangeInput {
    RangeInput {
        start_at: query["startAt"].as_str().unwrap_or_default().to_owned(),
        end_at: query["endAt"].as_str().unwrap_or_default().to_owned(),
        include_unselected_sources: query["includeUnselectedSources"].as_bool().unwrap_or(false),
        include_external: true,
        external_providers: None,
        enabled_property_names: query["enabledPropertyNames"]
            .as_array()
            .map(|names| {
                names
                    .iter()
                    .filter_map(|n| n.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        show_notes_by_created: query["showNotesByCreated"].as_bool().unwrap_or(false),
        local_timezone: timezone.to_owned(),
    }
}

/// A projection item in desktop's `CalendarProjectionItem` JSON shape.
pub fn item_json(item: &ProjectionItem) -> Value {
    let mut out = json!({
        "projectionId": item.projection_id,
        "sourceType": item.source_type,
        "sourceId": item.source_id,
        "title": item.title,
        "descriptionPreview": item.description_preview,
        "startAt": item.start_at,
        "endAt": item.end_at,
        "isAllDay": item.is_all_day,
        "timezone": item.timezone,
        "visualType": item.visual_type,
        "editability": {
            "canMove": item.editability.can_move,
            "canResize": item.editability.can_resize,
            "canEditText": item.editability.can_edit_text,
            "canDelete": item.editability.can_delete,
        },
        "source": {
            "provider": item.source.provider,
            "calendarSourceId": item.source.calendar_source_id,
            "title": item.source.title,
            "color": item.source.color,
            "kind": item.source.kind,
            "isMemryManaged": item.source.is_memry_managed,
        },
        "binding": item.binding.as_ref().map(|b| json!({
            "provider": b.provider,
            "remoteCalendarId": b.remote_calendar_id,
            "remoteEventId": b.remote_event_id,
            "ownershipMode": b.ownership_mode,
            "writebackMode": b.writeback_mode,
        })),
        "snoozeOffsetMinutes": item.snooze_offset_minutes,
    });
    let object = out.as_object_mut().expect("json! object");
    if item.visual_type == "event" || item.visual_type == "external_event" {
        object.insert("color".to_owned(), json!(item.color));
        object.insert("displayColor".to_owned(), json!(item.display_color));
    }
    if item.visual_type == "note_date" {
        object.insert("noteId".to_owned(), json!(item.note_id));
        object.insert("anchorId".to_owned(), json!(item.anchor_id));
        object.insert("isTriggered".to_owned(), json!(item.is_triggered));
    }
    out
}

fn projection_section(section: &Value) -> Result<Value, StorageError> {
    let db = fresh()?;
    let rows = section["rows"].as_array().cloned().unwrap_or_default();
    let tz = section["timezone"].as_str().unwrap_or("UTC").to_owned();
    let zone = zone(&section["zone"]);
    let queries = section["queries"].as_array().cloned().unwrap_or_default();
    let searches = section["searches"].as_array().cloned().unwrap_or_default();
    db.call_blocking(move |conn| {
        for row in &rows {
            apply_inbound(
                conn,
                &record(
                    row["type"].as_str().unwrap_or_default(),
                    row["id"].as_str().unwrap_or_default(),
                    &row["payload"],
                    None,
                ),
                1_000,
            )?;
        }
        let mut query_out = Vec::new();
        for query in &queries {
            let items = projection::range(conn, &zone, &input(query, &tz))?;
            query_out.push(Value::Array(items.iter().map(item_json).collect()));
        }
        let mut search_out = Vec::new();
        for search in &searches {
            let hits = projection::search(
                conn,
                &zone,
                &input(&search["window"], &tz),
                search["query"].as_str().unwrap_or_default(),
                search["nowMs"].as_i64().unwrap_or(0),
                20,
            )?;
            search_out.push(Value::Array(
                hits.iter().map(|i| json!(i.projection_id)).collect(),
            ));
        }
        Ok(json!({ "queries": query_out, "searches": search_out }))
    })
}

fn stored(conn: &Connection, item_type: &str, id: &str) -> Result<Value, StorageError> {
    Ok(sync_items::push_payload(conn, item_type, id)?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null))
}

/// Replaces minted ids with the vector's placeholders.
fn normalise(mut value: Value, ids: &[(&str, &str)]) -> Value {
    if let Value::Object(map) = &mut value {
        for (_, v) in map.iter_mut() {
            if let Some(text) = v.as_str()
                && let Some((_, placeholder)) = ids.iter().find(|(id, _)| *id == text)
            {
                *v = json!(placeholder);
            }
        }
    }
    value
}

fn text_patch(input: &Value, key: &str) -> Option<Option<String>> {
    input
        .as_object()?
        .get(key)
        .map(|v| v.as_str().map(str::to_owned))
}

fn writes_section(section: &Value) -> Result<Value, StorageError> {
    let device = section["device"].as_str().unwrap_or_default().to_owned();
    let now = instants::to_epoch_ms(section["now"].as_str().unwrap_or_default()).unwrap_or(0);
    let section = section.clone();
    let db = fresh()?;
    db.call_blocking(move |conn| {
        let create = &section["create"]["input"];
        let draft = NewEvent {
            title: create["title"].as_str().unwrap_or_default().to_owned(),
            description: None,
            location: None,
            start_at: create["startAt"].as_str().unwrap_or_default().to_owned(),
            end_at: create["endAt"].as_str().map(str::to_owned),
            timezone: create["timezone"].as_str().unwrap_or_default().to_owned(),
            is_all_day: create["isAllDay"].as_bool().unwrap_or(false),
            target_calendar_id: create["targetCalendarId"].as_str().map(str::to_owned),
            color: create["color"].as_str().map(str::to_owned),
        };
        let created_id = write::create_event(conn, &draft, &device, now)?;
        let created = normalise(
            stored(conn, "calendar_event", &created_id)?,
            &[(&created_id, "$event")],
        );
        let created_raw = stored(conn, "calendar_event", &created_id)?;

        let mut updates = Vec::new();
        for update in section["updates"].as_array().cloned().unwrap_or_default() {
            // Each update starts from the created row, as the vector does.
            let scratch_id = format!("u{}", updates.len());
            let mut base = created_raw.clone();
            base["id"] = json!(scratch_id);
            apply_inbound(conn, &record("calendar_event", &scratch_id, &base, None), 1)?;
            let input = &update["input"];
            let patch = EventPatch {
                title: input
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                description: text_patch(input, "description"),
                location: text_patch(input, "location"),
                start_at: input
                    .get("startAt")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                end_at: text_patch(input, "endAt"),
                timezone: input
                    .get("timezone")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                is_all_day: input.get("isAllDay").and_then(Value::as_bool),
                target_calendar_id: text_patch(input, "targetCalendarId"),
                color: text_patch(input, "color"),
            };
            write::update_event(conn, &scratch_id, &patch, &device, now)?;
            updates.push(normalise(
                stored(conn, "calendar_event", &scratch_id)?,
                &[(&scratch_id, "$event")],
            ));
        }

        let promote = &section["promote"];
        apply_inbound(
            conn,
            &record("calendar_source", "src-work", &promote["source"], None),
            1,
        )?;
        apply_inbound(
            conn,
            &record("calendar_external_event", "ext-1", &promote["mirror"], None),
            1,
        )?;
        let promoted = match write::promote(conn, "ext-1", &device, now)? {
            Ok(id) => id,
            Err(refusal) => {
                return Err(StorageError::Invalid {
                    what: format!("{refusal:?}"),
                });
            }
        };
        let binding_id: String = conn
            .query_row(
                "SELECT id FROM calendar_bindings WHERE source_id = ?1",
                [&promoted],
                |row| row.get(0),
            )
            .map_err(crate::domain::notes::failed)?;
        let ids = [
            (promoted.as_str(), "$event"),
            (binding_id.as_str(), "$binding"),
        ];
        let repeat = write::promote(conn, "ext-1", &device, now)?;
        apply_inbound(
            conn,
            &record(
                "calendar_source",
                "src-feed",
                &promote["readOnlySource"],
                None,
            ),
            1,
        )?;
        let mut feed_mirror = promote["mirror"].clone();
        feed_mirror["sourceId"] = json!("src-feed");
        apply_inbound(
            conn,
            &record("calendar_external_event", "ext-feed", &feed_mirror, None),
            1,
        )?;
        let read_only = write::promote(conn, "ext-feed", &device, now)?;

        let selection = &section["selection"];
        apply_inbound(
            conn,
            &record("calendar_source", "src-sel", &selection["source"], None),
            1,
        )?;
        let mut sel_mirror = selection["mirror"].clone();
        sel_mirror["sourceId"] = json!("src-sel");
        apply_inbound(
            conn,
            &record("calendar_external_event", "ext-sel", &sel_mirror, None),
            1,
        )?;
        let mut sel_binding = selection["binding"].clone();
        sel_binding["remoteCalendarId"] = selection["source"]["remoteId"].clone();
        apply_inbound(
            conn,
            &record("calendar_binding", "bind-sel", &sel_binding, None),
            1,
        )?;
        crate::domain::calendar_items::selection::set_source_selection(
            conn, "src-sel", false, &device, now,
        )?
        .map_err(|r| StorageError::Invalid {
            what: format!("{r:?}"),
        })?;
        let gone = |item_type: &str, id: &str| -> Result<bool, StorageError> {
            Ok(sync_items::load(conn, item_type, id)?.is_none_or(|row| row.deleted_at.is_some()))
        };
        let mut sel_source = stored(conn, "calendar_source", "src-sel")?;
        sel_source["id"] = selection["source"]["id"].clone();

        Ok(json!({
            "create": created,
            "updates": updates,
            "promote": {
                "event": normalise(stored(conn, "calendar_event", &promoted)?, &ids),
                "binding": normalise(stored(conn, "calendar_binding", &binding_id)?, &ids),
                "mirror": stored(conn, "calendar_external_event", "ext-1")?,
                "repeatReturnsSameEvent": repeat == Ok(promoted.clone()),
                "readOnlyRefused": read_only.is_err(),
            },
            "selection": {
                "source": sel_source,
                "mirrorDeleted": gone("calendar_external_event", "ext-sel")?,
                "bindingDeleted": gone("calendar_binding", "bind-sel")?,
            }
        }))
    })
}

/// Runs every section of `calendar.json` and answers in its shape.
#[uniffi::export]
pub fn calendar_conformance(vector_json: String) -> String {
    let run = || -> Result<Value, StorageError> {
        let file: Value =
            serde_json::from_str(&vector_json).map_err(|e| StorageError::Invalid {
                what: e.to_string(),
            })?;
        let mut apply = Vec::new();
        for case in file["apply"].as_array().cloned().unwrap_or_default() {
            apply.push(match apply_case(&case) {
                Ok(actual) => json!({ "name": case["name"], "actual": actual }),
                Err(error) => json!({ "name": case["name"], "error": error.to_string() }),
            });
        }
        Ok(json!({
            "apply": apply,
            "projection": projection_section(&file["projection"])?,
            "writes": writes_section(&file["writes"])?,
        }))
    };
    match run() {
        Ok(value) => value.to_string(),
        Err(error) => json!({ "error": error.to_string() }).to_string(),
    }
}
