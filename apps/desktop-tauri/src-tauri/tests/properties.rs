//! The `properties_*` commands through the IPC a renderer calls, on a mock app over a real vault,
//! vault tier and note index (#3530 13k-3): the argument names the generated bindings send, a
//! merge and a rename landing in the note's file, and a refused edit reaching the renderer by
//! its code.

mod support;

use std::fs;

use serde_json::{Value, json};
use support::Mocked;
use tauri_specta::collect_commands;

const NOTE: &str = "---\ntags: [x]\ndue: 2026-10-07\nstage: Draft\n---\nThe body.\n";

struct Fixture {
    mocked: Mocked,
    id: String,
}

/// A vault holding `Plan.md`, opened with its first walk done, and a webview whose IPC routes
/// the four property commands.
fn opened() -> Fixture {
    // As `registry::builder` lists them, with its error handling.
    let commands = tauri_specta::Builder::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::properties::properties_get::<tauri::test::MockRuntime>,
            memry_tauri::commands::properties::properties_merge::<tauri::test::MockRuntime>,
            memry_tauri::commands::properties::properties_rename::<tauri::test::MockRuntime>,
            memry_tauri::commands::properties::properties_set::<tauri::test::MockRuntime>,
        ]);
    let mocked = Mocked::open(&[("Plan.md", NOTE)], commands);
    let id = mocked
        .session()
        .current()
        .unwrap()
        .vault
        .note_files()
        .by_path("Plan.md")
        .unwrap()
        .expect("a row for Plan.md")
        .note_id;
    Fixture { mocked, id }
}

impl Fixture {
    fn invoke(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        self.mocked.invoke(cmd, args)
    }

    fn file(&self) -> String {
        fs::read_to_string(self.mocked.vault.join("Plan.md")).unwrap()
    }
}

#[test]
fn a_merge_and_a_rename_through_the_ipc_land_in_the_file_and_read_back() {
    let f = opened();
    let shown = f
        .invoke("properties_get", json!({ "entityId": f.id }))
        .unwrap();
    assert_eq!(
        shown,
        json!([
            { "name": "due", "value": "2026-10-07", "type": "date" },
            { "name": "stage", "value": "Draft", "type": "text" },
        ])
    );

    let merged = f
        .invoke(
            "properties_merge",
            json!({ "entityId": f.id, "values": { "stage": "Done", "owner": "Kaan" } }),
        )
        .unwrap();
    assert_eq!(merged["removed"], json!([]));
    let renamed = f.invoke(
        "properties_rename",
        json!({ "entityId": f.id, "oldName": "due", "newName": "deadline" }),
    );
    assert_eq!(renamed, Ok(Value::Null));

    assert_eq!(
        f.file(),
        "---\ntags: [x]\nstage: Done\nowner: Kaan\ndeadline: 2026-10-07\n---\nThe body.\n"
    );
    let names: Vec<Value> = f
        .invoke("properties_get", json!({ "entityId": f.id }))
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|view| view["name"].clone())
        .collect();
    assert_eq!(names, [json!("stage"), json!("owner"), json!("deadline")]);

    // A rename onto a name the note holds is refused by its code.
    let taken = f.invoke(
        "properties_rename",
        json!({ "entityId": f.id, "oldName": "stage", "newName": "owner" }),
    );
    assert_eq!(taken.unwrap_err()["code"], "property_exists");
}

#[test]
fn an_edit_the_seam_keeps_reaches_the_renderer_as_note_edit_kept() {
    let f = opened();
    // The row names other bytes: an outside edit the note has not taken yet.
    let open = f.mocked.session().current().unwrap();
    open.vault
        .note_files()
        .set_hash(&f.id, Some("not-the-file"))
        .unwrap();

    let set = f.invoke(
        "properties_set",
        json!({
            "entityId": f.id,
            "properties": { "due": "2026-10-07", "stage": "Done" },
            "base": { "due": "2026-10-07", "stage": "Draft" },
        }),
    );
    let error = set.unwrap_err();
    assert_eq!(
        (&error["kind"], &error["code"]),
        (&json!("propertyWrite"), &json!("note_edit_kept"))
    );
    assert!(
        !error["message"].as_str().unwrap().contains("FileChanged"),
        "{error}"
    );
    assert_eq!(f.file(), NOTE);
}
