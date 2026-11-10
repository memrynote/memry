//! A source's sync cursor goes with its purged mirrors (#4022). The cursor
//! records how far the deleted events were pulled, so keeping it makes the
//! next pull incremental and the purged events never return. Each test drives
//! the path the shell calls and then reads what the next pull is planned from:
//! the source's cursor (`reads::sources`), which the shell hands to Google and
//! CalDAV.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::api::calendar_records::CalendarZone;
use memry_core::domain::calendar_items::SOURCE_TYPE;
use memry_core::domain::calendar_items::ical::{IcalWindow, IcalZones};
use memry_core::domain::calendar_items::providers::{caldav, google};
use memry_core::domain::calendar_items::selection::set_source_selection;
use memry_core::domain::calendar_items::zone::FixedZone;
use memry_core::storage::migrations::{self, DATA_MIGRATIONS};
use memry_core::storage::repositories::{Change, sync_items};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::json;

const NOW: i64 = 1_773_000_000_000;
const WORK: &str = "google-calendar:work@group.calendar.google.com";
const PRIMARY: &str = "google-calendar:me@example.com";
static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open() -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("memry-cal-purge-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("scratch");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn calendar(id: &str, title: &str, is_primary: bool) -> google::GoogleCalendar {
    google::GoogleCalendar {
        id: id.into(),
        title: title.into(),
        timezone: Some("UTC".into()),
        color: None,
        is_primary,
    }
}

fn connect(db: &Db, at: i64) {
    db.call_blocking(move |conn| {
        google::connect(
            conn,
            "me@example.com",
            None,
            &calendar("me@example.com", "Me", true),
            &[calendar("work@group.calendar.google.com", "Work", false)],
            "UTC",
            "phone",
            at,
        )
    })
    .expect("connect");
}

fn pull(db: &Db, source_id: &'static str, calendar_id: &'static str, cursor: &'static str) {
    let events = [json!({
        "id": "ev1", "status": "confirmed", "summary": "Standup",
        "start": {"dateTime": "2026-03-10T09:00:00Z"}, "end": {"dateTime": "2026-03-10T09:30:00Z"},
    })];
    db.call_blocking(move |conn| {
        google::apply_pull(
            conn,
            source_id,
            calendar_id,
            &events,
            Some(cursor),
            &FixedZone(0),
            "UTC",
            &HashMap::new(),
            "phone",
            NOW + 10,
        )
    })
    .expect("pull");
}

/// What the shell reads to plan the next pull.
fn cursor(db: &Db, source_id: &'static str) -> Option<String> {
    db.call_blocking(move |conn| {
        conn.query_row(
            "SELECT sync_cursor FROM calendar_sources WHERE id = ?1",
            [source_id],
            |row| row.get(0),
        )
        .map_err(|err| memry_core::api::errors::StorageError::Failed {
            what: err.to_string(),
        })
    })
    .expect("cursor")
}

fn live_events(db: &Db) -> i64 {
    db.call_blocking(|conn| {
        conn.query_row(
            "SELECT count(*) FROM calendar_external_events WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|err| memry_core::api::errors::StorageError::Failed {
            what: err.to_string(),
        })
    })
    .expect("count")
}

fn select(db: &Db, source_id: &'static str, selected: bool, at: i64) {
    db.call_blocking(move |conn| set_source_selection(conn, source_id, selected, "phone", at))
        .expect("selection")
        .expect("a calendar");
}

#[test]
fn turning_a_calendar_off_and_on_pulls_it_in_full() {
    let db = open();
    connect(&db, NOW);
    pull(&db, WORK, "work@group.calendar.google.com", "sync-token:a");
    assert_eq!(live_events(&db), 1);

    select(&db, WORK, false, NOW + 20);
    assert_eq!(live_events(&db), 0, "the purge removes the events");
    assert_eq!(cursor(&db, WORK), None, "and the cursor that covered them");

    select(&db, WORK, true, NOW + 30);
    assert_eq!(
        cursor(&db, WORK),
        None,
        "the next pull starts from the window"
    );
    pull(&db, WORK, "work@group.calendar.google.com", "sync-token:b");
    assert_eq!(live_events(&db), 1, "the events come back");
}

#[test]
fn reconnecting_an_account_pulls_every_calendar_in_full() {
    let db = open();
    connect(&db, NOW);
    pull(&db, PRIMARY, "me@example.com", "sync-token:p");
    pull(&db, WORK, "work@group.calendar.google.com", "sync-token:w");

    db.call_blocking(|conn| google::disconnect(conn, "me@example.com", "phone", NOW + 20))
        .expect("disconnect");
    assert_eq!(live_events(&db), 0);

    connect(&db, NOW + 30);
    assert_eq!(cursor(&db, PRIMARY), None);
    assert_eq!(cursor(&db, WORK), None);
}

#[test]
fn connecting_pulls_the_primary_in_full_but_keeps_a_live_calendars_progress() {
    let db = open();
    connect(&db, NOW);
    pull(&db, PRIMARY, "me@example.com", "sync-token:p");
    pull(&db, WORK, "work@group.calendar.google.com", "sync-token:w");

    connect(&db, NOW + 30);
    assert_eq!(cursor(&db, PRIMARY), None);
    assert_eq!(cursor(&db, WORK).as_deref(), Some("sync-token:w"));
}

