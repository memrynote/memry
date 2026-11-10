//! An unreadable `.memry/config.json` keeps the user's exclude patterns (#4118), on a real vault
//! and session. Electron fell back to the default patterns, so a note under a pattern the user
//! added became watched and writable: an outside edit and an app edit each queued a
//! `crdt-update` for sync, and its folder came back to the tree. Here the patterns last read
//! from the file stand in, or after a restart the ones this device last applied.
//!
//! | Test                                                         | Rule                              |
//! | ------------------------------------------------------------ | --------------------------------- |
//! | an unreadable config at open keeps excluded notes excluded   | no write, no edit read, no sync   |
//! | a config broken while open keeps the excluded folder         | hidden; nothing moves into it     |
//! | the patterns this device applied stand in after a restart    | remembered in the vault's core    |
//! | patterns read while open are kept with the remembered ones   | the union, never the older list   |
//! | an exclude field that is not a list keeps the patterns       | nothing new is remembered         |
//! | a missing config, or one without the field, keeps them       | nothing new is remembered         |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;

use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::folders;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::update::NoteUpdateInput;
use memry_desktop::vault::config::{config_path, merge_preferences, read_vault_config};
use serde_json::{Map, json};
use vault_env::{Env, QUIET};

use crate::journal_folder::{outbox, reopen};
use crate::vault_exclude_read_only::{exclude, excluded};
use crate::vault_settings::opened_keeping;

const SECRET: &str = "private/secret.md";
const NOTE: &str = "notes/new.md";

fn id_of(e: &Env, path: &str) -> String {
    e.rows().into_iter().find(|(_, at)| at == path).unwrap().0
}

fn break_config(e: &Env) {
    fs::write(config_path(&e.vault), b"{ not json").unwrap();
}

fn remembered(e: &Env) -> Option<Vec<String>> {
    e.core().remembered_exclude_patterns().unwrap()
}

fn shown_folders(e: &Env) -> Vec<String> {
    let open = e.session.current().unwrap();
    folders::list(&open)
        .unwrap()
        .into_iter()
        .map(|f| f.path)
        .collect()
}

fn save(id: &str) -> NoteUpdateInput {
    NoteUpdateInput {
        id: id.to_owned(),
        content: Some("Changed in the app".to_owned()),
        ..NoteUpdateInput::default()
    }
}

/// The excluded note neither takes an edit from outside nor from the app, and queues nothing
/// for sync.
fn stays_excluded(e: &mut Env, notes: &NotesService, id: &str) {
    let queued = outbox(e, id);
    e.write(SECRET, "Edited outside\n");
    std::thread::sleep(QUIET);
    let facts = e.drain();
    assert!(facts.is_empty(), "{facts:?}");
    assert_eq!(e.body(id), "Secret");
    let open = e.session.current().unwrap();
    excluded(notes.update(&open, save(id)));
    drop(open);
    assert_eq!(e.read(SECRET), "Edited outside\n");
    assert_eq!(outbox(e, id), queued);
    assert_eq!(shown_folders(e), ["notes"]);
}

