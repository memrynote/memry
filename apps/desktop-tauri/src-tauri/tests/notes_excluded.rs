//! A note under an exclude pattern is read-only (#3530 13m-7b-3b), through the IPC a renderer
//! calls on a mock app over a real vault: every write the app makes to it, or to a day in an
//! excluded journal folder (a new day there too), answers `note_excluded` and changes nothing,
//! and once the pattern is dropped the writes land again.
//! Electron's index drops such a note, so each of these fails there with "Note not found".

mod support;

use std::fs;

use serde_json::{Value, json};
use support::Mocked;
use tauri::test::MockRuntime;
use tauri_specta::{ErrorHandlingMode, collect_commands};

const OLD: &str = "archive/old.md";
const OLD_TEXT: &str = "---\nstage: Draft\ntags:\n  - idea\n---\nOld\n";

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
            memry_tauri::commands::properties::properties_set::<MockRuntime>,
            memry_tauri::commands::properties::properties_rename::<MockRuntime>,
            memry_tauri::commands::notes::notes_edit_aliases::<MockRuntime>,
            memry_tauri::commands::notes::notes_link_mention::<MockRuntime>,
            memry_tauri::commands::tags_retag::tags_remove_from_note::<MockRuntime>,
            memry_tauri::commands::attachments::notes_attachment_rename::<MockRuntime>,
            memry_tauri::commands::journal::journal_create_entry::<MockRuntime>,
            memry_tauri::commands::journal::journal_update_entry::<MockRuntime>,
            memry_tauri::commands::journal::journal_delete_entry::<MockRuntime>,
        ]);
    let files = [
        (OLD, OLD_TEXT),
        ("notes/new.md", "New\n"),
        ("journal/2025-01-02.md", "A day\n"),
    ];
    let mocked = Mocked::open(&files, commands);
    let id = id_at(&mocked, OLD);
    (mocked, id)
}

/// The id of the note at `path`.
fn id_at(mocked: &Mocked, path: &str) -> String {
    let open = mocked.session().current().unwrap();
    open.vault
        .note_files()
        .by_path(path)
        .unwrap()
        .unwrap()
        .note_id
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
/// rename, a move, its properties, its aliases, a mention linked in it, a tag taken off it and
/// an attachment renamed.
fn writes<'a>(id: &'a str, new_id: &'a str) -> Vec<(&'static str, Value)> {
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
        (
            "properties_set",
            json!({ "entityId": id, "properties": { "stage": "Done" }, "base": {} }),
        ),
        (
            "properties_rename",
            json!({ "entityId": id, "oldName": "stage", "newName": "phase" }),
        ),
        (
            "notes_edit_aliases",
            json!({ "input": { "id": id, "add": ["Older"], "remove": [] } }),
        ),
        (
            "notes_link_mention",
            json!({ "sourceId": id, "targetId": new_id, "ordinal": 0 }),
        ),
        (
            "tags_remove_from_note",
            json!({ "input": { "noteId": id, "tag": "idea" } }),
        ),
        (
            "notes_attachment_rename",
            json!({ "noteId": id, "url": "attachments/a.png", "newName": "b" }),
        ),
    ]
}

#[test]
fn every_write_to_an_excluded_note_is_refused_and_changes_nothing() {
    let (mocked, id) = opened();
    let new_id = id_at(&mocked, "notes/new.md");
    excludes(&mocked, &["archive"]);
    for (command, args) in writes(&id, &new_id) {
        let refused = mocked.invoke(command, args).expect_err(command);
        assert_eq!(refused["code"], "note_excluded", "{command}: {refused}");
        assert_eq!(
            refused["message"], "This note is in an excluded folder.",
            "{command}"
        );
    }
    assert_eq!(
        fs::read_to_string(mocked.vault.join(OLD)).unwrap(),
        OLD_TEXT
    );
    assert_eq!(path_of(&mocked, &id), OLD);
}

/// A day in an excluded journal folder: its update and its delete are refused, and so is a new
/// day there.
#[test]
fn every_write_to_an_excluded_day_is_refused_and_changes_nothing() {
    let (mocked, _) = opened();
    let day = "journal/2025-01-02.md";
    let id = id_at(&mocked, day);
    excludes(&mocked, &["journal"]);
    let writes = [
        (
            "journal_update_entry",
            json!({ "input": { "date": "2025-01-02", "content": "Changed" } }),
        ),
        (
            "journal_update_entry",
            json!({ "input": { "date": "2025-01-02", "tags": ["idea"] } }),
        ),
        ("journal_delete_entry", json!({ "date": "2025-01-02" })),
        (
            "journal_create_entry",
            json!({ "input": { "date": "2025-01-03", "content": "New day" } }),
        ),
    ];
    for (command, args) in writes {
        let refused = mocked.invoke(command, args).unwrap_err();
        assert_eq!(refused["code"], "note_excluded", "{command}: {refused}");
    }
    assert_eq!(
        fs::read_to_string(mocked.vault.join(day)).unwrap(),
        "A day\n"
    );
    assert_eq!(path_of(&mocked, &id), day);
    assert!(!mocked.vault.join("journal/2025-01-03.md").exists());
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
