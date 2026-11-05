//! The note frontmatter commands that replace `window.api` calls (#3530 13q) through the IPC a
//! renderer calls, on a mock app over a real vault, vault tier and note index:
//! `notes_edit_aliases` (13q-1) with the argument names the generated bindings send, the file
//! and the answer, and a refused edit reaching the renderer by its code.

mod support;

use std::fs;

use serde_json::{Value, json};
use support::Mocked;
use tauri_specta::collect_commands;

const NOTE: &str = "---\ntags: [x]\naliases: [AI]\nstage: Draft\n---\nThe body.\n";

struct Fixture {
    mocked: Mocked,
    id: String,
}

/// A vault holding `Plan.md`, opened with its first walk done, and a webview whose IPC routes
/// the commands under test.
fn opened() -> Fixture {
    // As `registry::builder` lists them, with its error handling.
    let commands = tauri_specta::Builder::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::notes::notes_edit_aliases::<tauri::test::MockRuntime>,
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
fn an_alias_edit_through_the_ipc_lands_in_the_file_and_answers_the_names() {
    let f = opened();
    let edited = f.invoke(
        "notes_edit_aliases",
        json!({ "input": { "id": f.id, "add": ["Machine learning"], "remove": ["ai"] } }),
    );
    assert_eq!(edited, Ok(json!({ "aliases": ["Machine learning"] })));
    assert_eq!(
        f.file(),
        "---\ntags: [x]\naliases:\n  - Machine learning\nstage: Draft\n---\nThe body.\n"
    );

    let unknown = f.invoke(
        "notes_edit_aliases",
        json!({ "input": { "id": "n-none", "add": ["X"], "remove": [] } }),
    );
    assert_eq!(unknown.unwrap_err()["code"], "note_not_found");
}

#[test]
fn an_alias_edit_the_seam_keeps_reaches_the_renderer_as_note_edit_kept() {
    let f = opened();
    let open = f.mocked.session().current().unwrap();
    open.vault
        .note_files()
        .set_hash(&f.id, Some("not-the-file"))
        .unwrap();
    let edited = f.invoke(
        "notes_edit_aliases",
        json!({ "input": { "id": f.id, "add": ["Other"], "remove": [] } }),
    );
    assert_eq!(edited.unwrap_err()["code"], "note_edit_kept");
    assert_eq!(f.file(), NOTE);
}