#[test]
fn an_unreadable_config_at_open_keeps_excluded_notes_excluded() {
    let (mut e, store) = opened_keeping(json!({}), &[(SECRET, "Secret\n"), (NOTE, "New\n")]);
    let notes = NotesService::new(e.tier.clone(), store);
    exclude(&mut e, &["private"]);
    let id = id_of(&e, SECRET);
    break_config(&e);

    reopen(&mut e);

    assert!(e.core().excluded().covers(SECRET));
    stays_excluded(&mut e, &notes, &id);
    // Readable again, the file decides: no pattern, so the note is the app's to write.
    fs::write(config_path(&e.vault), br#"{"excludePatterns":[]}"#).unwrap();
    reopen(&mut e);
    let open = e.session.current().unwrap();
    notes.update(&open, save(&id)).unwrap();
    drop(open);
    assert!(e.read(SECRET).contains("Changed in the app"));
}

#[test]
fn a_config_broken_while_open_keeps_the_excluded_folder() {
    let (mut e, store) = opened_keeping(json!({}), &[(SECRET, "Secret\n"), (NOTE, "New\n")]);
    let notes = NotesService::new(e.tier.clone(), store);
    exclude(&mut e, &["private"]);
    let id = id_of(&e, SECRET);
    let note = id_of(&e, NOTE);
    let rows = e.rows();
    break_config(&e);

    stays_excluded(&mut e, &notes, &id);
    let open = e.session.current().unwrap();
    let moved = notes.move_to_folder(&open, &note, "private");
    assert!(matches!(moved, Err(NotesError::InvalidFolder)), "{moved:?}");
    drop(open);
    assert_eq!(e.rows(), rows);
    assert_eq!(e.read(NOTE), "New\n");
}

#[test]
fn the_patterns_this_device_applied_stand_in_after_a_restart() {
    let (mut e, store) = opened_keeping(json!({}), &[(SECRET, "Secret\n"), (NOTE, "New\n")]);
    let notes = NotesService::new(e.tier.clone(), store);
    exclude(&mut e, &["private"]);
    let id = id_of(&e, SECRET);
    e.close();
    // What this process last read excludes nothing, as a new process knows nothing: only the
    // patterns remembered in the vault's core can keep the note excluded.
    fs::write(config_path(&e.vault), br#"{"excludePatterns":[]}"#).unwrap();
    assert_eq!(
        read_vault_config(&e.vault).exclude_patterns,
        Vec::<String>::new()
    );
    break_config(&e);

    e.open();
    e.facts_until(vault_env::indexed);

    assert!(e.core().excluded().covers(SECRET));
    stays_excluded(&mut e, &notes, &id);
}

#[test]
fn patterns_read_while_open_are_kept_with_the_remembered_ones() {
    let (mut e, _store) = opened_keeping(json!({}), &[(SECRET, "Secret\n"), (NOTE, "New\n")]);
    exclude(&mut e, &["private"]);
    // Edited outside while open: the tree reads it, the open's remembered list stays older.
    fs::write(
        config_path(&e.vault),
        br#"{"excludePatterns":["private","notes"]}"#,
    )
    .unwrap();
    assert!(!shown_folders(&e).contains(&"notes".to_owned()));
    break_config(&e);

    reopen(&mut e);

    assert!(e.core().excluded().covers(SECRET));
    assert!(e.core().excluded().covers(NOTE));
    let read = read_vault_config(&e.vault).exclude_patterns;
    assert!(read.contains(&"private".to_owned()) && read.contains(&"notes".to_owned()));
}

#[test]
fn an_exclude_field_that_is_not_a_list_keeps_the_patterns() {
    let (mut e, _store) = opened_keeping(json!({}), &[(SECRET, "Secret\n"), (NOTE, "New\n")]);
    exclude(&mut e, &["private"]);
    fs::write(
        config_path(&e.vault),
        br#"{"excludePatterns":"private","journalFolder":"days"}"#,
    )
    .unwrap();

    reopen(&mut e);

    assert!(e.core().excluded().covers(SECRET));
    let read = read_vault_config(&e.vault);
    assert_eq!(read.exclude_patterns, ["private"]);
    assert_eq!(
        read.journal_folder, "days",
        "the rest of the file still reads"
    );
    assert_eq!(remembered(&e), Some(vec!["private".to_owned()]));
}

#[test]
fn a_missing_config_or_one_without_the_field_keeps_the_patterns() {
    let (mut e, _store) = opened_keeping(json!({}), &[(SECRET, "Secret\n"), (NOTE, "New\n")]);
    exclude(&mut e, &["private"]);
    fs::remove_file(config_path(&e.vault)).unwrap();

    reopen(&mut e);

    assert!(e.core().excluded().covers(SECRET));
    assert_eq!(read_vault_config(&e.vault).exclude_patterns, ["private"]);
    // A settings writer recreates the file without the field.
    let mut general = Map::new();
    general.insert("theme".to_owned(), json!("dark"));
    merge_preferences(&e.vault, &general, &Map::new()).unwrap();
    assert!(
        fs::read_to_string(config_path(&e.vault))
            .unwrap()
            .contains("theme")
    );

    reopen(&mut e);

    assert!(e.core().excluded().covers(SECRET));
    assert_eq!(read_vault_config(&e.vault).exclude_patterns, ["private"]);
    assert_eq!(remembered(&e), Some(vec!["private".to_owned()]));
    assert_eq!(shown_folders(&e), ["notes"]);
}
