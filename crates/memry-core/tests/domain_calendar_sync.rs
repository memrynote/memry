//! Inbound calendar records (spec 007 CL010/CL011) against real SQLite,
//! through the same `apply_inbound` every pull path uses.
//!
//! | Test                                                   | Desktop rule                                   |
//! | ------------------------------------------------------ | ---------------------------------------------- |
//! | the declaration subscribes to the four types           | CL010                                          |
//! | a desktop source row projects with its local columns   | source insert                                  |
//! | a source null keeps, a re-apply of the same row is a no-op | `data.x ?? existing.x`, `resolveClock`     |
//! | an external event before its source waits, then shows  | `MissingSyncParentError` park + replay         |
//! | external rich fields clear on an explicit null         | `hasKey` presence                              |
//! | a binding that lands before its event is kept          | binding insert (no FK)                         |
//! | a dominating local clock skips the remote              | `resolveClock` skip                            |
//! | the concurrent event merge is per field                | `mergeCalendarEventFields`                     |
//! | the wholesale event apply seeds field clocks           | `initAllFieldClocks(remoteClock)`              |
//! | unknown keys round-trip                                | D7                                             |
//! | a tombstone deletes each type                          | `applyDelete`                                  |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::protocol::types::{ArrivingItemType, Declaration};
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-calendar-sync-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn inbound(
    item_type: &str,
    item_id: &str,
    payload: &Value,
    deleted_at: Option<i64>,
) -> InboundRecord {
    InboundRecord {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        payload_json: serde_json::to_string(payload).expect("serialise"),
        server_cursor: Some(7),
        signer_device_id: Some("device-desktop".to_owned()),
        updated_at: NOW,
        deleted_at,
    }
}

fn stored(conn: &Connection, item_type: &str, item_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, item_type, item_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn one<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str) -> T {
    conn.query_row(sql, [], |row| row.get(0)).expect("query")
}

/// What desktop pushes for a Google calendar: its whole `calendar_sources` row.
fn source_row(clock: Value) -> Value {
    json!({
        "id": "src-work",
        "provider": "google",
        "kind": "calendar",
        "accountId": "acct-1",
        "remoteId": "work@group.calendar.google.com",
        "title": "Work",
        "timezone": "Europe/Istanbul",
        "color": "#9fc6e7",
        "isPrimary": false,
        "isSelected": true,
        "isMemryManaged": false,
        "syncCursor": "CPj1",
        "syncStatus": "ok",
        "lastSyncedAt": "2026-09-24T08:00:00.000Z",
        "lastError": null,
        "metadata": {"accessRole": "owner"},
        "archivedAt": null,
        "clock": clock,
        "syncedAt": null,
        "createdAt": "2026-09-01T08:00:00.000Z",
        "modifiedAt": "2026-09-24T08:00:00.000Z",
    })
}

fn external_row(clock: Value) -> Value {
    json!({
        "sourceId": "src-work",
        "remoteEventId": "g-1",
        "remoteEtag": "\"etag-1\"",
        "remoteUpdatedAt": "2026-09-24T08:00:00.000Z",
        "title": "Design review",
        "description": "Agenda",
        "location": "Room 4",
        "startAt": "2026-09-24T07:00:00.000Z",
        "endAt": "2026-09-24T08:30:00.000Z",
        "timezone": "Europe/Istanbul",
        "isAllDay": false,
        "status": "confirmed",
        "recurrenceRule": null,
        "attendees": [{"email": "deniz@example.com", "responseStatus": "accepted"}],
        "reminders": {"useDefault": true},
        "visibility": null,
        "colorId": "9",
        "conferenceData": {"entryPoints": [{"uri": "https://meet.google.com/abc"}]},
        "rawPayload": null,
        "archivedAt": null,
        "clock": clock,
        "createdAt": "2026-09-24T08:00:00.000Z",
        "modifiedAt": "2026-09-24T08:00:00.000Z",
    })
}

fn event_row(clock: Value, field_clocks: Value) -> Value {
    json!({
        "id": "evt-1",
        "title": "Lunch with Deniz",
        "description": null,
        "location": null,
        "startAt": "2026-09-24T10:00:00.000Z",
        "endAt": "2026-09-24T11:00:00.000Z",
        "timezone": "Europe/Istanbul",
        "isAllDay": false,
        "recurrenceRule": null,
        "recurrenceExceptions": null,
        "attendees": null,
        "reminders": null,
        "visibility": null,
        "colorId": null,
        "conferenceData": null,
        "parentEventId": null,
        "originalStartTime": null,
        "targetCalendarId": "work@group.calendar.google.com",
        "archivedAt": null,
        "clock": clock,
        "fieldClocks": field_clocks,
        "syncedAt": null,
        "createdAt": "2026-09-20T08:00:00.000Z",
        "modifiedAt": "2026-09-20T08:00:00.000Z",
    })
}

