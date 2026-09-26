//! Subscribed calendars on the phone (spec 007 CL073): subscribe writes the
//! synced source and this device's mirror, a refresh follows the feed, a
//! failure keeps the mirror and records why, unsubscribe tombstones the
//! source and drops the mirror, and the projection shows the feed's events.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::api::calendar_records::CalendarZone;
use memry_core::domain::calendar_items::ical::{IcalZones, parse_feed};
use memry_core::domain::calendar_items::ics::{self, Validators};
use memry_core::domain::calendar_items::projection::{self, RangeInput};
use memry_core::domain::calendar_items::zone::FixedZone;
use memry_core::storage::{Db, open_data};

const NOW: i64 = 1_773_000_000_000; // 2026-03-08
static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open() -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("memry-cal-feeds-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("scratch");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn zones() -> IcalZones {
    IcalZones {
        named: HashMap::new(),
        local: CalendarZone {
            identifier: "UTC".into(),
            base_offset_ms: 0,
            transitions: vec![],
        },
    }
}

fn feed(events: &str) -> String {
    format!("BEGIN:VCALENDAR\r\nX-WR-CALNAME:Holidays\r\n{events}END:VCALENDAR\r\n")
}

const ONE: &str =
    "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Spring day\r\nDTSTART;VALUE=DATE:20260320\r\nEND:VEVENT\r\n";
const TWO: &str = "BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Standup\r\nDTSTART:20260310T090000Z\r\nDTEND:20260310T091500Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\n";

fn count(db: &Db, source: &str) -> i64 {
    let source = source.to_owned();
    db.call_blocking(move |conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM calendar_local_events WHERE source_id = ?1",
            [source],
            |r| r.get(0),
        )
        .map_err(|e| memry_core::api::errors::StorageError::Failed {
            what: e.to_string(),
        })
    })
    .expect("count")
}

#[test]
fn subscribe_refresh_fail_and_unsubscribe() {
    let db = open();
    let url = ics::normalize_url("webcal://example.com/holidays.ics").expect("url");
    let first =
        parse_feed(&feed(&format!("{ONE}{TWO}")), ics::window(NOW), &zones()).expect("feed");
    let validators = Validators {
        etag: Some("\"v1\"".into()),
        last_modified: None,
    };
    let (u, f, v) = (url.clone(), first.clone(), validators.clone());
    let id = db
        .call_blocking(move |conn| ics::subscribe(conn, &u, None, &f, &v, "phone", NOW))
        .expect("subscribe");
    assert_eq!(id, ics::source_id(&url));
    assert_eq!(count(&db, &id), 4);

    // The projection shows the mirror with the source's name.
    let items = db
        .call_blocking(|conn| {
            projection::range(
                conn,
                &FixedZone(0),
                &RangeInput {
                    start_at: "2026-03-01T00:00:00.000Z".into(),
                    end_at: "2026-04-01T00:00:00.000Z".into(),
                    include_unselected_sources: true,
                    include_external: true,
                    external_providers: None,
                    enabled_property_names: vec![],
                    show_notes_by_created: false,
                    local_timezone: "UTC".into(),
                },
            )
        })
        .expect("range");
    let feed_items: Vec<_> = items
        .iter()
        .filter(|i| i.source_type == "external_event")
        .collect();
    assert_eq!(feed_items.len(), 4, "{items:?}");

    // A refresh that dropped the series leaves one event.
    let second = parse_feed(&feed(ONE), ics::window(NOW), &zones()).expect("feed");
    let (i, s, v) = (id.clone(), second.clone(), validators.clone());
    db.call_blocking(move |conn| ics::record_fetch(conn, &i, Ok((&s, &v)), NOW + 1))
        .expect("refresh");
    assert_eq!(count(&db, &id), 1);

    // A failure keeps the mirror and records the code; the source is due
    // again after the short retry.
    let i = id.clone();
    db.call_blocking(move |conn| ics::record_fetch(conn, &i, Err("timeout"), NOW + 2))
        .expect("fail");
    assert_eq!(count(&db, &id), 1);
    let states = db.call_blocking(|conn| ics::states(conn)).expect("states");
    assert_eq!(states[0].last_error.as_deref(), Some("timeout"));
    assert_eq!(states[0].etag.as_deref(), Some("\"v1\""));
    let due = db
        .call_blocking(|conn| ics::due(conn, NOW + 16 * 60_000, false))
        .expect("due");
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].validators.etag.as_deref(), Some("\"v1\""));

    // Unsubscribe: archived source, no mirror, not due.
    let i = id.clone();
    db.call_blocking(move |conn| ics::unsubscribe(conn, &i, "phone", NOW + 3))
        .expect("unsubscribe");
    assert_eq!(count(&db, &id), 0);
    assert!(
        db.call_blocking(|conn| ics::due(conn, NOW + DAY, true))
            .expect("due")
            .is_empty()
    );
    assert!(
        db.call_blocking(|conn| ics::states(conn))
            .expect("states")
            .is_empty()
    );
}

const DAY: i64 = 86_400_000;
