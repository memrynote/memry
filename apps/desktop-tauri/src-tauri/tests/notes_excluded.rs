//! A note under an exclude pattern is read-only (#3530 13m-7b-3b), through the IPC a renderer
//! calls on a mock app over a real vault: every write the app makes to it answers
//! `note_excluded` and changes nothing, and once the pattern is dropped the writes land again.
//! Electron's index drops such a note, so each of these fails there with "Note not found".

mod support;

use std::fs;

use serde_json::{Value, json};
use support::Mocked;
use tauri::test::MockRuntime;
use tauri_specta::{ErrorHandlingMode, collect_commands};

const OLD: &str = "archive/old.md";

/// A vault with a note in `archive/`, and its id.
fn opened() -> (Mocked, String) {
    // As `registry::builder` lists them, with its error handling.
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::vault::vault_update_config::<MockRuntime>,
            memry_tauri::commands::notes::notes_update::<MockRuntime>,
            memry_tauri::commands::notes::notes_rename::<MockRuntime>,
            memry_tauri::commands::notes::notes_move::<MockRuntime>,
            memry_tauri::commands::properties::properties_merge::<MockRuntime>,
        ]);
    let mocked = Mocked::open(&[(OLD, "Old\n"), ("notes/new.md", "New\n")], commands);
    let open = mocked.session().current().unwrap();
    let id = open
        .vault
        .note_files()
        .by_path(OLD)
        .unwrap()
        .unwrap()
        .note_id;
    drop(open);
    (mocked, id)
}

/// The path of the note's row.
fn path_of(mocked: &Mocked, id: &str) -> String {
    let open = mocked.session().current().unwrap();
    open.vault.note_files().by_id(id).unwrap().unwrap().path
}

fn excludes(mocked: &Mocked, patterns: &[&str]) {
    mocked
        .invoke(
            "vault_update_config",
            json!({ "config": { "excludePatterns": patterns } }),
        )
        .unwrap();
}

/// Every write the renderer makes to a note: a save, a header tag, a frontmatter key, a
/// rename, a move and a property.
fn writes(id: &str) -> Vec<(&'static str, Value)> {
    vec![
        (
            "notes_update",
            json!({ "input": { "id": id, "content": "Changed" } }),
        ),
        (
            "notes_update",
            json!({ "input": { "id": id, "headerTags": { "add": ["idea"] } } }),
        ),
        (
            "notes_update",
            json!({ "input": { "id": id, "frontmatter": { "status": "done" } } }),
        ),
        ("notes_rename", json!({ "id": id, "newTitle": "Renamed" })),
        ("notes_move", json!({ "id": id, "newFolder": "notes" })),
        (
            "properties_merge",
            json!({ "entityId": id, "values": { "stage": "Done" } }),
        ),
    ]
}

#[test]
fn every_write_to_an_excluded_note_is_refused_and_changes_nothing() {
    let (mocked, id) = opened();
    excludes(&mocked, &["archive"]);
    for (command, args) in writes(&id) {
        let refused = mocked.invoke(command, args).unwrap_err();
        assert_eq!(refused["code"], "note_excluded", "{command}: {refused}");
        assert_eq!(
            refused["message"], "This note is in an excluded folder.",
            "{command}"
        );
    }
    assert_eq!(fs::read_to_string(mocked.vault.join(OLD)).unwrap(), "Old\n");
    assert_eq!(path_of(&mocked, &id), OLD);
}

#[test]
fn a_note_no_longer_excluded_takes_the_writes_again() {
    let (mocked, id) = opened();
    excludes(&mocked, &["archive"]);
    excludes(&mocked, &[]);
    mocked
        .invoke(
            "notes_update",
            json!({ "input": { "id": id, "content": "Changed" } }),
        )
        .unwrap();
    assert!(
        fs::read_to_string(mocked.vault.join(OLD))
            .unwrap()
            .contains("Changed")
    );
    mocked
        .invoke("notes_move", json!({ "id": id, "newFolder": "notes" }))
        .unwrap();
    assert_eq!(path_of(&mocked, &id), "notes/old.md");
}
