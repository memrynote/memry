//! The journal service's day writes (Step 13m-2, #3530) under the running vault tier: a day's
//! first write makes the record, the row, then the file Electron's `createJournalEntry` writes
//! (`tests/fixtures/electron-journal`, from `scripts/electron-fixtures/capture-journal.mjs`),
//! and seeds the day's body from it; a day that has a file is never written over; a failure
//! takes back what the create made; a read takes the day's row and record; a delete removes the
//! file, then tombstones the day.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::journal::write::NewDay;
use memry_desktop::journal::{JournalEntryView, entry};
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use memry_desktop::vault::hash::content_hash;
use serde_json::json;
use vault_env::{Env, env, indexed};

const NEW_FILE: &str = include_str!("fixtures/electron-journal/new.md");
const BARE_FILE: &str = include_str!("fixtures/electron-journal/bare.md");
const DAY: &str = "2025-01-17";
const DAY_FILE: &str = "journal/2025-01-17.md";

fn opened() -> (Env, Arc<NotesService>, Arc<dyn SecureStore>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.open();
    e.facts_until(indexed);
    let store = kept.expect("the store");
    let notes = NotesService::new(e.tier.clone(), store.clone());
    (e, notes, store)
}

/// The input `new.md` was written from.
fn new_day() -> NewDay {
    NewDay {
        date: DAY.into(),
        content: "Morning pages.\n\n- [ ] call Ann".into(),
        tags: vec!["work".into(), "Ideas".into()],
        properties: json!({ "mood": "calm", "rating": 4 })
            .as_object()
            .unwrap()
            .clone(),
    }
}

/// `(deleted, tags, properties)` of the day's record, `None` without one.
fn record(e: &Env, id: &str) -> Option<(bool, String, Option<String>)> {
    let id = id.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT deleted_at IS NOT NULL, json_extract(payload, '$.tags'),
                            json_extract(payload, '$.properties')
                       FROM sync_items WHERE item_type = 'journal' AND item_id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .ok())
        })
        .unwrap()
}

/// The outbox operations queued for `id`.
fn queued(e: &Env, id: &str) -> Vec<String> {
    let id = id.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            let mut statement = conn
                .prepare("SELECT op FROM outbox WHERE item_type = 'journal' AND item_id = ?1")
                .unwrap();
            Ok(statement
                .query_map([id], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<String>, _>>()
                .unwrap())
        })
        .unwrap()
}

/// The row's content hash for `id`.
fn row_hash(e: &Env, id: &str) -> Option<String> {
    e.core()
        .note_files()
        .by_id(id)
        .unwrap()
        .and_then(|row| row.content_hash)
}

/// What the watcher reported once things went quiet: anything but the app's own facts.
fn outside_facts(e: &mut Env) -> Vec<Applied> {
    std::thread::sleep(vault_env::QUIET);
    e.drain()
        .into_iter()
        .filter(|fact| match fact {
            Applied::Added { source, .. }
            | Applied::Changed { source, .. }
            | Applied::Removed { source, .. } => *source != ChangeSource::App,
            _ => false,
        })
        .collect()
}

fn read(e: &Env, journal: &memry_core::api::journal::Journal) -> Option<JournalEntryView> {
    entry(&e.session.current().unwrap(), journal, DAY).unwrap()
}

