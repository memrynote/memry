//! Google Calendar on the phone (spec 007 CL071): the event body a push
//! sends (desktop `google/client.ts` `toGoogleEventPayload`), a pulled event
//! read the way `mapRemoteEvent` reads it, and a pull applied the way
//! `syncGoogleCalendarSource` applies it — mirror rows for imported events,
//! write-back into the Memry item for bound ones, the cursor on the source.

use std::collections::HashMap;

use rusqlite::Connection;
use serde_json::{Map, Value, json};

use super::bindings;
use super::{GOOGLE, Target, local_day};
use crate::api::calendar_records::CalendarZone;
use crate::api::errors::StorageError;
use crate::domain::calendar_items::write::{EventPatch, live_payload, update_event};
use crate::domain::calendar_items::zone::LocalZone;
use crate::domain::calendar_items::{EXTERNAL_TYPE, SOURCE_TYPE};
use crate::domain::notes::{failed, insert_local, iso, next_clock};
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox;

/// `toGoogleEventPayload`. All-day dates are the item's local days on this
/// device (§6 CL071).
pub fn event_body(input: &Value, zone: &dyn LocalZone) -> Value {
    let all_day = input["isAllDay"].as_bool().unwrap_or(false);
    let timezone = input["timezone"].clone();
    let start = input["startAt"].as_str().unwrap_or("");
    let end = input["endAt"].as_str().unwrap_or(start);
    let mut body = Map::new();
    body.insert("summary".into(), input["title"].clone());
    for (from, to) in [("description", "description"), ("location", "location")] {
        if let Some(text) = input[from].as_str() {
            body.insert(to.into(), json!(text));
        }
    }
    if all_day {
        let first = local_day(zone, start).unwrap_or_default();
        let last = local_day(zone, end)
            .filter(|d| *d > first)
            .unwrap_or_else(|| {
                crate::domain::calendar::CivilDate::parse_key(&first)
                    .map(|d| d.add_days(1).key())
                    .unwrap_or_default()
            });
        body.insert(
            "start".into(),
            json!({ "date": first, "timeZone": timezone }),
        );
        body.insert("end".into(), json!({ "date": last, "timeZone": timezone }));
    } else {
        body.insert(
            "start".into(),
            json!({ "dateTime": start, "timeZone": timezone }),
        );
        body.insert(
            "end".into(),
            json!({ "dateTime": end, "timeZone": timezone }),
        );
    }
    body.insert(
        "extendedProperties".into(),
        json!({ "private": { "memrySourceType": input["sourceType"], "memrySourceId": input["sourceId"] } }),
    );
    if let Some(lines) = input["recurrence"].as_array().filter(|l| !l.is_empty()) {
        body.insert("recurrence".into(), json!(lines));
    }
    if let Some(attendees) = input["attendees"].as_array().filter(|a| !a.is_empty()) {
        let list: Vec<Value> = attendees
            .iter()
            .map(|a| {
                let mut entry = Map::new();
                entry.insert("email".into(), a["email"].clone());
                for key in ["displayName", "responseStatus"] {
                    if a[key].as_str().is_some_and(|s| !s.is_empty()) {
                        entry.insert(key.into(), a[key].clone());
                    }
                }
                for key in ["optional", "organizer", "self"] {
                    if !a[key].is_null() {
                        entry.insert(key.into(), a[key].clone());
                    }
                }
                Value::Object(entry)
            })
            .collect();
        body.insert("attendees".into(), json!(list));
    }
    if let Some(reminders) = input["reminders"].as_object() {
        body.insert("reminders".into(), json!({ "useDefault": reminders.get("useDefault"), "overrides": reminders.get("overrides") }));
    }
    for key in ["visibility", "colorId"] {
        if input[key].as_str().is_some_and(|s| !s.is_empty()) {
            body.insert(key.into(), input[key].clone());
        }
    }
    Value::Object(body)
}

