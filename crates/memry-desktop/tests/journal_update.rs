//! A day edited in the app (Step 13m-3, #3530, `journal:updateEntry`) under the running vault
//! tier: the editor's save writes the day's file and feeds its body, with `date` set and the
//! file's tags left as the author wrote them; tags go to the record only; properties replace
//! the file's and the record's; a day with no file is made; a file the page cannot read whole
//! is refused; an outside edit the save replaces is kept as a version.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use memry_core::crdt::body_edit::BlockEdit;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::journal::update::{DayUpdate, InlineTags};
use memry_desktop::journal::write::NewDay;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use memry_desktop::vault::hash::content_hash;
use serde_json::json;
use vault_env::{Env, env, indexed};

const NEW_FILE: &str = include_str!("fixtures/electron-journal/new.md");
const DAY: &str = "2025-01-17";
const ID: &str = "j2025-01-17";
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

/// The day `new.md` holds: tags `work`, `Ideas`; properties `mood`, `rating`.
fn made(e: &mut Env, notes: &NotesService) {
    let open = e.session.current().unwrap();
    let day = NewDay {
        date: DAY.into(),
        content: "Morning pages.\n\n- [ ] call Ann".into(),
        tags: vec!["work".into(), "Ideas".into()],
        properties: json!({ "mood": "calm", "rating": 4 })
            .as_object()
            .unwrap()
            .clone(),
    };
    notes.create_day(&open, day).unwrap();
    assert_eq!(e.read(DAY_FILE), NEW_FILE);
    e.drain();
}

fn update(date: &str) -> DayUpdate {
    DayUpdate {
        date: date.into(),
        ..DayUpdate::default()
    }
}

/// `(tags, properties)` of the day's record.
fn record(e: &Env) -> (String, Option<String>) {
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            Ok(conn
                .query_row(
                    "SELECT json_extract(payload, '$.tags'), json_extract(payload, '$.properties')
                       FROM sync_items WHERE item_type = 'journal' AND item_id = ?1",
                    [ID],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap())
        })
        .unwrap()
}

fn queued(e: &Env) -> Vec<String> {
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            let mut statement = conn
                .prepare("SELECT op FROM outbox WHERE item_type = 'journal' AND item_id = ?1")
                .unwrap();
            Ok(statement
                .query_map([ID], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<String>, _>>()
                .unwrap())
        })
        .unwrap()
}

fn row_hash(e: &Env) -> Option<String> {
    e.core()
        .note_files()
        .by_id(ID)
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

#[test]
fn a_save_writes_the_text_feeds_the_body_and_leaves_the_rest_of_the_block() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    let before = queued(&e).len();

    let saved = notes
        .update_day(
            &open,
            DayUpdate {
                content: Some("Evening pages.\n\nAll done.\n\n".into()),
                ..update(DAY)
            },
        )
        .unwrap();
    assert!(!saved.created);
    let file = NEW_FILE.replace(
        "Morning pages.\n\n- [ ] call Ann",
        "Evening pages.\n\nAll done.",
    );
    assert_eq!(
        e.read(DAY_FILE),
        file,
        "the trimmed text, the block byte for byte"
    );
    assert_eq!(saved.entry.content, "Evening pages.\n\nAll done.");
    assert_eq!(saved.entry.tags, ["work", "Ideas"]);
    assert_eq!(e.body(ID), "Evening pages.\nAll done.");
    assert_eq!(row_hash(&e), Some(content_hash(&file)));
    assert_eq!(
        &queued(&e)[before..],
        ["crdt-update"],
        "the body, and no record write"
    );
    assert_eq!(
        e.versions(ID),
        Vec::<String>::new(),
        "the file the day's create wrote is the user's text: no version of it"
    );
    assert_eq!(outside_facts(&mut e), []);
    assert_eq!(e.read(DAY_FILE), file, "and the write-back agrees");

    let again = notes
        .update_day(
            &open,
            DayUpdate {
                content: Some("  Evening pages.\n\nAll done.".into()),
                ..update(DAY)
            },
        )
        .unwrap();
    assert_eq!(
        again.entry, saved.entry,
        "a text equal once trimmed writes nothing"
    );
    assert_eq!(e.read(DAY_FILE), file);
}

#[test]
fn a_save_sets_the_days_date_in_a_file_that_lacks_it() {
    let (mut e, notes, _) = opened();
    e.write(DAY_FILE, "---\nmood: calm\n---\nWritten elsewhere.\n");
    e.facts_until(|fact| matches!(fact, Applied::Added { note_id, .. } if note_id == ID));
    let open = e.session.current().unwrap();
    notes
        .update_day(
            &open,
            DayUpdate {
                content: Some("Written here.".into()),
                ..update(DAY)
            },
        )
        .unwrap();
    assert_eq!(
        e.read(DAY_FILE),
        format!("---\nmood: calm\ndate: '{DAY}'\n---\nWritten here.\n")
    );
}

