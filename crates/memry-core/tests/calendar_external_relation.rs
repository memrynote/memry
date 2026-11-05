//! An imported event a relation chip names (`resolveRefs`, `ipc/relation-handlers.ts`; #3530
//! 13q-2) against real SQLite: the mirror's title and start, the mirror as the item to focus,
//! and once promotion archived it, the native event its binding names. A subscribed calendar's
//! event, which this device mirrors outside the synced table, resolves as its own item.

use std::collections::HashMap;

use memry_core::api::calendar_records::CalendarZone;
use memry_core::domain::calendar_items::ical::{IcalZones, parse_feed};
use memry_core::domain::calendar_items::ics::{self, Validators};
use memry_core::domain::calendar_items::reads::{ExternalRelation, external_relation};
use memry_core::domain::calendar_items::write;
use memry_core::storage::repositories::sync_items::InboundRecord;
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use serde_json::{Value, json};

const NOW: i64 = 1_790_000_000_000;

fn open() -> Db {
    let dir = tempfile::Builder::new()
        .prefix("memry-ext-relation-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn inbound(item_type: &str, id: &str, payload: &Value) -> InboundRecord {
    InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: None,
        signer_device_id: None,
        updated_at: 0,
        deleted_at: None,
    }
}

/// A Google calendar and one event mirrored from it (`calendar.json`'s promote section).
fn seeded() -> Db {
    let db = open();
    let source = json!({
        "id": "src-work", "provider": "google", "kind": "calendar", "accountId": "acct-1",
        "remoteId": "work@group.calendar.google.com", "title": "Work", "isSelected": true,
        "isPrimary": false, "isMemryManaged": false, "clock": { "desktop": 1 },
        "createdAt": "2026-09-01T08:00:00.000Z", "modifiedAt": "2026-09-24T08:00:00.000Z"
    });
    let mirror = json!({
        "id": "ext-1", "sourceId": "src-work", "remoteEventId": "g-1", "title": "Design review",
        "startAt": "2026-09-24T07:00:00.000Z", "endAt": "2026-09-24T08:30:00.000Z",
        "isAllDay": false, "status": "confirmed", "clock": { "desktop": 2 },
        "createdAt": "2026-09-24T08:00:00.000Z", "modifiedAt": "2026-09-24T08:00:00.000Z"
    });
    db.call_blocking(move |conn| {
        apply_inbound(conn, &inbound("calendar_source", "src-work", &source), 1)?;
        apply_inbound(
            conn,
            &inbound("calendar_external_event", "ext-1", &mirror),
            1,
        )?;
        Ok(())
    })
    .unwrap();
    db
}

fn read(db: &Db, id: &str) -> Option<ExternalRelation> {
    let id = id.to_owned();
    db.read_blocking(move |conn| external_relation(conn, &id))
        .unwrap()
}

#[test]
fn a_mirror_is_its_own_item_until_promotion_names_the_native_event() {
    let db = seeded();
    assert_eq!(
        read(&db, "ext-1"),
        Some(ExternalRelation {
            title: "Design review".into(),
            start_at: "2026-09-24T07:00:00.000Z".into(),
            calendar_item_id: "ext-1".into(),
        })
    );
    assert_eq!(read(&db, "ext-none"), None);

    let promoted = db
        .call_blocking(|conn| write::promote(conn, "ext-1", "device-a", NOW))
        .unwrap()
        .expect("a promotable mirror");
    let relation = read(&db, "ext-1").expect("an archived mirror still resolves");
    assert_eq!(relation.title, "Design review");
    assert_eq!(relation.calendar_item_id, promoted);
}

#[test]
fn a_subscribed_calendars_event_is_its_own_item() {
    let db = open();
    let zones = IcalZones {
        named: HashMap::new(),
        local: CalendarZone {
            identifier: "UTC".into(),
            base_offset_ms: 0,
            transitions: vec![],
        },
    };
    let feed = "BEGIN:VCALENDAR\r\nX-WR-CALNAME:Holidays\r\nBEGIN:VEVENT\r\nUID:a\r\n\
                SUMMARY:Spring day\r\nDTSTART:20260920T090000Z\r\nDTEND:20260920T100000Z\r\n\
                END:VEVENT\r\nEND:VCALENDAR\r\n";
    let events = parse_feed(feed, ics::window(NOW), &zones).expect("feed");
    let url = ics::normalize_url("webcal://example.com/holidays.ics").expect("url");
    db.call_blocking(move |conn| {
        ics::subscribe(
            conn,
            &url,
            None,
            &events,
            &Validators::default(),
            "desk",
            NOW,
        )
    })
    .expect("subscribe");
    let id: String = db
        .read_blocking(|conn| {
            conn.query_row("SELECT id FROM calendar_local_events", [], |row| row.get(0))
                .map_err(|e| memry_core::api::errors::StorageError::Failed {
                    what: e.to_string(),
                })
        })
        .expect("the feed's one event");

    assert_eq!(
        read(&db, &id),
        Some(ExternalRelation {
            title: "Spring day".into(),
            start_at: "2026-09-20T09:00:00.000Z".into(),
            calendar_item_id: id.clone(),
        })
    );
}
