//! `notes_import_files` (Step 32h1, #3549) through the IPC a renderer calls, on a mock app over
//! a real vault: a folder the call refuses reads no file and takes no pick, so the same picked
//! file imports on the retry.

#[allow(dead_code, reason = "only the open and invoke of the harness are used")]
mod support;

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use memry_desktop::import::source_paths::ImportGrants;
use serde_json::json;
use support::Mocked;
use tauri::Manager;
use tauri::test::MockRuntime;
use tauri_specta::collect_commands;

#[test]
fn a_refused_folder_leaves_the_picked_file_importable() {
    let commands = tauri_specta::Builder::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::notes_import::notes_import_files::<MockRuntime>,
        ]);
    let mocked = Mocked::open(&[], commands);
    let grants = Arc::new(ImportGrants::default());
    mocked.webview.manage(grants.clone());
    let outside = tempfile::tempdir().unwrap();
    let picked = outside.path().join("picked.md");
    fs::write(&picked, "picked").unwrap();
    grants.grant(std::slice::from_ref(&picked));
    let import = |folder: &str| {
        mocked.invoke(
            "notes_import_files",
            json!({ "input": { "sourcePaths": [picked.to_string_lossy()], "targetFolder": folder } }),
        )
    };

    let refused = import("../Escaped").expect_err("a folder outside the vault");
    let retried = import("In").expect("the retry");

    assert_eq!(refused["code"], "invalid_folder");
    assert_eq!(retried["imported"], 1, "{retried}");
    assert_eq!(
        fs::read_to_string(mocked.vault.join("In/picked.md")).unwrap(),
        "picked"
    );
    assert!(!PathBuf::from(outside.path()).join("Escaped").exists());
}
