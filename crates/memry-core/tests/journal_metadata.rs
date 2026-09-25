//! Journal metadata writes addressed by date (JP021, D2, D5).
//!
//! | Test                                               | Rule                    |
//! | -------------------------------------------------- | ----------------------- |
//! | a first tag creates the day in the schema's shape  | D2, D5 create           |
//! | an update writes content null and keeps the date   | D5 update               |
//! | an older desktop payload takes a phone tag write   | D5, existing id wins    |
//! | unknown keys survive the next phone edit           | D5, §13.2 rule 3        |
//! | the date property is reserved                      | D5                      |
//! | a write equal to the stored value writes nothing   | no clock tick, no push  |
//! | a retype is refused and a tombstone revives        | FR-048, D2              |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::api::errors::StorageError;
use memry_core::domain::journal_ops::metadata;
use memry_core::domain::properties::PropertyError;
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";
const DAY: &str = "2099-06-15";

/// `JournalSyncPayloadSchema` (`packages/contracts/src/sync-payloads.ts:279`).
const SCHEMA_KEYS: [&str; 7] = [
    "date",
    "content",
    "tags",
    "properties",
    "clock",
    "createdAt",
    "modifiedAt",
];

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-journal-metadata-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn payload_of(conn: &Connection, item_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, "journal", item_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn raw_of(conn: &Connection, item_id: &str) -> String {
    sync_items::push_payload(conn, "journal", item_id)
        .expect("read the row")
        .expect("a payload")
}

fn queued(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
        .expect("count")
}

fn journal_rows(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM sync_items WHERE item_type = 'journal'",
        [],
        |row| row.get(0),
    )
    .expect("count")
}

fn remote(item_id: &str, payload: Value) -> sync_items::InboundRecord {
    sync_items::InboundRecord {
        item_type: "journal".to_owned(),
        item_id: item_id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(9),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    }
}

