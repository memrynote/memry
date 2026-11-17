//! `notes_export_html` through the IPC a renderer calls, on a mock app over a real vault, vault
//! tier and note index (#3551 stage B): the file written at `outputPath` keeps its image after it
//! moves (Electron's `note-export-images.e2e.ts`), the schema's defaults, and a missing note or
//! a failed write resolving with its `code`, as Electron's handler resolves them.
//! The save dialog path needs a native dialog; the e2e build's dialog queue drives it.

mod support;

use std::fs;

use serde_json::{Value, json};
use support::Mocked;
use tauri_specta::collect_commands;

/// A 1x1 PNG.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
    0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

const NOTE: &str = "---\ntags: [trip]\n---\nBefore the photo.\n\n![dot](../attachments/dot.png)\n\n- [ ] Pack {task:t1}\n";

struct Fixture {
    mocked: Mocked,
    id: String,
    out: tempfile::TempDir,
}

fn opened() -> Fixture {
    let commands = tauri_specta::Builder::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::export::notes_export_html::<tauri::test::MockRuntime>,
        ]);
    let mocked = Mocked::open(&[("Trips/Lisbon.md", NOTE)], commands);
    fs::create_dir_all(mocked.vault.join("attachments")).unwrap();
    fs::write(mocked.vault.join("attachments/dot.png"), PNG).unwrap();
    let id = mocked
        .session()
        .current()
        .unwrap()
        .vault
        .note_files()
        .by_path("Trips/Lisbon.md")
        .unwrap()
        .expect("a row for Trips/Lisbon.md")
        .note_id;
    Fixture {
        mocked,
        id,
        out: tempfile::tempdir().unwrap(),
    }
}

impl Fixture {
    fn export(&self, input: Value) -> Value {
        self.mocked
            .invoke("notes_export_html", json!({ "input": input }))
            .unwrap()
    }
}

#[test]
fn the_file_at_output_path_carries_its_image_after_it_moves() {
    let f = opened();
    let target = f.out.path().join("Lisbon.html");

    let result = f.export(json!({
        "noteId": f.id,
        "outputPath": target.to_string_lossy(),
    }));

    assert_eq!(
        result,
        json!({ "success": true, "path": target.to_string_lossy() })
    );
    let moved = f.out.path().join("elsewhere.html");
    fs::rename(&target, &moved).unwrap();
    let html = fs::read_to_string(&moved).unwrap();
    assert!(html.contains("<title>Lisbon</title>"), "{html}");
    assert!(html.contains("src=\"data:image/png;base64,"), "{html}");
    assert!(!html.contains("../attachments/dot.png"), "{html}");
    // `includeMetadata` defaults on, `includeTaskMarkers` off.
    assert!(html.contains("<div class=\"note-tags\">"), "{html}");
    assert!(!html.contains("{task:t1}"), "{html}");
}

#[test]
fn the_switches_reach_the_document() {
    let f = opened();
    let target = f.out.path().join("bare.html");

    let result = f.export(json!({
        "noteId": f.id,
        "includeMetadata": false,
        "includeTaskMarkers": true,
        "pageSize": "Letter",
        "outputPath": target.to_string_lossy(),
    }));

    assert_eq!(result["success"], json!(true));
    let html = fs::read_to_string(&target).unwrap();
    assert!(!html.contains("<div class=\"note-tags\">"), "{html}");
    assert!(html.contains("{task:t1}"), "{html}");
}

#[test]
fn a_missing_note_resolves_not_found_and_writes_nothing() {
    let f = opened();
    let target = f.out.path().join("none.html");

    let result = f.export(json!({
        "noteId": "no-such-note",
        "outputPath": target.to_string_lossy(),
    }));

    assert_eq!(
        result,
        json!({ "success": false, "code": "not_found", "error": "Note not found" })
    );
    assert!(!target.exists());
}

#[test]
fn a_failed_write_resolves_failed_with_the_reason() {
    let f = opened();
    let target = f.out.path().join("missing-dir/Lisbon.html");

    let result = f.export(json!({
        "noteId": f.id,
        "outputPath": target.to_string_lossy(),
    }));

    assert_eq!(result["success"], json!(false));
    assert_eq!(result["code"], json!("failed"));
    assert!(!result["error"].as_str().unwrap().is_empty(), "{result}");
    assert!(result.get("path").is_none(), "{result}");
}
