//! The vault settings through the IPC a renderer calls, on a mock app over a real vault (#3530
//! 13m-7a): the contract's field names, a write every window hears as `vault:config-changed`,
//! and a change that is not ported refused by its code with nothing written or sent.

mod support;

use std::fs;
use std::sync::{Arc, Mutex};

use memry_tauri::events::VaultConfigChangedEvent;
use serde_json::{Value, json};
use support::Mocked;
use tauri::Listener;
use tauri::test::MockRuntime;
use tauri_specta::Event;
use tauri_specta::{ErrorHandlingMode, collect_commands};

/// A vault whose config names its journal folder, and every config event its app sends.
fn opened() -> (Mocked, Arc<Mutex<Vec<Value>>>) {
    // As `registry::builder` lists them, with its error handling.
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::vault::vault_get_config::<MockRuntime>,
            memry_tauri::commands::vault::vault_update_config::<MockRuntime>,
        ]);
    let mocked = Mocked::open(
        &[
            (
                ".memry/config.json",
                r#"{"journalFolder":"/Daily/","preferences":{"theme":"dark"}}"#,
            ),
            ("Daily/2025-01-02.md", "A day.\n"),
        ],
        commands,
    );
    let heard: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = heard.clone();
    mocked
        .webview
        .listen_any(VaultConfigChangedEvent::NAME, move |event| {
            sink.lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        });
    (mocked, heard)
}

#[test]
fn a_write_answers_the_settings_and_every_window_hears_them() {
    let (mocked, heard) = opened();
    let read = mocked.invoke("vault_get_config", json!({})).unwrap();
    assert_eq!(read["journalFolder"], "Daily");

    let written = mocked
        .invoke(
            "vault_update_config",
            json!({ "config": { "journalShowInSidebar": true, "defaultNoteFolder": "inbox" } }),
        )
        .unwrap();
    let mut expected = read.clone();
    expected["journalShowInSidebar"] = json!(true);
    expected["defaultNoteFolder"] = json!("inbox");
    assert_eq!(written, expected);
    assert_eq!(*heard.lock().unwrap(), [expected]);
    let file: Value =
        serde_json::from_slice(&fs::read(mocked.vault.join(".memry/config.json")).unwrap())
            .unwrap();
    assert_eq!(file["preferences"], json!({ "theme": "dark" }));
}

#[test]
fn a_journal_folder_change_is_refused_and_nothing_is_sent() {
    let (mocked, heard) = opened();
    let before = fs::read(mocked.vault.join(".memry/config.json")).unwrap();
    let refused = mocked
        .invoke(
            "vault_update_config",
            json!({ "config": { "journalFolder": "Diary", "journalShowInSidebar": true } }),
        )
        .unwrap_err();
    assert_eq!(
        (&refused["kind"], &refused["code"]),
        (&json!("invalid"), &json!("config_change_not_ported"))
    );
    assert!(
        refused["message"]
            .as_str()
            .unwrap()
            .starts_with("This version can't change the journal folder"),
        "{refused}"
    );
    assert_eq!(
        fs::read(mocked.vault.join(".memry/config.json")).unwrap(),
        before
    );
    assert!(heard.lock().unwrap().is_empty());
}

/// With no vault open a read answers Electron's fallback, which has no exclude patterns, and a
/// write is refused.
#[test]
fn with_no_vault_open_a_read_answers_the_fallback_and_a_write_is_refused() {
    let (mocked, heard) = opened();
    mocked.session().close();
    let read = mocked.invoke("vault_get_config", json!({})).unwrap();
    assert_eq!(
        (&read["excludePatterns"], &read["journalFolder"]),
        (&json!([]), &json!("journal"))
    );
    let refused = mocked
        .invoke(
            "vault_update_config",
            json!({ "config": { "journalShowInSidebar": true } }),
        )
        .unwrap_err();
    assert_eq!(refused["code"], "no_vault_open");
    assert!(heard.lock().unwrap().is_empty());
}

/// The journal folder again, in another spelling, is no change: nothing is written or sent.
#[test]
fn the_current_journal_folder_again_writes_and_sends_nothing() {
    let (mocked, heard) = opened();
    let before = fs::read(mocked.vault.join(".memry/config.json")).unwrap();
    let answer = mocked
        .invoke(
            "vault_update_config",
            json!({ "config": { "journalFolder": "Daily/" } }),
        )
        .unwrap();
    assert_eq!(answer["journalFolder"], "Daily");
    assert_eq!(
        fs::read(mocked.vault.join(".memry/config.json")).unwrap(),
        before
    );
    assert!(heard.lock().unwrap().is_empty());
}

/// A new date format renames the day files to it before it is saved, and every window hears it.
#[test]
fn a_date_format_change_renames_the_days_and_sends_the_new_format() {
    let (mocked, heard) = opened();
    let answer = mocked
        .invoke(
            "vault_update_config",
            json!({ "config": { "journalDateFormat": "YYYY-MM-DD dddd" } }),
        )
        .unwrap();
    assert_eq!(answer["journalDateFormat"], "YYYY-MM-DD dddd");
    assert_eq!(*heard.lock().unwrap(), [answer]);
    assert!(!mocked.vault.join("Daily/2025-01-02.md").exists());
    assert_eq!(
        fs::read_to_string(mocked.vault.join("Daily/2025-01-02 Thursday.md")).unwrap(),
        "A day.\n"
    );
}

/// A day that cannot take the new format's name refuses the format with the count Settings
/// shows, the day keeps its name, and nothing is sent.
#[test]
fn a_format_a_day_cannot_take_is_refused_with_the_count() {
    let (mocked, heard) = opened();
    fs::write(
        mocked.vault.join("Daily/2025-01-02 Thursday.md"),
        "A note.\n",
    )
    .unwrap();
    let refused = mocked
        .invoke(
            "vault_update_config",
            json!({ "config": { "journalDateFormat": "YYYY-MM-DD dddd" } }),
        )
        .unwrap_err();
    assert_eq!(
        (&refused["kind"], &refused["code"]),
        (&json!("storage"), &json!("journal_days_not_renamed"))
    );
    assert!(
        refused["message"]
            .as_str()
            .unwrap()
            .contains("renamed to it (1)."),
        "{refused}"
    );
    assert_eq!(
        fs::read_to_string(mocked.vault.join("Daily/2025-01-02.md")).unwrap(),
        "A day.\n"
    );
    assert!(heard.lock().unwrap().is_empty());
}