#[test]
fn the_declaration_subscribes_to_the_four_calendar_types() {
    let declaration = Declaration::subscribed();
    for item_type in [
        "calendar_source",
        "calendar_event",
        "calendar_external_event",
        "calendar_binding",
    ] {
        assert_eq!(
            declaration.classify(item_type),
            ArrivingItemType::Subscribed
        );
    }
}

#[test]
fn a_source_null_keeps_and_a_reapply_is_harmless() {
    let db = open("source");
    db.call_blocking(|conn| {
        let row = source_row(json!({"desktop": 1}));
        assert_eq!(
            apply_inbound(
                conn,
                &inbound("calendar_source", "src-work", &row, None),
                NOW
            )?,
            ApplyOutcome::Applied
        );
        let title: String = one(
            conn,
            "SELECT title FROM calendar_sources WHERE id = 'src-work'",
        );
        assert_eq!(title, "Work");
        let selected: i64 = one(conn, "SELECT is_selected FROM calendar_sources");
        assert_eq!(selected, 1);

        // A newer row that nulls the title and the metadata: `??` keeps both.
        let mut newer = source_row(json!({"desktop": 2}));
        newer["title"] = Value::Null;
        newer["metadata"] = Value::Null;
        newer["isSelected"] = json!(false);
        apply_inbound(
            conn,
            &inbound("calendar_source", "src-work", &newer, None),
            NOW,
        )?;
        let payload = stored(conn, "calendar_source", "src-work");
        assert_eq!(payload["title"], "Work");
        assert_eq!(payload["metadata"], json!({"accessRole": "owner"}));
        assert_eq!(payload["isSelected"], json!(false));

        // Re-applying the same row is a no-op on the projection.
        apply_inbound(
            conn,
            &inbound("calendar_source", "src-work", &newer, None),
            NOW,
        )?;
        let count: i64 = one(conn, "SELECT count(*) FROM calendar_sources");
        assert_eq!(count, 1);
        Ok(())
    })
    .expect("calendar source apply");
}

#[test]
fn an_external_event_before_its_source_waits_then_shows() {
    let db = open("orphan");
    db.call_blocking(|conn| {
        let event = external_row(json!({"desktop": 1}));
        assert_eq!(
            apply_inbound(
                conn,
                &inbound("calendar_external_event", "ext-1", &event, None),
                NOW
            )?,
            ApplyOutcome::Applied
        );
        let joined = "SELECT count(*) FROM calendar_external_events e \
                      JOIN calendar_sources s ON s.id = e.source_id";
        assert_eq!(one::<i64>(conn, joined), 0);
        apply_inbound(
            conn,
            &inbound(
                "calendar_source",
                "src-work",
                &source_row(json!({"desktop": 1})),
                None,
            ),
            NOW,
        )?;
        assert_eq!(one::<i64>(conn, joined), 1);
        Ok(())
    })
    .expect("orphan external event");
}

#[test]
fn external_rich_fields_clear_on_an_explicit_null() {
    let db = open("rich");
    db.call_blocking(|conn| {
        apply_inbound(
            conn,
            &inbound(
                "calendar_external_event",
                "ext-1",
                &external_row(json!({"d": 1})),
                None,
            ),
            NOW,
        )?;
        let mut newer = external_row(json!({"d": 2}));
        newer["attendees"] = Value::Null;
        newer["conferenceData"] = Value::Null;
        newer["location"] = Value::Null;
        apply_inbound(
            conn,
            &inbound("calendar_external_event", "ext-1", &newer, None),
            NOW,
        )?;
        let payload = stored(conn, "calendar_external_event", "ext-1");
        assert_eq!(payload["attendees"], Value::Null);
        assert_eq!(payload["conferenceData"], Value::Null);
        assert_eq!(
            payload["location"], "Room 4",
            "location is `??`, null keeps"
        );
        Ok(())
    })
    .expect("rich fields");
}

#[test]
fn a_binding_that_lands_before_its_event_is_kept() {
    let db = open("binding");
    db.call_blocking(|conn| {
        let binding = json!({
            "sourceType": "event", "sourceId": "evt-1", "provider": "google",
            "remoteCalendarId": "work@group.calendar.google.com", "remoteEventId": "g-1",
            "ownershipMode": "provider_managed", "writebackMode": "time_and_text",
            "remoteVersion": "\"etag-1\"", "lastLocalSnapshot": null, "archivedAt": null,
            "clock": {"desktop": 1}, "createdAt": "2026-09-24T08:00:00.000Z",
            "modifiedAt": "2026-09-24T08:00:00.000Z"
        });
        apply_inbound(
            conn,
            &inbound("calendar_binding", "bind-1", &binding, None),
            NOW,
        )?;
        apply_inbound(
            conn,
            &inbound(
                "calendar_event",
                "evt-1",
                &event_row(json!({"desktop": 1}), Value::Null),
                None,
            ),
            NOW,
        )?;
        let joined: i64 = one(
            conn,
            "SELECT count(*) FROM calendar_bindings b JOIN calendar_events e ON e.id = b.source_id",
        );
        assert_eq!(joined, 1);
        let created: String = one(conn, "SELECT created_at_raw FROM calendar_bindings");
        assert_eq!(created, "2026-09-24T08:00:00.000Z");
        Ok(())
    })
    .expect("binding first");
}

