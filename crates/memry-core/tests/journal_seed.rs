//! Opening a journal day from a template (spec 005-journal JP022, JP022a).
//!
//! | Test                                                   | Rule                    |
//! | ------------------------------------------------------ | ----------------------- |
//! | a new day gets content, seed, tags, properties and doc | D2, D10, §12.2 A, JP022a |
//! | a live day, here or from a peer, is never seeded again | desktop's empty-day rule |
//! | a template not on this device is NotFound              | desktop retries later    |
//! | a deleted day revives and merges                       | D5                       |
//! | a revived day with a body keeps its document           | seed an empty body only  |
//! | the weekday template wins over the default             | D9, D4                   |

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::api::errors::StorageError;
use memry_core::crdt::blocks::extract_blocks;
use memry_core::crdt::markdown_seed::seed_document;
use memry_core::crdt::registry::{Document, UpdateSink};
use memry_core::crdt::{DocumentRegistry, update_log};
use memry_core::domain::journal_ops::seed::{
    SeedOutcome, open_day_from_template, resolve_template_for,
};
use memry_core::domain::journal_rules::JournalTemplateFormatted;
use memry_core::domain::settings;
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, OptionalExtension as _};
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";
/// A Monday.
const DAY: &str = "2099-06-15";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-journal-seed-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn formatted() -> JournalTemplateFormatted {
    JournalTemplateFormatted {
        long_date: "Monday, June 15, 2099".to_owned(),
        time: "08:30".to_owned(),
        day_of_week: "Monday".to_owned(),
    }
}

fn inbound(item_type: &str, item_id: &str, payload: Value) -> sync_items::InboundRecord {
    sync_items::InboundRecord {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(3),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    }
}

/// A template as desktop writes one (`TemplateSyncPayload`).
fn daily_template(conn: &Connection) -> Result<(), StorageError> {
    sync_items::apply_remote(
        conn,
        &inbound(
            "template",
            "tpl-daily",
            json!({
                "name": "Daily",
                "description": "Morning pages",
                "icon": null,
                "content": "# {{date}}\n\n## Morning\n- [ ] \n\n## Gratitude\n1. \n2. \n",
                "tags": ["journal", "daily"],
                "properties": [
                    {"name": "mood", "type": "select", "value": "calm", "options": ["calm", "busy"]},
                    {"name": "energy", "type": "rating", "value": 4},
                    {"name": "date", "type": "date", "value": "1999-01-01"},
                    {"name": "done", "type": "checkbox"}
                ],
                "clock": {"device-b": 2},
                "createdAt": "2025-10-01T00:00:00.000Z",
                "modifiedAt": "2025-10-01T00:00:00.000Z"
            }),
        ),
        NOW,
    )?;
    Ok(())
}

fn payload_of(conn: &Connection, item_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, "journal", item_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).expect("count")
}

fn body(conn: &Connection, id: &str) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new("reader", sink)
        .get_or_open(id)
        .expect("open");
    for blob in update_log::load_plan(conn, id).expect("plan").blobs() {
        document.apply_durable_update(blob).expect("apply");
    }
    document
}