/// `mapRemoteEvent`.
pub fn remote_event(calendar_id: &str, raw: &Value) -> Value {
    let start = &raw["start"];
    let end = &raw["end"];
    let all_day = start["date"].is_string() && !start["dateTime"].is_string();
    let timezone = start["timeZone"]
        .as_str()
        .or(end["timeZone"].as_str())
        .unwrap_or("UTC");
    let start_at = start["dateTime"].as_str().map_or_else(
        || format!("{}T00:00:00.000Z", start["date"].as_str().unwrap_or("")),
        str::to_owned,
    );
    let end_at = end["dateTime"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| end["date"].as_str().map(|d| format!("{d}T00:00:00.000Z")));
    let attendees = raw["attendees"].as_array().map(|all| {
        all.iter()
            .map(|a| json!({
                "email": a["email"], "displayName": a.get("displayName").cloned().unwrap_or(Value::Null),
                "responseStatus": a.get("responseStatus").cloned().unwrap_or(Value::Null),
                "optional": a.get("optional").cloned().unwrap_or(Value::Null),
                "organizer": a.get("organizer").cloned().unwrap_or(Value::Null),
                "self": a.get("self").cloned().unwrap_or(Value::Null),
            }))
            .collect::<Vec<_>>()
    });
    let reminders = raw["reminders"].as_object().map(|r| {
        json!({ "useDefault": r.get("useDefault").and_then(Value::as_bool).unwrap_or(true), "overrides": r.get("overrides").cloned().unwrap_or_else(|| json!([])) })
    });
    let original = &raw["originalStartTime"];
    let original_start = original["dateTime"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            original["date"]
                .as_str()
                .map(|d| format!("{d}T00:00:00.000Z"))
        });
    json!({
        "id": raw["id"],
        "calendarId": calendar_id,
        "title": raw["summary"].as_str().unwrap_or("Untitled event"),
        "description": raw.get("description").cloned().unwrap_or(Value::Null),
        "location": raw.get("location").cloned().unwrap_or(Value::Null),
        "startAt": start_at,
        "endAt": end_at,
        "isAllDay": all_day,
        "timezone": timezone,
        "status": raw["status"].as_str().unwrap_or("confirmed"),
        "etag": raw.get("etag").cloned().unwrap_or(Value::Null),
        "updatedAt": raw.get("updated").cloned().unwrap_or(Value::Null),
        "attendees": attendees,
        "reminders": reminders,
        "visibility": raw.get("visibility").cloned().unwrap_or(Value::Null),
        "colorId": raw.get("colorId").cloned().unwrap_or(Value::Null),
        "conferenceData": raw.get("conferenceData").cloned().unwrap_or(Value::Null),
        "recurringEventId": raw.get("recurringEventId").cloned().unwrap_or(Value::Null),
        "originalStartTime": original_start,
        "raw": raw,
    })
}

/// `mapGoogleEventToExternalEventRecord` + the clock rule of the pull
/// (existing rows keep and tick theirs, new rows get a first one).
fn upsert_mirror(
    tx: &Connection,
    source_id: &str,
    event: &Value,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let remote_id = event["id"].as_str().unwrap_or("");
    let id = format!("calendar_external_event:{source_id}:{remote_id}");
    let at = iso(now_ms)?;
    let cancelled = event["status"].as_str() == Some("cancelled");
    let existing = live_payload(tx, EXTERNAL_TYPE, &id)?;
    if cancelled && existing.is_none() {
        return Ok(());
    }
    let fields = json!({
        "sourceId": source_id,
        "remoteEventId": remote_id,
        "remoteEtag": event["etag"],
        "remoteUpdatedAt": event["updatedAt"],
        "title": event["title"],
        "description": event["description"],
        "location": event["location"],
        "startAt": event["startAt"],
        "endAt": event["endAt"],
        "timezone": event["timezone"],
        "isAllDay": event["isAllDay"],
        "status": event["status"],
        "recurrenceRule": null,
        "attendees": event["attendees"],
        "reminders": event["reminders"],
        "visibility": event["visibility"],
        "colorId": event["colorId"],
        "conferenceData": event["conferenceData"],
        "rawPayload": event["raw"],
        "archivedAt": if cancelled { json!(at) } else { Value::Null },
        "modifiedAt": at,
    });
    match existing {
        Some(stored) => {
            let unchanged = fields.as_object().is_some_and(|f| {
                f.iter()
                    .all(|(k, v)| k == "modifiedAt" || stored.get(k).unwrap_or(&Value::Null) == v)
            });
            if unchanged {
                return Ok(());
            }
            let mut changes: Vec<(&str, Change)> = fields
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| (k.as_str(), Change::Set(v.clone())))
                .collect();
            changes.push(("clock", Change::Set(next_clock(&stored, device_id)?)));
            sync_items::apply_local_edit_in(tx, EXTERNAL_TYPE, &id, &changes, now_ms)?;
        }
        None => {
            let mut payload = fields.as_object().cloned().unwrap_or_default();
            payload.insert("id".into(), json!(id));
            payload.insert("createdAt".into(), json!(at));
            payload.insert("clock".into(), next_clock(&Map::new(), device_id)?);
            insert_local(tx, EXTERNAL_TYPE, &id, payload, now_ms)?;
        }
    }
    outbox::enqueue(tx, &outbox::Change::upsert(EXTERNAL_TYPE, &id), now_ms)?;
    Ok(())
}

