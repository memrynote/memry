//! A calendar source's `syncCursor` is this device's pull position (#4069).
//! It rides in the synced payload so older builds and the vectors are
//! unchanged, but another device's cursor is never adopted: doing so makes this
//! device pull only that device's deltas, and every event it purged or never
//! pulled stays missing. Each test applies a remote source through
//! `apply_inbound`, the entry every pull path uses, against real SQLite, then
//! reads what the next pull is planned from (the `calendar_sources` column and
//! the payload this device pushes).

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::api::errors::StorageError;
use memry_core::domain::calendar_items::providers::google;
use memry_core::storage::migrations::{self, DATA_MIGRATIONS};
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_773_000_000_000;
const WORK: &str = "google-calendar:work@group.calendar.google.com";
static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open() -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir =
        std::env::temp_dir().join(format!("memry-cal-cursor-{}-{unique}", std::process::id()));
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

/// This device connects the account and pulls `WORK`, ending at `cursor`.
fn local_source_at(db: &Db, cursor: Option<&'static str>) {
    db.call_blocking(move |conn| {
        google::connect(
            conn,
            "me@example.com",
            None,
            &calendar("me@example.com", "Me", true),
            &[calendar("work@group.calendar.google.com", "Work", false)],
            "UTC",
            "phone",
            NOW,
        )?;
        google::set_source_cursor(conn, WORK, cursor, "ok", "phone", NOW + 10)
    })
    .expect("local source");
}

fn column(db: &Db, source_id: &'static str) -> Option<String> {
    db.call_blocking(move |conn| {
        conn.query_row(
            "SELECT sync_cursor FROM calendar_sources WHERE id = ?1",
            [source_id],
            |row| row.get(0),
        )
        .map_err(|err| StorageError::Failed {
            what: err.to_string(),
        })
    })
    .expect("column")
}

fn pushed(db: &Db, source_id: &'static str) -> Value {
    db.call_blocking(move |conn| {
        let raw = sync_items::push_payload(conn, "calendar_source", source_id)?
            .expect("a pushed payload");
        Ok(serde_json::from_str(&raw).expect("json"))
    })
    .expect("payload")
}

/// Another device's push of `WORK`, carrying its own cursor and a clock that
/// either dominates this device's or is concurrent with it.
fn remote(db: &Db, clock: Value, cursor: &str) -> Value {
    let mut payload = pushed(db, WORK);
    payload["clock"] = clock;
    payload["syncCursor"] = json!(cursor);
    payload["title"] = json!("Work (renamed on desktop)");
    payload
}

fn apply(db: &Db, source_id: &'static str, payload: Value) {
    let record = InboundRecord {
        item_type: "calendar_source".to_owned(),
        item_id: source_id.to_owned(),
        payload_json: serde_json::to_string(&payload).expect("serialise"),
        server_cursor: Some(7),
        signer_device_id: Some("desktop".to_owned()),
        updated_at: NOW + 100,
        deleted_at: None,
    };
    let outcome = db
        .call_blocking(move |conn| apply_inbound(conn, &record, NOW + 100))
        .expect("apply");
    assert_eq!(outcome, ApplyOutcome::Applied);
}

fn local_clock(db: &Db) -> Value {
    pushed(db, WORK)["clock"].clone()
}

#[test]
fn a_dominating_remote_source_keeps_this_devices_cursor() {
    let db = open();
    local_source_at(&db, Some("sync-token:phone"));
    let mut clock = local_clock(&db);
    clock["desktop"] = json!(5);
    clock["phone"] = json!(99);

    apply(&db, WORK, remote(&db, clock, "sync-token:desktop"));

    assert_eq!(pushed(&db, WORK)["title"], "Work (renamed on desktop)");
    assert_eq!(column(&db, WORK).as_deref(), Some("sync-token:phone"));
    assert_eq!(pushed(&db, WORK)["syncCursor"], "sync-token:phone");
}

#[test]
fn a_concurrent_remote_source_keeps_this_devices_cursor() {
    let db = open();
    local_source_at(&db, Some("sync-token:phone"));

    apply(
        &db,
        WORK,
        remote(&db, json!({"desktop": 1}), "sync-token:desktop"),
    );

    assert_eq!(pushed(&db, WORK)["title"], "Work (renamed on desktop)");
    assert_eq!(column(&db, WORK).as_deref(), Some("sync-token:phone"));
    assert_eq!(pushed(&db, WORK)["syncCursor"], "sync-token:phone");
}

#[test]
fn a_remote_source_does_not_fill_a_null_cursor_either() {
    let db = open();
    local_source_at(&db, None);
    let mut clock = local_clock(&db);
    clock["desktop"] = json!(5);
    clock["phone"] = json!(99);

    apply(&db, WORK, remote(&db, clock, "sync-token:desktop"));

    assert_eq!(column(&db, WORK), None, "this device pulls in full");
    assert!(pushed(&db, WORK)["syncCursor"].is_null());
}

#[test]
fn a_source_first_seen_from_a_remote_starts_without_a_cursor() {
    let db = open();
    local_source_at(&db, Some("sync-token:phone"));
    let mut payload = remote(&db, json!({"desktop": 1}), "sync-token:desktop");
    payload["remoteId"] = json!("team@group.calendar.google.com");
    const TEAM: &str = "google-calendar:team@group.calendar.google.com";

    apply(&db, TEAM, payload);

    assert_eq!(column(&db, TEAM), None, "this device pulls in full");
    let stored = pushed(&db, TEAM);
    assert!(stored["syncCursor"].is_null());
    assert_eq!(stored["title"], "Work (renamed on desktop)");
    assert_eq!(stored["remoteId"], "team@group.calendar.google.com");
}

#[test]
fn migration_14_resets_cursors_a_peer_pushed_back_once() {
    let mut conn = Connection::open_in_memory().expect("memory db");
    migrations::run(&mut conn, &DATA_MIGRATIONS[..13]).expect("up to 13");
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
    assert_eq!(
        migrations::run(&mut conn, DATA_MIGRATIONS).expect("to latest"),
        migrations::latest_version(DATA_MIGRATIONS)
    );

    let column = |id: &str| -> Option<String> {
        conn.query_row(
            "SELECT sync_cursor FROM calendar_sources WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .expect("column")
    };
    let payload = |id: &str| -> Value {
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
    assert_eq!(payload("i")["syncCursor"], "etag:i");
}