#[test]
fn a_dominating_local_clock_skips_the_remote() {
    let db = open("skip");
    db.call_blocking(|conn| {
        apply_inbound(
            conn,
            &inbound(
                "calendar_source",
                "src-work",
                &source_row(json!({"a": 3})),
                None,
            ),
            NOW,
        )?;
        let mut stale = source_row(json!({"a": 2}));
        stale["title"] = json!("Stale");
        assert_eq!(
            apply_inbound(
                conn,
                &inbound("calendar_source", "src-work", &stale, None),
                NOW
            )?,
            ApplyOutcome::Skipped
        );
        assert_eq!(stored(conn, "calendar_source", "src-work")["title"], "Work");
        Ok(())
    })
    .expect("skip");
}

#[test]
fn the_concurrent_event_merge_is_per_field() {
    let db = open("merge");
    db.call_blocking(|conn| {
        let fc = json!({"title": {"phone": 2}, "startAt": {"phone": 1}});
        let mut local = event_row(json!({"phone": 2}), fc);
        local["title"] = json!("Phone title");
        apply_inbound(conn, &inbound("calendar_event", "evt-1", &local, None), NOW)?;

        let remote_fc = json!({"title": {"phone": 1}, "startAt": {"phone": 1, "desktop": 1}});
        let mut remote = event_row(json!({"phone": 1, "desktop": 1}), remote_fc);
        remote["startAt"] = json!("2026-09-24T12:00:00.000Z");
        remote["title"] = json!("Desktop title");
        remote
            .as_object_mut()
            .expect("object")
            .remove("targetCalendarId");
        apply_inbound(
            conn,
            &inbound("calendar_event", "evt-1", &remote, None),
            NOW,
        )?;

        let payload = stored(conn, "calendar_event", "evt-1");
        assert_eq!(
            payload["startAt"], "2026-09-24T12:00:00.000Z",
            "the remote's newer field"
        );
        assert_eq!(
            payload["title"], "Phone title",
            "the local's larger field clock total wins"
        );
        assert_eq!(
            payload["targetCalendarId"],
            "work@group.calendar.google.com"
        );
        assert_eq!(payload["clock"], json!({"phone": 2, "desktop": 1}));
        let start: String = one(conn, "SELECT start_at FROM calendar_events");
        assert_eq!(start, "2026-09-24T12:00:00.000Z");
        Ok(())
    })
    .expect("merge");
}

#[test]
fn the_wholesale_event_apply_seeds_field_clocks_and_keeps_unknown_keys() {
    let db = open("wholesale");
    db.call_blocking(|conn| {
        let mut first = event_row(json!({"desktop": 1}), Value::Null);
        first["futureField"] = json!({"kept": true});
        apply_inbound(conn, &inbound("calendar_event", "evt-1", &first, None), NOW)?;

        let mut second = event_row(json!({"desktop": 2}), Value::Null);
        second["colorId"] = json!("11");
        second["title"] = Value::Null;
        second
            .as_object_mut()
            .expect("object")
            .remove("futureField");
        apply_inbound(
            conn,
            &inbound("calendar_event", "evt-1", &second, None),
            NOW,
        )?;

        let payload = stored(conn, "calendar_event", "evt-1");
        assert_eq!(payload["title"], "Lunch with Deniz", "title is `??`");
        assert_eq!(payload["colorId"], "11");
        assert_eq!(payload["futureField"], json!({"kept": true}));
        assert_eq!(payload["fieldClocks"]["title"], json!({"desktop": 2}));
        Ok(())
    })
    .expect("wholesale");
}

#[test]
fn a_tombstone_deletes_each_type() {
    let db = open("tombstone");
    db.call_blocking(|conn| {
        apply_inbound(
            conn,
            &inbound(
                "calendar_source",
                "src-work",
                &source_row(json!({"d": 1})),
                None,
            ),
            NOW,
        )?;
        apply_inbound(
            conn,
            &inbound(
                "calendar_event",
                "evt-1",
                &event_row(json!({"d": 1}), Value::Null),
                None,
            ),
            NOW,
        )?;
        apply_inbound(
            conn,
            &inbound("calendar_source", "src-work", &json!({}), Some(NOW)),
            NOW,
        )?;
        apply_inbound(
            conn,
            &inbound("calendar_event", "evt-1", &json!({}), Some(NOW)),
            NOW,
        )?;
        let live: i64 = one(
            conn,
            "SELECT (SELECT count(*) FROM calendar_sources WHERE deleted_at IS NULL) + \
             (SELECT count(*) FROM calendar_events WHERE deleted_at IS NULL)",
        );
        assert_eq!(live, 0);
        Ok(())
    })
    .expect("tombstones");
}