/// `applyGoogleCalendarWriteback` for an event: its fields follow the remote.
/// Tasks follow the remote start as their due day / time. The binding keeps
/// the new ETag so the next push sends a current `If-Match`.
#[allow(clippy::too_many_arguments)]
fn write_back(
    conn: &Connection,
    target: &Target,
    event: &Value,
    zone: &dyn LocalZone,
    zone_id: &str,
    named: &HashMap<String, CalendarZone>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    apply_remote_fields(conn, target, event, zone, device_id, now_ms)?;
    // The item now says what the remote says: the binding's snapshot and ETag
    // follow, and the push the write-back queued has nothing left to send.
    if let Some(input) = super::upsert_input(conn, target, zone, zone_id, named)? {
        let written = bindings::Written {
            calendar_id: event["calendarId"].as_str().unwrap_or("").to_owned(),
            event_id: event["id"].as_str().unwrap_or("").to_owned(),
            etag: event["etag"].as_str().map(str::to_owned),
        };
        bindings::record_push(conn, GOOGLE, target, &written, input, device_id, now_ms)?;
    }
    super::dequeue(conn, target)
}

pub(super) fn apply_remote_fields(
    conn: &Connection,
    target: &Target,
    event: &Value,
    zone: &dyn LocalZone,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    match target.source_type.as_str() {
        "event" => {
            let patch = EventPatch {
                title: event["title"].as_str().map(str::to_owned),
                description: Some(event["description"].as_str().map(str::to_owned)),
                location: Some(event["location"].as_str().map(str::to_owned)),
                start_at: event["startAt"].as_str().map(str::to_owned),
                end_at: Some(event["endAt"].as_str().map(str::to_owned)),
                timezone: event["timezone"].as_str().map(str::to_owned),
                is_all_day: event["isAllDay"].as_bool(),
                ..EventPatch::default()
            };
            // An unchanged event ticks nothing (`update_event` compares).
            update_event(conn, &target.source_id, &patch, device_id, now_ms).map(|_| ())
        }
        "task" => {
            let start = event["startAt"].as_str().unwrap_or("");
            let Some(ms) = crate::storage::repositories::instants::to_epoch_ms(start) else {
                return Ok(());
            };
            let date = crate::domain::calendar_items::zone::local_date(zone, ms).key();
            let time = (!event["isAllDay"].as_bool().unwrap_or(false)).then(|| {
                let minutes = crate::domain::calendar_items::zone::local_minutes(zone, ms);
                format!("{:02}:{:02}", minutes / 60, minutes % 60)
            });
            crate::domain::tasks::set_due(
                conn,
                &target.source_id,
                Some(&date),
                time.as_deref(),
                device_id,
                now_ms,
            )?
            .acknowledge();
            Ok(())
        }
        _ => Ok(()),
    }
}

#[allow(clippy::too_many_arguments)]
/// `syncGoogleCalendarSourceInner` after the list call: every event applied,
/// then the cursor, status and time on the synced source row.
pub fn apply_pull(
    conn: &Connection,
    source_id: &str,
    calendar_id: &str,
    raw_events: &[Value],
    next_cursor: Option<&str>,
    zone: &dyn LocalZone,
    zone_id: &str,
    named: &HashMap<String, CalendarZone>,
    device_id: &str,
    now_ms: i64,
) -> Result<usize, StorageError> {
    let mut changed = 0;
    for raw in raw_events {
        let event = remote_event(calendar_id, raw);
        let remote_id = event["id"].as_str().unwrap_or("");
        if let Some(target) = bindings::by_remote(conn, GOOGLE, calendar_id, remote_id)? {
            if event["status"].as_str() == Some("cancelled") {
                // Deleted in Google: the item follows (`applyProviderDelete`).
                if let Some(binding) = bindings::find(conn, GOOGLE, &target)? {
                    super::apply_remote_delete(conn, &target, &binding.id, device_id, now_ms)?;
                }
            } else {
                write_back(
                    conn, &target, &event, zone, zone_id, named, device_id, now_ms,
                )?;
            }
            changed += 1;
            continue;
        }
        let tx = conn.unchecked_transaction().map_err(failed)?;
        upsert_mirror(&tx, source_id, &event, device_id, now_ms)?;
        tx.commit().map_err(failed)?;
        changed += 1;
    }
    set_source_cursor(conn, source_id, next_cursor, "ok", device_id, now_ms)?;
    Ok(changed)
}

