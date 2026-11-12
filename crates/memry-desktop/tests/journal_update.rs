//! A day edited in the app (Step 13m-3, #3530, `journal:updateEntry`) under the running vault
//! tier: the editor's save writes the day's file and feeds its body, with `date` set and the
//! file's tags left as the author wrote them; tags go to the record only; properties replace
//! the file's, and the record takes only the keys that edit set or dropped, so a pulled value
//! stays; a day with no file is made, and a record that held one gets the whole update over
//! it; a file the page cannot read whole is refused; an outside edit the save replaces is kept
//! as a version.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::Arc;

use crate::index_support::until;
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
pub(crate) const DAY: &str = "2025-01-17";
pub(crate) const ID: &str = "j2025-01-17";
pub(crate) const DAY_FILE: &str = "journal/2025-01-17.md";

pub(crate) fn opened() -> (Env, Arc<NotesService>, Arc<dyn SecureStore>) {
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
pub(crate) fn made(e: &mut Env, notes: &NotesService) {
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

pub(crate) fn update(date: &str) -> DayUpdate {
    DayUpdate {
        date: date.into(),
        ..DayUpdate::default()
    }
}

/// `(tags, properties)` of the day's record.
pub(crate) fn record(e: &Env) -> (String, Option<String>) {
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

pub(crate) fn row_hash(e: &Env) -> Option<String> {
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
    // The watcher fed it: the document holds it, and the file is not the run's own.
    e.write(
        DAY_FILE,
        &NEW_FILE.replace("call Ann", "call Bob, typed outside"),
    );
    e.facts_until(|fact| {
        matches!(
            fact,
            Applied::Changed { path, source: ChangeSource::Watcher, .. } if path == DAY_FILE
        )
    });
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

/// An outside writer between its truncate and its write (`fs.writeFileSync`, an editor saving
/// in place) leaves the day's file empty. A save renamed over it then would leave the writer's
/// text in a file no path names, and in no version (#4281). The save's write is refused
/// instead, and its text, which only the save carried, reaches the day's document and wins over
/// the outside text, which is kept as a version.
#[test]
fn a_save_over_a_file_an_outside_writer_has_just_emptied_wins_and_keeps_that_text() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    let outside = format!("{}\n\nWritten outside.\n", e.read(DAY_FILE).trim_end());

    let mut writer = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(e.vault.join(DAY_FILE))
        .unwrap();
    let saved = notes.update_day(
        &open,
        DayUpdate {
            content: Some("Morning pages.\n\n- [ ] call Ann\n\nTyped in the app.".into()),
            ..update(DAY)
        },
    );
    writer.write_all(outside.as_bytes()).unwrap();
    drop(writer);

    until("the typing written over the outside text", || {
        e.read(DAY_FILE).contains("Typed in the app.")
    });
    let versions = e.versions(ID);
    assert!(
        e.read(DAY_FILE).contains("Written outside.")
            || versions
                .iter()
                .any(|version| version.contains("Written outside.")),
        "the outside text was lost: {versions:?}"
    );
    assert!(
        matches!(saved, Err(NotesError::DayTextUnwritable(_))),
        "{saved:?}"
    );
    assert_eq!(
        record(&e).0,
        r#"["work","Ideas"]"#,
        "the empty file named no tags"
    );
}

/// The same race, with a save the feed does not take: the document never holds its text and
/// the file never gets it, so the save keeps it as a version before it refuses the write.
#[test]
fn a_save_the_feed_does_not_take_over_a_file_being_written_keeps_its_text_as_a_version() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    let outside = format!("{}\n\nWritten outside.\n", e.read(DAY_FILE).trim_end());

    let mut writer = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(e.vault.join(DAY_FILE))
        .unwrap();
    notes.fail_next_save_feed();
    let saved = notes.update_day(
        &open,
        DayUpdate {
            content: Some("Morning pages.\n\nTyped in the app.".into()),
            ..update(DAY)
        },
    );
    writer.write_all(outside.as_bytes()).unwrap();
    drop(writer);

    assert!(
        matches!(saved, Err(NotesError::DayTextUnwritable(_))),
        "{saved:?}"
    );
    outside_facts(&mut e);
    assert!(e.read(DAY_FILE).contains("Written outside."));
    assert!(
        e.versions(ID)
            .iter()
            .any(|version| version.contains("Typed in the app.")),
        "the typing was lost: {:?}",
        e.versions(ID)
    );
}

/// A row with no hash (a removal the identity kept) names no file, so an empty file at its path
/// is no write in progress: every save writes over it.
#[test]
fn every_save_writes_over_an_empty_file_under_a_row_that_names_none() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    fs::write(e.vault.join(DAY_FILE), "").unwrap();
    e.core().note_files().set_hash(ID, None).unwrap();

    for typed in ["One.", "Two.", "Three."] {
        let saved = notes.update_day(
            &open,
            DayUpdate {
                content: Some(typed.into()),
                ..update(DAY)
            },
        );
        assert!(saved.is_ok(), "{typed} {saved:?}");
        assert!(e.read(DAY_FILE).contains(typed), "{}", e.read(DAY_FILE));
    }
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

/// An outside edit, then the given metadata-only saves, then a body save, which keeps the
/// outside edit as a version: a save that left the body never makes a file it did not write
/// the run's own. `fed` waits for the watcher to feed the edit first.
fn metadata_saves_then_a_body_save(fed: bool) {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    e.write(
        DAY_FILE,
        &NEW_FILE.replace("call Ann", "call Bob, typed outside"),
    );
    if fed {
        e.facts_until(|fact| {
            matches!(
                fact,
                Applied::Changed { path, source: ChangeSource::Watcher, .. } if path == DAY_FILE
            )
        });
    }
    for metadata in [
        DayUpdate {
            properties: Some(json!({ "mood": "tired" }).as_object().unwrap().clone()),
            ..update(DAY)
        },
        DayUpdate {
            tags: Some(vec!["work".into()]),
            ..update(DAY)
        },
    ] {
        notes.update_day(&open, metadata).unwrap();
    }
    assert!(e.read(DAY_FILE).contains("call Bob, typed outside"));
    notes
        .update_day(
            &open,
            DayUpdate {
                content: Some("Typed in the app.".into()),
                ..update(DAY)
            },
        )
        .unwrap();
    assert!(
        e.versions(ID)
            .iter()
            .any(|version| version.contains("typed outside")),
        "the outside edit was lost: {:?}",
        e.versions(ID)
    );
}

#[test]
fn a_metadata_save_over_a_fed_outside_edit_leaves_it_to_be_kept_by_the_next_body_save() {
    metadata_saves_then_a_body_save(true);
}

#[test]
fn a_metadata_save_over_an_outside_edit_maybe_not_fed_leaves_it_to_be_kept_too() {
    // Saved right after the write, most often before the watcher reports it.
    metadata_saves_then_a_body_save(false);
}

#[test]
fn a_first_save_over_a_text_only_the_record_holds_keeps_that_text_as_a_version() {
    let (e, notes, store) = opened();
    let open = e.session.current().unwrap();
    let journal = open.vault.journal(store).unwrap();
    let edit = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: "From the phone.".into(),
        new_block_id: "b-phone".into(),
    };
    journal.edit_day(DAY.into(), edit).unwrap();
    let saved = notes
        .update_day(
            &open,
            DayUpdate {
                content: Some("Typed on desktop.".into()),
                ..update(DAY)
            },
        )
        .unwrap();
    assert!(saved.created, "the day had no file");
    assert_eq!(saved.entry.content, "Typed on desktop.");
    assert!(
        e.read(DAY_FILE).ends_with("---\nTyped on desktop.\n"),
        "{}",
        e.read(DAY_FILE)
    );
    assert_eq!(e.body(ID), "Typed on desktop.");
    assert!(
        e.versions(ID)
            .iter()
            .any(|version| version.contains("From the phone.")),
        "the phone's text was lost: {:?}",
        e.versions(ID)
    );
}

#[test]
fn the_first_words_of_an_empty_day_follow_its_block_as_electron_writes_them() {
    let (e, notes, _) = opened();
    let open = e.session.current().unwrap();
    notes.update_day(&open, update(DAY)).unwrap();
    assert_eq!(e.read(DAY_FILE), format!("---\ndate: '{DAY}'\n---\n\n"));
    notes
        .update_day(
            &open,
            DayUpdate {
                content: Some("First words.".into()),
                ..update(DAY)
            },
        )
        .unwrap();
    assert_eq!(
        e.read(DAY_FILE),
        format!("---\ndate: '{DAY}'\n---\nFirst words.\n"),
        "`joinBlockAndBody(block, body)`, with no blank line between"
    );
}

#[test]
fn a_text_equal_once_trimmed_keeps_a_bodys_own_blank_lines() {
    let (mut e, notes, _) = opened();
    let file = format!("---\ndate: '{DAY}'\n---\n\n\nMorning pages.\n\n\n");
    e.write(DAY_FILE, &file);
    e.facts_until(|fact| matches!(fact, Applied::Added { note_id, .. } if note_id == ID));
    let open = e.session.current().unwrap();
    for content in ["Morning pages.", "\nMorning pages.\n\n"] {
        notes
            .update_day(
                &open,
                DayUpdate {
                    content: Some(content.into()),
                    ..update(DAY)
                },
            )
            .unwrap();
        assert_eq!(e.read(DAY_FILE), file, "{content:?}");
    }
    notes
        .update_day(
            &open,
            DayUpdate {
                content: Some("Morning pages.".into()),
                properties: Some(json!({ "mood": "calm" }).as_object().unwrap().clone()),
                ..update(DAY)
            },
        )
        .unwrap();
    assert_eq!(
        e.read(DAY_FILE),
        format!("---\ndate: '{DAY}'\nmood: calm\n---\n\n\nMorning pages.\n\n\n"),
        "a properties edit keeps the body's bytes"
    );
}

#[test]
fn a_pulled_value_the_file_has_not_yet_survives_a_save_of_another_property() {
    let (mut e, notes, store) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    // Brought in by a pull: in the record, not in the file yet (13k-4).
    let journal = open.vault.journal(store).unwrap();
    journal
        .set_property(DAY.into(), "weather".into(), r#""rain""#.into())
        .unwrap();
    notes
        .update_day(
            &open,
            DayUpdate {
                properties: Some(
                    json!({ "mood": "tired", "rating": 4 })
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
                ..update(DAY)
            },
        )
        .unwrap();
    assert!(!e.read(DAY_FILE).contains("weather"));
    assert_eq!(
        record(&e).1,
        Some(r#"{"mood":"tired","rating":4,"weather":"rain"}"#.to_owned()),
        "only the keys the save changed reach the record"
    );
}

#[test]
fn a_first_save_over_a_record_only_day_takes_its_tags_and_properties() {
    for phone_text in ["From the phone.", ""] {
        let (e, notes, store) = opened();
        let open = e.session.current().unwrap();
        let journal = open.vault.journal(store).unwrap();
        if phone_text.is_empty() {
            // A live record with an empty body: the create writes the caller's text.
            journal.set_tags(DAY.into(), vec!["phone".into()]).unwrap();
        } else {
            let edit = BlockEdit::InsertParagraph {
                after_block_id: None,
                text: phone_text.into(),
                new_block_id: "b-phone".into(),
            };
            journal.edit_day(DAY.into(), edit).unwrap();
        }
        let saved = notes
            .update_day(
                &open,
                DayUpdate {
                    content: Some("Typed on desktop.".into()),
                    tags: Some(vec!["work".into()]),
                    properties: Some(json!({ "mood": "calm" }).as_object().unwrap().clone()),
                    ..update(DAY)
                },
            )
            .unwrap();
        assert!(saved.created, "{phone_text:?}");
        assert_eq!(saved.entry.tags, ["work"], "{phone_text:?}");
        assert_eq!(
            saved.entry.properties,
            json!({ "mood": "calm" }).as_object().cloned(),
            "{phone_text:?}"
        );
        assert!(
            e.read(DAY_FILE).contains("mood: calm\n"),
            "{}",
            e.read(DAY_FILE)
        );
        assert!(e.read(DAY_FILE).ends_with("---\nTyped on desktop.\n"));
        assert_eq!(
            record(&e),
            (
                r#"["work"]"#.to_owned(),
                Some(r#"{"mood":"calm"}"#.to_owned())
            ),
            "{phone_text:?}"
        );
    }
}

#[test]
fn a_pulled_value_of_a_property_the_file_says_otherwise_survives_a_save_of_another() {
    let (mut e, notes, store) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    // A pull set `mood: happy` on the record; the file still says `mood: calm` (13k-4).
    let journal = open.vault.journal(store).unwrap();
    journal
        .set_property(DAY.into(), "mood".into(), r#""happy""#.into())
        .unwrap();
    notes
        .update_day(
            &open,
            DayUpdate {
                properties: Some(
                    json!({ "mood": "calm", "rating": 5 })
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
                ..update(DAY)
            },
        )
        .unwrap();
    assert!(e.read(DAY_FILE).contains("rating: 5\n"));
    assert_eq!(
        record(&e).1,
        Some(r#"{"mood":"happy","rating":5}"#.to_owned()),
        "the save changed `rating` only"
    );
}

#[test]
fn a_day_deleted_while_its_save_writes_stays_deleted() {
    let (mut e, notes, store) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    let journal = open.vault.journal(store).unwrap();
    // A delete that lands between the file write and the record's mirror, as a pull's does.
    notes.before_next_day_file_lands(Box::new(move || {
        journal.delete_day(DAY.into()).unwrap();
    }));
    notes
        .update_day(
            &open,
            DayUpdate {
                content: Some("Typed in the app.".into()),
                tags: Some(vec!["daily".into()]),
                ..update(DAY)
            },
        )
        .ok();
    let live: bool = e
        .core()
        .db_handle()
        .call_blocking(|conn| {
            Ok(conn
                .query_row(
                    "SELECT deleted_at IS NULL FROM sync_items WHERE item_type = 'journal' AND item_id = ?1",
                    [ID],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .unwrap();
    assert!(!live, "the tags' mirror revived the deleted day");
    assert_eq!(queued(&e).last().map(String::as_str), Some("delete"));
}

/// A day's save whose feed the document did not take: the watcher's report of the app's own
/// bytes is the app's fact, never an outside edit (an `external` `journal:entryUpdated` drops
/// what the open editor holds unsaved).
#[test]
fn a_days_save_the_watcher_brings_in_is_reported_as_the_apps_own() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    notes.fail_next_save_feed();
    notes
        .update_day(
            &open,
            DayUpdate {
                content: Some("Evening pages.".into()),
                ..update(DAY)
            },
        )
        .unwrap();
    assert!(e.read(DAY_FILE).contains("Evening pages."));
    crate::index_support::until("the watcher fed the save", || {
        e.body(ID).contains("Evening pages.")
    });
    assert_eq!(outside_facts(&mut e), Vec::<Applied>::new());
}

/// What the app wrote is its own in the vault it wrote it in: another vault's day file with
/// the same date and bytes is not, so a save there keeps it as a version first.
#[test]
fn a_day_the_app_wrote_in_another_vault_is_not_its_own() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    e.close();
    let other = e.vault.with_file_name("other");
    fs::create_dir_all(other.join("journal")).unwrap();
    fs::write(other.join(DAY_FILE), NEW_FILE).unwrap();
    e.vault = other;
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().unwrap();
    notes
        .update_day(
            &open,
            DayUpdate {
                content: Some("Evening pages.".into()),
                ..update(DAY)
            },
        )
        .unwrap();
    assert_eq!(e.versions(ID), [NEW_FILE]);
}

/// Electron `assertNoteWritable` on a day (Step 14e-2): the save is refused as `note_locked`,
/// not as a day the app cannot write, and nothing changes.
#[test]
fn a_save_of_a_locked_day_is_refused_as_note_locked_and_changes_nothing() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    e.core()
        .locks()
        .set(
            memry_core::domain::vault_locks::TargetKind::Note,
            ID,
            true,
            "device-a",
        )
        .unwrap();
    let before = queued(&e).len();

    let refused = notes
        .update_day(
            &open,
            DayUpdate {
                content: Some("Evening pages.".into()),
                ..update(DAY)
            },
        )
        .unwrap_err();

    let failure = memry_desktop::error::map_core(&refused);
    assert_eq!(failure.code, "note_locked");
    assert_eq!(failure.message, "The owner made this note read-only.");
    assert_eq!(e.read(DAY_FILE), NEW_FILE);
    assert_eq!(queued(&e).len(), before);
}

/// A day's own writes record its file's class (#3531 14c-2): its create and its save skip
/// their watcher echo, and no read of a day records it. A day with one block past the bound
/// opens read-only, and a save that shrinks it makes it editable again.
#[test]
fn a_day_written_past_the_block_bound_and_back_records_its_class() {
    use memry_core::markdown::shared::markdown_class::NOTE_MAX_BLOCK_BYTES;
    let (e, notes, _) = opened();
    let open = e.session.current().unwrap();
    let large = || e.core().note_files().is_large_file(ID).unwrap();
    let day = NewDay {
        date: DAY.into(),
        content: "x".repeat(NOTE_MAX_BLOCK_BYTES + 1),
        tags: Vec::new(),
        properties: serde_json::Map::new(),
    };
    notes.create_day(&open, day).unwrap();
    assert!(large(), "made past the bound");

    notes
        .update_day(
            &open,
            DayUpdate {
                content: Some("Short again.".into()),
                ..update(DAY)
            },
        )
        .unwrap();
    assert!(!large(), "shrunk by the save");
}

/// A tags-only update writes the record, not the file (Step 14e-2 review): a locked day refuses
/// it too.
#[test]
fn a_tags_only_update_of_a_locked_day_is_refused_and_keeps_its_tags() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    e.core()
        .locks()
        .set(
            memry_core::domain::vault_locks::TargetKind::Note,
            ID,
            true,
            "device-a",
        )
        .unwrap();
    let before = record(&e);

    let refused = notes
        .update_day(
            &open,
            DayUpdate {
                tags: Some(vec!["other".into()]),
                ..update(DAY)
            },
        )
        .unwrap_err();

    assert_eq!(memry_desktop::error::map_core(&refused).code, "note_locked");
    assert_eq!(record(&e), before);
    assert_eq!(e.read(DAY_FILE), NEW_FILE);
}