#[test]
fn discovery_pulls_in_full_a_calendar_an_older_build_archived_with_its_cursor() {
    let db = open();
    connect(&db, NOW);
    pull(&db, WORK, "work@group.calendar.google.com", "sync-token:w");
    // What a build before the fix left behind: archived, events gone, cursor kept.
    db.call_blocking(|conn| {
        let tx = conn.unchecked_transaction().expect("tx");
        sync_items::apply_local_edit_in(
            &tx,
            SOURCE_TYPE,
            WORK,
            &[("archivedAt", Change::Set(json!("2026-03-08T00:00:00.000Z")))],
            NOW + 20,
        )?;
        tx.commit().expect("commit");
        Ok(())
    })
    .expect("archive");
    assert_eq!(cursor(&db, WORK).as_deref(), Some("sync-token:w"));

    connect(&db, NOW + 30);
    assert_eq!(cursor(&db, WORK), None);
}

#[test]
fn turning_a_caldav_calendar_off_and_on_pulls_it_in_full() {
    const URL: &str = "https://localhost:5232/agent/work/";
    const OBJECT: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:standup\r\nSUMMARY:Standup\r\nDTSTART:20260310T090000Z\r\nDTEND:20260310T093000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let db = open();
    db.call_blocking(|conn| {
        caldav::connect(
            conn,
            &caldav::Connect {
                server_url: "https://localhost:5232/".into(),
                username: "agent".into(),
                principal_url: "https://localhost:5232/agent/".into(),
                home_url: "https://localhost:5232/agent/".into(),
                preset: None,
                calendars: vec![caldav::DiscoveredCalendar {
                    url: URL.into(),
                    display_name: "Work".into(),
                    color: None,
                    timezone: None,
                    supports_sync_collection: true,
                }],
                selected: None,
            },
            "phone",
            NOW,
        )
    })
    .expect("connect");
    let id: &'static str = Box::leak(caldav::calendar_source_id(URL).into_boxed_str());
    let pull = |cursor: &'static str, at: i64| {
        db.call_blocking(move |conn| {
            caldav::apply_pull(
                conn,
                id,
                URL,
                &caldav::Pull {
                    objects: vec![caldav::Object {
                        href: format!("{URL}standup.ics"),
                        etag: Some("e1".into()),
                        data: OBJECT.into(),
                    }],
                    removed: vec![],
                    full: true,
                    cursor: Some(cursor.into()),
                },
                IcalWindow {
                    start_ms: 1_770_000_000_000,
                    end_ms: 1_780_000_000_000,
                },
                &IcalZones {
                    named: HashMap::new(),
                    local: CalendarZone {
                        identifier: "UTC".into(),
                        base_offset_ms: 0,
                        transitions: vec![],
                    },
                },
                &FixedZone(0),
                "UTC",
                "phone",
                at,
            )
        })
        .expect("pull");
    };
    pull("sync-token:c", NOW + 10);
    assert_eq!(cursor(&db, id).as_deref(), Some("sync-token:c"));
    assert_eq!(live_events(&db), 1);

    select(&db, id, false, NOW + 20);
    assert_eq!(live_events(&db), 0);
    assert_eq!(cursor(&db, id), None);

    select(&db, id, true, NOW + 30);
    pull("sync-token:d", NOW + 40);
    assert_eq!(live_events(&db), 1, "the events come back");
}

#[test]
fn migration_13_resets_every_google_and_caldav_cursor_once() {
    let mut conn = Connection::open_in_memory().expect("memory db");
    migrations::run(&mut conn, &DATA_MIGRATIONS[..12]).expect("up to 12");
    let insert = |id: &str, provider: &str, kind: &str, cursor: &str| {
        let payload = json!({
            "id": id, "provider": provider, "kind": kind, "remoteId": id,
            "syncCursor": cursor, "extra": "kept",
        })
        .to_string();
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
             VALUES ('calendar_source', ?1, ?2, 'full', 1)",
            rusqlite::params![id, payload],
        )
        .expect("sync item");
        conn.execute(
            "INSERT INTO calendar_sources (id, provider, kind, remote_id, sync_cursor)
             VALUES (?1, ?2, ?3, ?1, ?4)",
            rusqlite::params![id, provider, kind, cursor],
        )
        .expect("source");
    };
    insert("g", "google", "calendar", "sync-token:g");
    insert("c", "caldav", "calendar", "sync-token:c");
    insert("i", "ics", "calendar", "etag:i");
    migrations::run(&mut conn, DATA_MIGRATIONS).expect("to latest");

    let column = |id: &str| -> Option<String> {
        conn.query_row(
            "SELECT sync_cursor FROM calendar_sources WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .expect("column")
    };
    let payload = |id: &str| -> serde_json::Value {
        let raw: String = conn
            .query_row(
                "SELECT payload FROM sync_items WHERE item_id = ?1",
                [id],
                |row| row.get(0),
            )
            .expect("payload");
        serde_json::from_str(&raw).expect("json")
    };
    for id in ["g", "c"] {
        assert_eq!(column(id), None, "{id} column");
        assert!(payload(id)["syncCursor"].is_null(), "{id} payload");
        assert_eq!(payload(id)["extra"], json!("kept"));
    }
    assert_eq!(
        column("i").as_deref(),
        Some("etag:i"),
        "other providers keep theirs"
    );
}