#[test]
fn a_new_day_is_created_with_the_substituted_template_and_its_document() {
    let db = open("new");
    db.call_blocking(|conn| {
        daily_template(conn)?;
        let outcome = open_day_from_template(conn, DAY, "tpl-daily", &formatted(), DEVICE, NOW)?;
        assert_eq!(
            outcome,
            SeedOutcome::Seeded {
                id: "j2099-06-15".to_owned()
            }
        );

        let markdown = "# Monday, June 15, 2099\n\n## Morning\n- [ ] \n\n## Gratitude\n1. \n2. \n";
        let stored = payload_of(conn, "j2099-06-15");
        assert_eq!(stored["date"], json!(DAY));
        assert_eq!(stored["content"], json!(markdown));
        assert_eq!(stored["tags"], json!(["journal", "daily"]));
        // D10: name → value; `date` is the journal's own and is not taken.
        assert_eq!(
            stored["properties"],
            json!({"mood": "calm", "energy": 4, "done": null})
        );
        assert_eq!(stored["clock"], json!({"device-a": 1}));

        let seed: Option<String> = conn
            .query_row(
                "SELECT seed_markdown FROM note_bodies WHERE note_id = 'j2099-06-15'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("read")
            .flatten();
        assert_eq!(seed.as_deref(), Some(markdown));

        // One record upsert and one body update, both queued.
        assert_eq!(
            count(conn, "SELECT count(*) FROM outbox WHERE op = 'upsert'"),
            1
        );
        assert_eq!(
            count(conn, "SELECT count(*) FROM outbox WHERE op = 'crdt-update'"),
            1
        );
        assert_eq!(count(conn, "SELECT count(*) FROM yjs_updates"), 1);

        let document = body(conn, "j2099-06-15");
        let kinds: Vec<String> = extract_blocks(&document)
            .expect("blocks")
            .into_iter()
            .map(|block| block.kind)
            .collect();
        assert_eq!(
            kinds,
            [
                "heading",
                "heading",
                "checkListItem",
                "heading",
                "numberedListItem",
                "paragraph"
            ]
        );
        Ok(())
    })
    .expect("the scenario");
}

#[test]
fn a_live_day_is_never_seeded_twice_even_when_a_peer_made_it() {
    let db = open("live");
    db.call_blocking(|conn| {
        daily_template(conn)?;
        open_day_from_template(conn, DAY, "tpl-daily", &formatted(), DEVICE, NOW)?;
        let queued = count(conn, "SELECT count(*) FROM outbox");
        let again = open_day_from_template(conn, DAY, "tpl-daily", &formatted(), DEVICE, NOW + 1)?;
        assert_eq!(
            again,
            SeedOutcome::AlreadyExists {
                id: "j2099-06-15".to_owned()
            }
        );
        assert_eq!(count(conn, "SELECT count(*) FROM outbox"), queued);

        // A day another device created, under its own id.
        sync_items::apply_remote(
            conn,
            &inbound(
                "journal",
                "peer-day",
                json!({"date": "2099-06-16", "content": "", "clock": {"device-b": 1}}),
            ),
            NOW,
        )?;
        let peer =
            open_day_from_template(conn, "2099-06-16", "tpl-daily", &formatted(), DEVICE, NOW)?;
        assert_eq!(
            peer,
            SeedOutcome::AlreadyExists {
                id: "peer-day".to_owned()
            }
        );
        assert_eq!(count(conn, "SELECT count(*) FROM outbox"), queued);
        assert_eq!(payload_of(conn, "peer-day")["content"], json!(""));
        Ok(())
    })
    .expect("the scenario");
}

#[test]
fn a_template_not_on_this_device_is_not_found_and_writes_nothing() {
    let db = open("missing");
    db.call_blocking(|conn| {
        let missing = open_day_from_template(conn, DAY, "tpl-later", &formatted(), DEVICE, NOW);
        assert!(
            matches!(missing, Err(StorageError::NotFound { .. })),
            "{missing:?}"
        );

        daily_template(conn)?;
        let mut deleted = inbound("template", "tpl-daily", json!({}));
        deleted.deleted_at = Some(NOW + 1);
        sync_items::apply_remote(conn, &deleted, NOW + 1)?;
        let gone = open_day_from_template(conn, DAY, "tpl-daily", &formatted(), DEVICE, NOW);
        assert!(
            matches!(gone, Err(StorageError::NotFound { .. })),
            "{gone:?}"
        );

        assert_eq!(count(conn, "SELECT count(*) FROM journal_entries"), 0);
        assert_eq!(count(conn, "SELECT count(*) FROM outbox"), 0);
        assert_eq!(count(conn, "SELECT count(*) FROM yjs_updates"), 0);
        Ok(())
    })
    .expect("the scenario");
}

#[test]
fn a_deleted_day_revives_under_its_id_and_merges_the_template() {
    let db = open("revive");
    db.call_blocking(|conn| {
        daily_template(conn)?;
        let legacy = json!({
            "date": DAY,
            "content": "",
            "tags": ["old"],
            "properties": {"mood": "tired", "weather": "rain"},
            "futureField": {"kept": true},
            "clock": {"device-b": 4}
        });
        sync_items::apply_remote(conn, &inbound("journal", "legacy-day", legacy.clone()), NOW)?;
        // The delete carries the day's last payload.
        let mut tombstone = inbound("journal", "legacy-day", legacy);
        tombstone.deleted_at = Some(NOW + 1);
        sync_items::apply_remote(conn, &tombstone, NOW + 1)?;

        let outcome =
            open_day_from_template(conn, DAY, "tpl-daily", &formatted(), DEVICE, NOW + 2)?;
        assert_eq!(
            outcome,
            SeedOutcome::Revived {
                id: "legacy-day".to_owned()
            }
        );
        let stored = payload_of(conn, "legacy-day");
        assert!(
            stored["content"]
                .as_str()
                .is_some_and(|c| c.starts_with("# Monday"))
        );
        assert_eq!(stored["tags"], json!(["old", "journal", "daily"]));
        assert_eq!(
            stored["properties"],
            json!({"mood": "calm", "weather": "rain", "energy": 4, "done": null})
        );
        assert_eq!(stored["futureField"], json!({"kept": true}));
        // The body was empty, so it is seeded.
        assert_eq!(
            count(conn, "SELECT count(*) FROM outbox WHERE op = 'crdt-update'"),
            1
        );
        Ok(())
    })
    .expect("the scenario");
}

#[test]
fn a_revived_day_that_already_has_a_body_keeps_its_document() {
    let db = open("revive-body");
    db.call_blocking(|conn| {
        daily_template(conn)?;
        sync_items::apply_remote(
            conn,
            &inbound(
                "journal",
                "j2099-06-15",
                json!({"date": DAY, "clock": {"device-b": 1}}),
            ),
            NOW,
        )?;
        // The body a peer wrote before the day was deleted.
        let sink: UpdateSink = Arc::new(|_, _| {});
        let written = DocumentRegistry::new("device-b", sink)
            .get_or_open("j2099-06-15")
            .expect("open");
        seed_document(&written, "Written by hand").expect("seed");
        let bytes = written.encode_state().expect("encode");
        update_log::append_server_update(conn, "j2099-06-15", 1, &bytes, NOW).expect("store");
        let mut tombstone = inbound("journal", "j2099-06-15", json!({"date": DAY}));
        tombstone.deleted_at = Some(NOW + 1);
        sync_items::apply_remote(conn, &tombstone, NOW + 1)?;

        let outcome =
            open_day_from_template(conn, DAY, "tpl-daily", &formatted(), DEVICE, NOW + 2)?;
        assert!(matches!(outcome, SeedOutcome::Revived { .. }));
        assert_eq!(
            count(conn, "SELECT count(*) FROM outbox WHERE op = 'crdt-update'"),
            0
        );
        let blocks = extract_blocks(&body(conn, "j2099-06-15")).expect("blocks");
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].inline[0].text, "Written by hand");
        Ok(())
    })
    .expect("the scenario");
}

