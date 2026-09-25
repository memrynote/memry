//! The exported `Journal` surface end to end (spec 005-journal JP028).
//!
//! Real SQLite and a real in-memory secure store, driven only through
//! `Vault::journal` and the other exported objects, plus inbound records the
//! way a pull applies them: an older desktop payload (no tags, no
//! properties) and a newer one (unknown keys) whose extra keys survive the
//! next phone edit.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::api::errors::{SecureStoreError, StorageError};
use memry_core::api::journal::{Journal, SeedOutcome};
use memry_core::api::journal_records::{JournalBody, JournalTemplateStrings};
use memry_core::api::vault::Vault;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Value, json};

static SCRATCH: AtomicU64 = AtomicU64::new(0);
const TODAY: &str = "2099-06-15";

struct MemoryStore(Mutex<HashMap<String, Vec<u8>>>);

impl MemoryStore {
    fn registered() -> Arc<dyn SecureStore> {
        let mut secret = vec![7u8; 32];
        secret.extend_from_slice(&[9u8; 32]);
        Arc::new(Self(Mutex::new(HashMap::from([(
            format!("{:?}", SecureStoreKey::DeviceSigningKey),
            secret,
        )]))))
    }
}

impl SecureStore for MemoryStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self
            .0
            .lock()
            .expect("lock")
            .get(&format!("{key:?}"))
            .cloned())
    }
    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.0
            .lock()
            .expect("lock")
            .insert(format!("{key:?}"), value);
        Ok(())
    }
    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.0.lock().expect("lock").remove(&format!("{key:?}"));
        Ok(())
    }
    fn clear(&self) -> Result<(), SecureStoreError> {
        self.0.lock().expect("lock").clear();
        Ok(())
    }
}

fn open(label: &str) -> (PathBuf, Vault, Arc<Journal>) {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-api-journal-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let journal = vault.journal(MemoryStore::registered()).expect("journal");
    (dir, vault, journal)
}

fn behind(dir: &Path) -> Db {
    open_data(&dir.join("data.db")).expect("second open")
}

fn payload(db: &Db, id: &str) -> Value {
    let id = id.to_owned();
    let raw = db
        .call_blocking(move |conn: &mut Connection| sync_items::push_payload(conn, "journal", &id))
        .expect("read")
        .expect("a payload");
    serde_json::from_str(&raw).expect("json")
}

fn count(db: &Db, sql: &'static str) -> i64 {
    db.call_blocking(move |conn: &mut Connection| {
        conn.query_row(sql, [], |row| row.get::<_, i64>(0))
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
    })
    .expect("count")
}

fn inbound(db: &Db, item_type: &'static str, id: &'static str, body: Value) {
    db.call_blocking(move |conn: &mut Connection| {
        sync_items::apply_remote(
            conn,
            &sync_items::InboundRecord {
                item_type: item_type.to_owned(),
                item_id: id.to_owned(),
                payload_json: body.to_string(),
                server_cursor: Some(5),
                signer_device_id: Some("desktop".to_owned()),
                updated_at: 1_760_000_000_000,
                deleted_at: None,
            },
            1_760_000_000_000,
        )?;
        Ok(())
    })
    .expect("apply inbound");
}

fn text_of(block: &memry_core::crdt::blocks::Block) -> String {
    block.inline.iter().map(|run| run.text.as_str()).collect()
}

fn paragraph(text: &str, id: &str) -> BlockEdit {
    BlockEdit::InsertParagraph {
        after_block_id: None,
        text: text.to_owned(),
        new_block_id: id.to_owned(),
    }
}

#[test]
fn reading_a_day_writes_nothing_and_the_first_edit_creates_it() {
    let (dir, vault, journal) = open("first-edit");
    assert_eq!(journal.day(TODAY.into()).expect("day"), None);
    assert!(
        journal
            .month(2099, 6, TODAY.into())
            .expect("month")
            .days
            .len()
            == 30
    );
    assert_eq!(count(&behind(&dir), "SELECT COUNT(*) FROM outbox"), 0);

    let edit = journal
        .edit_day(TODAY.into(), paragraph("Walked to the lake.", "b1"))
        .expect("edit");
    assert!(edit.created && edit.changed);
    assert_eq!(edit.id, "j2099-06-15");

    let day = journal.day(TODAY.into()).expect("day").expect("a day now");
    assert_eq!(day.body, JournalBody::Present);
    assert_eq!(day.word_count, 4);
    let blocks = vault
        .notes()
        .blocks(day.id.clone())
        .expect("blocks")
        .expect("some");
    assert!(
        blocks
            .iter()
            .any(|block| text_of(block).contains("Walked to the lake."))
    );

    let month = journal.month(2099, 6, TODAY.into()).expect("month");
    assert_eq!(month.entry_count, 1);
    let today = month
        .days
        .iter()
        .find(|d| d.date == TODAY)
        .expect("today row");
    assert!(today.is_today && today.has_entry && today.level == 1);
    assert_eq!(today.preview, "Walked to the lake.");
    assert_eq!(journal.streak(TODAY.into()).expect("streak").current, 1);
    let year = journal.year(2099, TODAY.into()).expect("year");
    assert_eq!(year.days_with_entries, 1);
    assert_eq!(year.months[5].entry_count, 1);
}