#[test]
fn a_new_day_writes_the_file_electron_writes_then_seeds_its_body_from_it() {
    let (mut e, notes, store) = opened();
    let open = e.session.current().unwrap();
    let journal = open.vault.journal(store).unwrap();
    assert_eq!(read(&e, &journal), None, "browsing a day makes nothing");

    let made = notes.create_day(&open, new_day()).unwrap();
    assert_eq!(e.read(DAY_FILE), NEW_FILE, "the bytes Electron writes");
    assert_eq!(made.id, "j2025-01-17");
    assert_eq!(made.content, "Morning pages.\n\n- [ ] call Ann");
    assert_eq!(made.tags, ["work", "Ideas"]);
    assert_eq!(
        made.properties,
        json!({ "mood": "calm", "rating": 4 }).as_object().cloned()
    );
    assert_eq!((made.word_count, made.character_count), (7, 30));
    assert_eq!(
        record(&e, "j2025-01-17"),
        Some((
            false,
            r#"["work","Ideas"]"#.to_owned(),
            Some(r#"{"mood":"calm","rating":4}"#.to_owned())
        ))
    );
    assert_eq!(
        queued(&e, "j2025-01-17"),
        ["upsert", "crdt-update"],
        "the record and the body it took from the file"
    );
    assert_eq!(
        row_hash(&e, "j2025-01-17"),
        Some(content_hash(NEW_FILE)),
        "the row names the bytes its body took"
    );
    assert_eq!(e.body("j2025-01-17"), "Morning pages.\ncall Ann");
    assert_eq!(
        read(&e, &journal),
        Some(made),
        "a read answers as the create did"
    );
    assert_eq!(
        outside_facts(&mut e),
        [],
        "the watcher reports no outside change"
    );
    assert_eq!(
        e.read(DAY_FILE),
        NEW_FILE,
        "and the write-back leaves the file as it is"
    );
}

#[test]
fn an_empty_day_writes_only_its_date() {
    let (e, notes, _) = opened();
    let open = e.session.current().unwrap();
    let day = NewDay {
        date: "2025-01-18".into(),
        ..NewDay::default()
    };
    let made = notes.create_day(&open, day).unwrap();
    assert_eq!(e.read("journal/2025-01-18.md"), BARE_FILE);
    assert_eq!((made.content.as_str(), made.properties), ("", None));
}

#[test]
fn a_day_that_has_a_file_is_never_written_over() {
    let (mut e, notes, _) = opened();
    let open = e.session.current().unwrap();
    e.write(DAY_FILE, "Written elsewhere.\n");
    e.facts_until(|fact| matches!(fact, Applied::Added { path, .. } if path == DAY_FILE));
    let before = queued(&e, "j2025-01-17");
    let row_before = row_hash(&e, "j2025-01-17");
    assert!(row_before.is_some());

    let answered = notes.create_day(&open, new_day()).unwrap();
    assert_eq!(e.read(DAY_FILE), "Written elsewhere.\n");
    assert_eq!(answered.id, "j2025-01-17");
    assert_eq!(answered.content, "Written elsewhere.");
    assert_eq!(
        answered.tags,
        Vec::<String>::new(),
        "the record's tags, not the input's"
    );
    assert_eq!(
        queued(&e, "j2025-01-17"),
        before,
        "the create wrote nothing"
    );
    assert_eq!(
        (e.rows(), row_hash(&e, "j2025-01-17")),
        (
            vec![("j2025-01-17".to_owned(), DAY_FILE.to_owned())],
            row_before
        ),
        "and left the day's row as it was"
    );
}

#[test]
fn a_file_no_row_names_yet_is_answered_and_left_to_the_identity() {
    let (mut e, notes, _) = opened();
    let open = e.session.current().unwrap();
    // Written right before the create: the watcher may not have reported it yet.
    e.write(DAY_FILE, "Raced in.\n");
    let answered = notes.create_day(&open, new_day()).unwrap();
    assert_eq!(e.read(DAY_FILE), "Raced in.\n");
    assert_eq!(answered.content, "Raced in.");
    e.facts_until(|fact| matches!(fact, Applied::Added { path, .. } if path == DAY_FILE));
    assert_eq!(
        e.rows(),
        [("j2025-01-17".to_owned(), DAY_FILE.to_owned())],
        "the identity makes the file the day"
    );
    assert_eq!(e.body("j2025-01-17"), "Raced in.");
}

#[test]
fn a_failure_after_the_file_takes_back_the_file_the_row_and_the_record() {
    let (mut e, notes, _) = opened();
    let open = e.session.current().unwrap();
    let failed = notes.create_day_checked(&open, new_day(), &mut || {
        Err(NotesError::NotFound("seed".into()))
    });
    assert!(matches!(failed, Err(NotesError::NotFound(_))), "{failed:?}");
    assert!(!e.vault.join(DAY_FILE).exists(), "the file is taken back");
    assert_eq!(e.rows(), [], "and the row");
    assert_eq!(
        record(&e, "j2025-01-17").map(|r| r.0),
        Some(true),
        "and the record"
    );
    assert_eq!(queued(&e, "j2025-01-17"), ["delete"]);
    assert_eq!(outside_facts(&mut e), []);
}

#[test]
fn a_read_takes_the_days_row_and_its_records_tags() {
    let (e, notes, store) = opened();
    let open = e.session.current().unwrap();
    notes.create_day(&open, new_day()).unwrap();
    let journal = open.vault.journal(store).unwrap();
    journal
        .set_tags(DAY.into(), vec!["moved-on".into()])
        .unwrap();
    // The config now names another path; the day's file is where its row says.
    e.write(
        ".memry/config.json",
        r#"{"journalFolder":"daily","journalDateFormat":"YYYY-MM-DD"}"#,
    );
    let day = read(&e, &journal).expect("the day");
    assert_eq!(day.tags, ["moved-on"]);
    assert_eq!(day.content, "Morning pages.\n\n- [ ] call Ann");
    assert_eq!(
        e.read(DAY_FILE),
        NEW_FILE,
        "a tag edit never reaches the file"
    );
}

#[test]
fn a_delete_removes_the_file_then_tombstones_the_day() {
    let (mut e, notes, store) = opened();
    let open = e.session.current().unwrap();
    notes.create_day(&open, new_day()).unwrap();
    e.drain();

    assert!(notes.delete_day(&open, DAY).unwrap());
    assert!(!e.vault.join(DAY_FILE).exists());
    assert_eq!(e.rows(), []);
    assert_eq!(record(&e, "j2025-01-17").map(|r| r.0), Some(true));
    assert_eq!(queued(&e, "j2025-01-17"), ["crdt-update", "delete"]);
    let journal = open.vault.journal(store).unwrap();
    assert_eq!(read(&e, &journal), None);
    assert_eq!(outside_facts(&mut e), [], "the removal is the app's");
    assert!(
        !notes.delete_day(&open, DAY).unwrap(),
        "a day with none has nothing to delete"
    );

    let again = notes.create_day(&open, new_day()).unwrap();
    assert_eq!(
        again.id, "j2025-01-17",
        "a deleted day comes back under its id"
    );
    assert_eq!(e.read(DAY_FILE), NEW_FILE);
}