/// The synced source row's cursor, status and time.
pub fn set_source_cursor(
    conn: &Connection,
    source_id: &str,
    cursor: Option<&str>,
    status: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let Some(stored) = live_payload(&tx, SOURCE_TYPE, source_id)? else {
        return Ok(());
    };
    let at = iso(now_ms)?;
    let changes = vec![
        ("syncCursor", Change::Set(json!(cursor))),
        ("syncStatus", Change::Set(json!(status))),
        ("lastSyncedAt", Change::Set(json!(at))),
        ("modifiedAt", Change::Set(json!(at))),
        ("clock", Change::Set(next_clock(&stored, device_id)?)),
    ];
    sync_items::apply_local_edit_in(&tx, SOURCE_TYPE, source_id, &changes, now_ms)?;
    outbox::enqueue(&tx, &outbox::Change::upsert(SOURCE_TYPE, source_id), now_ms)?;
    tx.commit().map_err(failed)
}

/// A Google calendar `calendarList` returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleCalendar {
    pub id: String,
    pub title: String,
    pub timezone: Option<String>,
    pub color: Option<String>,
    pub is_primary: bool,
}

/// `connectGoogle` + `discoverGoogleCalendarSources`: the synced account
/// row (`google-account:<email>`) and one row per calendar
/// (`google-calendar:<id>`); the primary is shown, a known calendar keeps its
/// choice, a tombstone left by a disconnect is cleared.
#[allow(clippy::too_many_arguments)]
pub fn connect(
    conn: &Connection,
    email: &str,
    name: Option<&str>,
    primary: &GoogleCalendar,
    calendars: &[GoogleCalendar],
    device_zone_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    upsert(
        &tx,
        &format!("google-account:{email}"),
        json!({
            "provider": GOOGLE, "kind": "account", "accountId": email, "remoteId": primary.id,
            "title": name.unwrap_or(&primary.title), "timezone": primary.timezone, "color": null,
            "isPrimary": false, "isSelected": false, "isMemryManaged": false, "syncStatus": "pending",
            "metadata": { "connectedVia": "oauth", "email": email }, "archivedAt": null,
        }),
        None,
        device_id,
        now_ms,
    )?;
    let mut all = vec![primary.clone()];
    all.extend(calendars.iter().filter(|c| c.id != primary.id).cloned());
    for calendar in &all {
        let id = format!("google-calendar:{}", calendar.id);
        let existing = live_payload(&tx, SOURCE_TYPE, &id)?;
        let selected = if calendar.id == primary.id && existing.is_none() {
            true
        } else {
            existing
                .as_ref()
                .and_then(|s| s.get("isSelected"))
                .and_then(Value::as_bool)
                .unwrap_or(calendar.is_primary)
        };
        let managed = existing
            .as_ref()
            .and_then(|s| s.get("isMemryManaged"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        upsert(
            &tx,
            &id,
            json!({
                "provider": GOOGLE, "kind": "calendar", "accountId": email, "remoteId": calendar.id,
                "title": calendar.title, "timezone": calendar.timezone.clone().unwrap_or_else(|| device_zone_id.to_owned()),
                "color": calendar.color, "isPrimary": calendar.is_primary, "isSelected": selected,
                "isMemryManaged": managed, "archivedAt": null,
            }),
            existing.as_ref().map_or(Some("pending"), |_| None),
            device_id,
            now_ms,
        )?;
    }
    tx.commit().map_err(failed)
}

fn upsert(
    tx: &Connection,
    id: &str,
    fields: Value,
    status: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let at = iso(now_ms)?;
    match live_payload(tx, SOURCE_TYPE, id)? {
        Some(stored) => {
            let mut changes: Vec<(&str, Change)> = fields
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| (k.as_str(), Change::Set(v.clone())))
                .collect();
            changes.push(("modifiedAt", Change::Set(json!(at))));
            changes.push(("clock", Change::Set(next_clock(&stored, device_id)?)));
            sync_items::apply_local_edit_in(tx, SOURCE_TYPE, id, &changes, now_ms)?;
        }
        None => {
            let mut payload = fields.as_object().cloned().unwrap_or_default();
            payload.insert("id".into(), json!(id));
            payload.entry("syncCursor").or_insert(Value::Null);
            payload
                .entry("syncStatus")
                .or_insert(json!(status.unwrap_or("pending")));
            payload.entry("metadata").or_insert(Value::Null);
            payload.insert("createdAt".into(), json!(at));
            payload.insert("modifiedAt".into(), json!(at));
            payload.insert("clock".into(), next_clock(&Map::new(), device_id)?);
            insert_local(tx, SOURCE_TYPE, id, payload, now_ms)?;
        }
    }
    outbox::enqueue(tx, &outbox::Change::upsert(SOURCE_TYPE, id), now_ms)?;
    Ok(())
}

/// `disconnectGoogleCalendar(accountId)`: the account's mirrors purged and
/// its rows tombstoned (the shell revokes and forgets the tokens).
pub fn disconnect(
    conn: &Connection,
    email: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let rows: Vec<(String, String)> = {
        let mut stmt = tx
            .prepare("SELECT id, remote_id FROM calendar_sources WHERE provider = 'google' AND account_id = ?1 AND archived_at IS NULL AND deleted_at IS NULL")
            .map_err(failed)?;
        stmt.query_map([email], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(failed)?
            .collect::<Result<_, _>>()
            .map_err(failed)?
    };
    let at = iso(now_ms)?;
    for (id, remote) in rows {
        crate::domain::calendar_items::selection::purge_mirrors(
            &tx, GOOGLE, &id, &remote, device_id, now_ms,
        )?;
        if let Some(stored) = live_payload(&tx, SOURCE_TYPE, &id)? {
            let changes = vec![
                ("archivedAt", Change::Set(json!(at))),
                ("modifiedAt", Change::Set(json!(at))),
                ("clock", Change::Set(next_clock(&stored, device_id)?)),
            ];
            sync_items::apply_local_edit_in(&tx, SOURCE_TYPE, &id, &changes, now_ms)?;
            outbox::enqueue(&tx, &outbox::Change::upsert(SOURCE_TYPE, &id), now_ms)?;
        }
    }
    tx.commit().map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::calendar_items::zone::FixedZone;

    #[test]
    fn a_timed_push_body_carries_the_memry_source() {
        let input = json!({"sourceType": "event", "sourceId": "e1", "title": "Plan", "description": null,
            "location": "Room 1", "startAt": "2026-03-10T09:00:00.000Z", "endAt": "2026-03-10T10:00:00.000Z",
            "isAllDay": false, "timezone": "Europe/Istanbul", "recurrence": null, "colorId": "11"});
        let body = event_body(&input, &FixedZone(3 * 3_600_000));
        assert_eq!(
            body["start"],
            json!({"dateTime": "2026-03-10T09:00:00.000Z", "timeZone": "Europe/Istanbul"})
        );
        assert_eq!(
            body["extendedProperties"]["private"]["memrySourceId"],
            json!("e1")
        );
        assert_eq!(body["location"], json!("Room 1"));
        assert!(body.get("description").is_none());
        assert_eq!(body["colorId"], json!("11"));
    }

    #[test]
    fn an_all_day_push_sends_local_days_and_a_pull_reads_utc_midnights() {
        let input = json!({"sourceType": "task", "sourceId": "t", "title": "Day", "startAt": "2026-10-11T21:00:00.000Z",
            "endAt": "2026-10-12T21:00:00.000Z", "isAllDay": true, "timezone": "Europe/Istanbul"});
        let body = event_body(&input, &FixedZone(3 * 3_600_000));
        assert_eq!(body["start"]["date"], json!("2026-10-12"));
        assert_eq!(body["end"]["date"], json!("2026-10-13"));
        let pulled = remote_event(
            "primary",
            &json!({"id": "x", "status": "confirmed", "start": {"date": "2026-10-12"}, "end": {"date": "2026-10-13"}}),
        );
        assert_eq!(pulled["startAt"], json!("2026-10-12T00:00:00.000Z"));
        assert_eq!(pulled["isAllDay"], json!(true));
        assert_eq!(pulled["timezone"], json!("UTC"));
        assert_eq!(pulled["title"], json!("Untitled event"));
    }
}