#[test]
fn an_empty_template_creates_the_day_without_a_document() {
    let db = open("empty");
    db.call_blocking(|conn| {
        sync_items::apply_remote(
            conn,
            &inbound(
                "template",
                "tpl-empty",
                json!({"name": "Blank", "content": ""}),
            ),
            NOW,
        )?;
        let outcome = open_day_from_template(conn, DAY, "tpl-empty", &formatted(), DEVICE, NOW)?;
        assert!(matches!(outcome, SeedOutcome::Seeded { .. }));
        assert_eq!(payload_of(conn, "j2099-06-15")["content"], json!(""));
        assert_eq!(count(conn, "SELECT count(*) FROM yjs_updates"), 0);
        Ok(())
    })
    .expect("the scenario");
}

#[test]
fn the_weekday_template_wins_over_the_default() {
    let db = open("resolve");
    db.call_blocking(|conn| {
        assert_eq!(resolve_template_for(conn, DAY)?, None);
        settings::set(
            conn,
            "journal.defaultTemplate",
            json!("tpl-default"),
            DEVICE,
            NOW,
        )?;
        assert_eq!(
            resolve_template_for(conn, DAY)?.as_deref(),
            Some("tpl-default")
        );

        settings::set(
            conn,
            "journal.weekdayTemplates",
            json!({"1": "tpl-monday", "2": null, "7": "tpl-bogus"}),
            DEVICE,
            NOW + 1,
        )?;
        assert_eq!(
            resolve_template_for(conn, DAY)?.as_deref(),
            Some("tpl-monday")
        );
        // Tuesday's explicit null falls back to the default.
        assert_eq!(
            resolve_template_for(conn, "2099-06-16")?.as_deref(),
            Some("tpl-default")
        );
        assert!(resolve_template_for(conn, "2099-02-30").is_err());
        Ok(())
    })
    .expect("the scenario");
}