#[test]
fn tags_go_to_the_record_and_the_body_tags_join_them_but_the_file_keeps_its_own() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    let tagged = notes
        .update_day(
            &open,
            DayUpdate {
                tags: Some(vec!["work".into()]),
                inline_tags: Some(InlineTags {
                    add: vec!["daily".into()],
                    remove: vec!["WORK".into()],
                }),
                ..update(DAY)
            },
        )
        .unwrap();
    assert_eq!(tagged.entry.tags, ["daily"]);
    assert_eq!(record(&e).0, r#"["daily"]"#);
    assert_eq!(
        e.read(DAY_FILE),
        NEW_FILE,
        "a tag edit never writes the file"
    );

    let inline = notes
        .update_day(
            &open,
            DayUpdate {
                inline_tags: Some(InlineTags {
                    add: vec!["reflection".into()],
                    remove: Vec::new(),
                }),
                ..update(DAY)
            },
        )
        .unwrap();
    assert_eq!(
        inline.entry.tags,
        ["daily", "reflection"],
        "on top of the record's"
    );
}

#[test]
fn properties_replace_the_files_and_the_records_and_untouched_keys_keep_their_lines() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    let edited = notes
        .update_day(
            &open,
            DayUpdate {
                properties: Some(
                    json!({ "mood": "tired", "energy": 2, "tags": ["x"] })
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
                ..update(DAY)
            },
        )
        .unwrap();
    let file = "---\ndate: '2025-01-17'\ntags:\n  - work\n  - Ideas\nmood: tired\nenergy: 2\n---\n\
                Morning pages.\n\n- [ ] call Ann\n";
    assert_eq!(e.read(DAY_FILE), file);
    assert_eq!(
        edited.entry.properties,
        json!({ "mood": "tired", "energy": 2 }).as_object().cloned()
    );
    assert_eq!(
        edited.entry.tags,
        ["work", "Ideas"],
        "a `tags` property is not a tag edit"
    );
    assert_eq!(
        record(&e),
        (
            r#"["work","Ideas"]"#.to_owned(),
            Some(r#"{"mood":"tired","energy":2}"#.to_owned())
        )
    );
    assert_eq!(
        e.body(ID),
        "Morning pages.\ncall Ann",
        "the body is untouched"
    );
    assert_eq!(outside_facts(&mut e), []);
}

#[test]
fn an_update_of_a_day_with_no_file_makes_it() {
    let (e, notes, _) = opened();
    let open = e.session.current().unwrap();
    let made = notes.update_day(&open, update("2025-01-18")).unwrap();
    assert!(made.created);
    assert_eq!(
        e.read("journal/2025-01-18.md"),
        "---\ndate: '2025-01-18'\n---\n\n"
    );
    assert_eq!(made.entry.content, "");
}

#[test]
fn a_save_that_would_pass_the_size_the_page_reads_is_refused() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    let huge = "x".repeat(1024 * 1024 + 1);
    let refused = notes.update_day(
        &open,
        DayUpdate {
            content: Some(huge),
            ..update(DAY)
        },
    );
    assert!(
        matches!(refused, Err(NotesError::TooLarge(_))),
        "{refused:?}"
    );
    assert_eq!(e.read(DAY_FILE), NEW_FILE);
}

#[test]
fn a_save_over_an_outside_edit_keeps_that_edit_as_a_version() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    // Fed or not yet when the save runs, the outside edit is the user's text too.
    e.write(
        DAY_FILE,
        &NEW_FILE.replace("call Ann", "call Bob, typed outside"),
    );
    let saved = notes
        .update_day(
            &open,
            DayUpdate {
                content: Some("Typed in the app.".into()),
                ..update(DAY)
            },
        )
        .unwrap();
    assert_eq!(saved.entry.content, "Typed in the app.");
    assert!(e.read(DAY_FILE).ends_with("---\nTyped in the app.\n"));
    assert!(
        e.versions(ID)
            .iter()
            .any(|version| version.contains("typed outside")),
        "{:?}",
        e.versions(ID)
    );
}

#[test]
fn a_properties_save_never_puts_the_files_old_body_over_a_document_ahead() {
    let (mut e, notes, store) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    let journal = open.vault.journal(store).unwrap();
    let edit = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: "Synced in.".into(),
        new_block_id: "b-synced".into(),
    };
    journal.edit_day(DAY.into(), edit).unwrap();
    notes
        .update_day(
            &open,
            DayUpdate {
                properties: Some(json!({ "mood": "tired" }).as_object().unwrap().clone()),
                ..update(DAY)
            },
        )
        .unwrap();
    assert!(e.body(ID).contains("Synced in."), "{}", e.body(ID));
    assert_eq!(record(&e).1, Some(r#"{"mood":"tired"}"#.to_owned()));
}

#[test]
fn a_save_the_seam_refuses_leaves_the_records_tags_and_properties() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    let broken = "---\ndate: [unclosed\n---\nMorning pages.\n";
    e.write(DAY_FILE, broken);
    let refused = notes.update_day(
        &open,
        DayUpdate {
            content: Some("Typed in the app.".into()),
            tags: Some(vec!["other".into()]),
            properties: Some(json!({ "mood": "tired" }).as_object().unwrap().clone()),
            ..update(DAY)
        },
    );
    assert!(
        matches!(refused, Err(NotesError::DayTextUnwritable(_))),
        "{refused:?}"
    );
    assert_eq!(e.read(DAY_FILE), broken);
    assert_eq!(
        record(&e),
        (
            r#"["work","Ideas"]"#.to_owned(),
            Some(r#"{"mood":"calm","rating":4}"#.to_owned())
        ),
        "the record says what the file says"
    );
}