/// Every key is a schema field, each with the schema's type.
fn assert_schema_shape(payload: &Value) {
    let object = payload.as_object().expect("an object");
    for key in object.keys() {
        assert!(
            SCHEMA_KEYS.contains(&key.as_str()),
            "unexpected key `{key}`"
        );
    }
    assert!(object["date"].is_string());
    assert!(object["content"].is_string() || object["content"].is_null());
    if let Some(tags) = object.get("tags") {
        assert!(
            tags.as_array()
                .expect("tags array")
                .iter()
                .all(Value::is_string)
        );
    }
    if let Some(properties) = object.get("properties") {
        assert!(properties.is_object() || properties.is_null());
    }
    let clock = object["clock"].as_object().expect("clock object");
    assert!(clock.values().all(Value::is_u64));
    assert!(object["createdAt"].is_string());
    assert!(object["modifiedAt"].is_string());
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[test]
fn a_first_tag_creates_the_day_and_an_update_writes_content_null() {
    let db = open("create");
    db.call_blocking(|conn| {
        let tags = metadata::set_tags(conn, DAY, &strings(&["Work", "work", "Home"]), DEVICE, NOW)?;
        assert_eq!(tags, strings(&["Work", "Home"]));

        let created = payload_of(conn, "j2099-06-15");
        assert_schema_shape(&created);
        assert_eq!(created["date"], json!(DAY));
        assert_eq!(created["content"], json!(""), "create keeps content");
        assert_eq!(created["tags"], json!(["Work", "Home"]));
        assert_eq!(created["clock"], json!({"device-a": 1}));
        assert_eq!(created["createdAt"], json!("2025-10-09T08:53:20.000Z"));
        assert_eq!(queued(conn), 1, "create and first write push once");

        let tag_rows: i64 = conn
            .query_row(
                "SELECT count(*) FROM note_tags WHERE note_id = 'j2099-06-15'",
                [],
                |row| row.get(0),
            )
            .expect("tags projection");
        assert_eq!(tag_rows, 2);

        let values = metadata::set_property(conn, DAY, "mood", json!("calm"), DEVICE, NOW + 5)
            .expect("set property");
        assert_eq!(
            values,
            json!({"mood": "calm"}).as_object().cloned().expect("map")
        );

        let updated = payload_of(conn, "j2099-06-15");
        assert_schema_shape(&updated);
        assert_eq!(updated["content"], Value::Null, "D5: update carries null");
        assert_eq!(updated["date"], json!(DAY));
        assert_eq!(updated["properties"], json!({"mood": "calm"}));
        assert_eq!(updated["tags"], json!(["Work", "Home"]));
        assert_eq!(updated["clock"], json!({"device-a": 2}));
        assert_eq!(updated["createdAt"], json!("2025-10-09T08:53:20.000Z"));
        assert_eq!(updated["modifiedAt"], json!("2025-10-09T08:53:20.005Z"));
        assert_eq!(queued(conn), 1, "the outbox row coalesces per item");

        let projected: String = conn
            .query_row(
                "SELECT properties FROM journal_entries WHERE id = 'j2099-06-15'",
                [],
                |row| row.get(0),
            )
            .expect("projection");
        assert_eq!(projected, r#"{"mood":"calm"}"#);
        Ok(())
    })
    .expect("create");
}

#[test]
fn an_older_desktop_payload_without_tags_or_properties_takes_a_phone_tag_write() {
    let db = open("older");
    db.call_blocking(|conn| {
        let older = json!({"date": DAY, "content": "# body", "clock": {"device-b": 4},
            "createdAt": "2099-06-15T08:00:00.000Z", "modifiedAt": "2099-06-15T08:00:00.000Z"});
        sync_items::apply_remote(conn, &remote("desktop-day", older), NOW)?;

        metadata::set_tags(conn, DAY, &strings(&["inbox"]), DEVICE, NOW + 1)?;
        let payload = payload_of(conn, "desktop-day");
        assert_schema_shape(&payload);
        assert_eq!(payload["tags"], json!(["inbox"]));
        assert_eq!(payload["content"], Value::Null);
        assert_eq!(payload["clock"], json!({"device-a": 1, "device-b": 4}));
        assert!(
            payload.get("properties").is_none(),
            "no properties key grown"
        );
        assert!(sync_items::load(conn, "journal", "j2099-06-15")?.is_none());

        let values = metadata::set_property(conn, DAY, "energy", json!(3), DEVICE, NOW + 2)
            .expect("property on a payload with none");
        assert_eq!(values["energy"], json!(3));
        assert_eq!(
            payload_of(conn, "desktop-day")["properties"],
            json!({"energy": 3})
        );
        Ok(())
    })
    .expect("older");
}

#[test]
fn unknown_keys_and_the_stored_date_property_survive_the_next_phone_edit() {
    let db = open("newer");
    db.call_blocking(|conn| {
        let newer = json!({"date": DAY, "content": null, "tags": ["Deep"], "pinnedTags": ["Deep"],
            "properties": {"date": DAY, "mood": "ok"}, "clock": {"device-b": 2},
            "createdAt": "2099-06-15T08:00:00.000Z", "modifiedAt": "2099-06-15T08:00:00.000Z",
            "weather": {"sky": "clear"}, "futureField": 7});
        sync_items::apply_remote(conn, &remote("j2099-06-15", newer), NOW)?;

        let values =
            metadata::set_property(conn, DAY, "energy", json!(2), DEVICE, NOW + 1).expect("set");
        assert!(!values.contains_key("date"), "reads never expose `date`");
        let payload = payload_of(conn, "j2099-06-15");
        assert_eq!(payload["weather"], json!({"sky": "clear"}));
        assert_eq!(payload["futureField"], json!(7));
        assert_eq!(
            payload["properties"],
            json!({"date": DAY, "mood": "ok", "energy": 2})
        );

        metadata::set_tags(conn, DAY, &strings(&["Light"]), DEVICE, NOW + 2)?;
        let payload = payload_of(conn, "j2099-06-15");
        assert_eq!(payload["tags"], json!(["Light"]));
        assert_eq!(payload["pinnedTags"], json!([]), "a dropped tag unpins");
        assert_eq!(payload["weather"], json!({"sky": "clear"}));
        assert_eq!(payload["futureField"], json!(7));
        assert_eq!(payload["clock"], json!({"device-a": 2, "device-b": 2}));
        Ok(())
    })
    .expect("newer");
}

#[test]
fn the_date_property_is_reserved_and_refused_before_anything_is_written() {
    let db = open("reserved");
    db.call_blocking(|conn| {
        let invalid = |error: &StorageError| matches!(error, StorageError::Invalid { .. });
        assert!(matches!(
            metadata::set_property(conn, DAY, "date", json!("x"), DEVICE, NOW),
            Err(PropertyError::Storage(StorageError::Invalid { .. }))
        ));
        assert!(matches!(
            metadata::clear_property(conn, DAY, "date", DEVICE, NOW),
            Err(PropertyError::Storage(StorageError::Invalid { .. }))
        ));
        assert!(
            metadata::remove_property(conn, DAY, "date", DEVICE, NOW)
                .is_err_and(|error| invalid(&error))
        );
        assert!(
            metadata::rename_property(conn, DAY, "date", "day", DEVICE, NOW)
                .is_err_and(|error| invalid(&error))
        );
        assert!(
            metadata::rename_property(conn, DAY, "mood", "date", DEVICE, NOW)
                .is_err_and(|error| invalid(&error))
        );
        assert_eq!(journal_rows(conn), 0);
        assert_eq!(queued(conn), 0);
        Ok(())
    })
    .expect("reserved");
}

#[test]
fn an_empty_write_on_an_absent_day_creates_nothing() {
    let db = open("absent");
    db.call_blocking(|conn| {
        assert!(metadata::set_tags(conn, DAY, &[], DEVICE, NOW)?.is_empty());
        assert!(
            metadata::clear_property(conn, DAY, "mood", DEVICE, NOW)
                .expect("clear")
                .is_empty()
        );
        assert!(metadata::remove_property(conn, DAY, "mood", DEVICE, NOW)?.is_empty());
        assert!(matches!(
            metadata::rename_property(conn, DAY, "mood", "feel", DEVICE, NOW),
            Err(StorageError::NotFound { .. })
        ));
        assert_eq!(journal_rows(conn), 0);
        assert_eq!(queued(conn), 0);
        Ok(())
    })
    .expect("absent");
}

#[test]
fn a_write_equal_to_the_stored_value_writes_nothing() {
    let db = open("no-op");
    db.call_blocking(|conn| {
        let stored = json!({"date": DAY, "content": null, "tags": ["Work"],
            "properties": {"mood": "ok"}, "clock": {"device-b": 3},
            "createdAt": "2099-06-15T08:00:00.000Z", "modifiedAt": "2099-06-15T08:00:00.000Z"});
        sync_items::apply_remote(conn, &remote("j2099-06-15", stored), NOW)?;
        let before = raw_of(conn, "j2099-06-15");

        metadata::set_tags(conn, DAY, &strings(&["Work", "work"]), DEVICE, NOW + 1)?;
        metadata::set_property(conn, DAY, "mood", json!("ok"), DEVICE, NOW + 1).expect("same");
        metadata::remove_property(conn, DAY, "missing", DEVICE, NOW + 1)?;
        metadata::rename_property(conn, DAY, "mood", "mood", DEVICE, NOW + 1)?;

        assert_eq!(
            raw_of(conn, "j2099-06-15"),
            before,
            "no clock tick, no rewrite"
        );
        assert_eq!(queued(conn), 0, "no outbox row");
        Ok(())
    })
    .expect("no-op");
}

#[test]
fn rename_keeps_the_value_and_clear_and_remove_differ() {
    let db = open("rename");
    db.call_blocking(|conn| {
        metadata::set_property(conn, DAY, "mood", json!("calm"), DEVICE, NOW).expect("set");
        metadata::set_property(conn, DAY, "energy", json!(4), DEVICE, NOW).expect("set");

        let values = metadata::rename_property(conn, DAY, "mood", "feeling", DEVICE, NOW + 1)?;
        assert_eq!(
            values,
            json!({"feeling": "calm", "energy": 4})
                .as_object()
                .cloned()
                .expect("map")
        );
        assert!(matches!(
            metadata::rename_property(conn, DAY, "feeling", "energy", DEVICE, NOW + 2),
            Err(StorageError::Invalid { .. })
        ));

        metadata::clear_property(conn, DAY, "feeling", DEVICE, NOW + 3).expect("clear");
        metadata::remove_property(conn, DAY, "energy", DEVICE, NOW + 4)?;
        let payload = payload_of(conn, "j2099-06-15");
        assert_eq!(payload["properties"], json!({"feeling": null}));
        assert_eq!(payload["content"], Value::Null);
        Ok(())
    })
    .expect("rename");
}

#[test]
fn a_retype_is_refused_and_a_tombstoned_day_revives_under_its_id() {
    let db = open("retype");
    db.call_blocking(|conn| {
        let stored = json!({"date": DAY, "properties": {"energy": 3}, "clock": {"device-b": 1}});
        let mut tombstone = remote("desktop-day", stored);
        tombstone.deleted_at = Some(NOW);
        sync_items::apply_remote(conn, &tombstone, NOW)?;

        let refused = metadata::set_property(conn, DAY, "energy", json!("high"), DEVICE, NOW + 1);
        assert!(matches!(refused, Err(PropertyError::Retyped { .. })));
        assert!(
            sync_items::load(conn, "journal", "desktop-day")?
                .expect("the row")
                .deleted_at
                .is_some(),
            "a refused write rolls the revive back"
        );
        assert_eq!(queued(conn), 0);

        metadata::set_tags(conn, DAY, &strings(&["back"]), DEVICE, NOW + 2)?;
        let row = sync_items::load(conn, "journal", "desktop-day")?.expect("the row");
        assert!(row.deleted_at.is_none());
        let payload = payload_of(conn, "desktop-day");
        assert_eq!(payload["tags"], json!(["back"]));
        assert_eq!(payload["content"], Value::Null);
        assert_eq!(payload["clock"], json!({"device-a": 1, "device-b": 1}));
        assert!(sync_items::load(conn, "journal", "j2099-06-15")?.is_none());
        assert_eq!(queued(conn), 1);
        Ok(())
    })
    .expect("retype");
}