#[test]
fn tags_properties_and_reminders_go_through_the_api() {
    let (dir, _vault, journal) = open("meta");
    journal
        .set_tags(TODAY.into(), vec!["calm".into(), "lake".into()])
        .expect("tags");
    journal
        .set_property(TODAY.into(), "mood".into(), "\"calm\"".into())
        .expect("property");
    assert!(
        journal
            .set_property(TODAY.into(), "date".into(), "\"2000-01-01\"".into())
            .is_err(),
        "the date property is reserved"
    );

    let stored = payload(&behind(&dir), "j2099-06-15");
    assert_eq!(
        stored["content"],
        Value::Null,
        "an update carries content: null"
    );
    assert_eq!(stored["tags"], json!(["calm", "lake"]));
    assert_eq!(stored["properties"]["mood"], json!("calm"));
    let day = journal.day(TODAY.into()).expect("day").expect("day");
    assert!(day.properties.iter().all(|p| p.name != "date"));

    let first = journal
        .set_reminder(TODAY.into(), "2099-06-22T09:00:00.000Z".into(), None)
        .expect("remind");
    let moved = journal
        .set_reminder(
            TODAY.into(),
            "2099-07-15T09:00:00.000Z".into(),
            Some("look back".into()),
        )
        .expect("move");
    assert_eq!(first, moved, "set-or-replace moves the active reminder");
    let listed = journal.reminders(TODAY.into()).expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].date, TODAY);
    assert_eq!(listed[0].note.as_deref(), Some("look back"));
    journal.dismiss_reminder(moved).expect("dismiss");
    assert!(!journal.reminders(TODAY.into()).expect("list")[0].is_active);
}

#[test]
fn a_template_seeds_an_empty_day_once() {
    let (dir, vault, journal) = open("seed");
    inbound(
        &behind(&dir),
        "template",
        "tpl-daily",
        json!({
            "name": "Agent Test Daily",
            "content": "# {{date}}\n\n## Morning\n- [ ] \n",
            "tags": ["daily"],
            "properties": [{"name": "mood", "type": "text", "value": "calm"}],
            "clock": {"desktop": 1},
            "createdAt": "2099-01-01T00:00:00.000Z",
            "modifiedAt": "2099-01-01T00:00:00.000Z"
        }),
    );
    journal
        .set_default_template(Some("tpl-daily".into()))
        .expect("default");
    assert_eq!(
        journal.template_for(TODAY.into()).expect("resolve"),
        Some("tpl-daily".into())
    );

    let strings = JournalTemplateStrings {
        long_date: "Monday, June 15, 2099".into(),
        time: "9:05 AM".into(),
        day_of_week: "Monday".into(),
    };
    let seeded = journal
        .seed_from_template(TODAY.into(), "tpl-daily".into(), strings.clone())
        .expect("seed");
    assert_eq!(
        seeded,
        SeedOutcome::Seeded {
            id: "j2099-06-15".into()
        }
    );
    let again = journal
        .seed_from_template(TODAY.into(), "tpl-daily".into(), strings.clone())
        .expect("seed again");
    assert_eq!(
        again,
        SeedOutcome::AlreadyExists {
            id: "j2099-06-15".into()
        }
    );

    let blocks = vault
        .notes()
        .blocks("j2099-06-15".into())
        .expect("blocks")
        .expect("some");
    assert!(
        blocks
            .iter()
            .any(|b| text_of(b).contains("Monday, June 15, 2099"))
    );
    let stored = payload(&behind(&dir), "j2099-06-15");
    assert_eq!(stored["tags"], json!(["daily"]));
    assert_eq!(stored["properties"]["mood"], json!("calm"));

    assert!(matches!(
        journal.seed_from_template("2099-06-16".into(), "not-here".into(), strings),
        Err(StorageError::NotFound { .. })
    ));
    assert_eq!(journal.day("2099-06-16".into()).expect("day"), None);
}

#[test]
fn an_older_desktop_payload_is_edited_under_its_own_id() {
    let (dir, _vault, journal) = open("older");
    inbound(
        &behind(&dir),
        "journal",
        "legacy-day-id",
        json!({"date": TODAY, "clock": {"desktop": 3}}),
    );
    journal
        .set_tags(TODAY.into(), vec!["phone".into()])
        .expect("tags on an older payload");
    let stored = payload(&behind(&dir), "legacy-day-id");
    assert_eq!(stored["tags"], json!(["phone"]));
    assert_eq!(stored["clock"]["desktop"], json!(3));
    assert_eq!(
        journal.entry_id(TODAY.into()).expect("id"),
        Some("legacy-day-id".into())
    );
}

#[test]
fn a_newer_payload_keeps_its_unknown_keys_through_a_phone_edit() {
    let (dir, _vault, journal) = open("newer");
    inbound(
        &behind(&dir),
        "journal",
        "j2099-06-15",
        json!({
            "date": TODAY,
            "content": "",
            "tags": ["desk"],
            "properties": {"mood": "busy"},
            "futureField": {"kept": true},
            "clock": {"desktop": 2},
            "createdAt": "2099-06-15T08:00:00.000Z",
            "modifiedAt": "2099-06-15T08:00:00.000Z"
        }),
    );
    journal
        .set_property(TODAY.into(), "mood".into(), "\"calm\"".into())
        .expect("edit");
    let stored = payload(&behind(&dir), "j2099-06-15");
    assert_eq!(stored["futureField"], json!({"kept": true}));
    assert_eq!(stored["properties"]["mood"], json!("calm"));
    assert_eq!(stored["tags"], json!(["desk"]));
}

#[test]
fn settings_round_trip_per_weekday() {
    let (_dir, _vault, journal) = open("settings");
    let set = journal
        .set_weekday_template(6, Some("tpl-sat".into()))
        .expect("saturday");
    assert_eq!(set.weekday_templates.len(), 7);
    assert_eq!(set.weekday_templates[6].as_deref(), Some("tpl-sat"));
    let cleared = journal.set_weekday_template(6, None).expect("clear");
    assert_eq!(cleared.weekday_templates[6], None);
    assert!(journal.set_weekday_template(7, None).is_err());
}
