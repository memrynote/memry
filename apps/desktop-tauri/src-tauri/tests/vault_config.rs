//! The vault settings through the IPC a renderer calls, on a mock app over a real vault (#3530
//! 13m-7a, 13m-7b): the contract's field names, a write every window hears as
//! `vault:config-changed`, the journal days moved with a new format or folder, new exclude
//! patterns saved with every note kept, and a refused change with nothing written or sent.

mod support;

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
            memry_tauri::commands::journal::journal_create_entry::<MockRuntime>,
            memry_tauri::commands::journal::journal_update_entry::<MockRuntime>,
            memry_tauri::commands::folders::notes_rename_folder::<MockRuntime>,
            memry_tauri::commands::folders::notes_delete_folder::<MockRuntime>,
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

/// A new journal folder moves the days into it before it is saved, and every window hears it.
#[test]
fn a_journal_folder_change_moves_the_days_and_sends_the_new_folder() {
    let (mocked, heard) = opened();
    let answer = mocked
        .invoke(
            "vault_update_config",
            json!({ "config": { "journalFolder": "Diary" } }),
        )
        .unwrap();
    assert_eq!(answer["journalFolder"], "Diary");
    assert_eq!(*heard.lock().unwrap(), [answer]);
    assert!(!mocked.vault.join("Daily/2025-01-02.md").exists());
    assert_eq!(
        fs::read_to_string(mocked.vault.join("Diary/2025-01-02.md")).unwrap(),
        "A day.\n"
    );
}

/// A folder the days cannot live in, and the journal folder respelled in case only, are each
/// refused in their own words, which Settings shows, and nothing is sent.
#[test]
fn a_journal_folder_the_days_cannot_live_in_is_refused_in_words() {
    let (mocked, heard) = opened();
    let refusals = [
        (
            ".hidden",
            "journal_folder_invalid",
            "The journal can't be kept in this folder",
        ),
        (
            "daily",
            "journal_folder_respelled",
            "The journal folder name differs only in",
        ),
    ];
    for (folder, code, words) in refusals {
        let refused = mocked
            .invoke(
                "vault_update_config",
                json!({ "config": { "journalFolder": folder } }),
            )
            .unwrap_err();
        assert_eq!(
            (&refused["kind"], &refused["code"]),
            (&json!("invalid"), &json!(code))
        );
        assert!(
            refused["message"].as_str().unwrap().starts_with(words),
            "{refused}"
        );
    }
    assert!(mocked.vault.join("Daily/2025-01-02.md").exists());
    assert!(heard.lock().unwrap().is_empty());
}

/// New exclude patterns are saved and sent, and the note in the folder they now drop keeps its
/// row: the watcher restarts on them, and nothing is deleted.
#[test]
fn an_exclude_change_is_saved_sent_and_keeps_the_notes() {
    let (mocked, heard) = opened();
    let answer = mocked
        .invoke(
            "vault_update_config",
            json!({ "config": { "excludePatterns": ["Daily"] } }),
        )
        .unwrap();
    assert_eq!(answer["excludePatterns"], json!(["Daily"]));
    assert_eq!(*heard.lock().unwrap(), [answer]);
    let file: Value =
        serde_json::from_slice(&fs::read(mocked.vault.join(".memry/config.json")).unwrap())
            .unwrap();
    assert_eq!(file["excludePatterns"], json!(["Daily"]));
    let open = mocked.session().current().unwrap();
    let row = open
        .vault
        .note_files()
        .by_path("Daily/2025-01-02.md")
        .unwrap();
    assert!(row.is_some());
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
            .contains("some journal days (1) couldn't be moved."),
        "{refused}"
    );
    assert_eq!(
        fs::read_to_string(mocked.vault.join("Daily/2025-01-02.md")).unwrap(),
        "A day.\n"
    );
    assert!(heard.lock().unwrap().is_empty());
}

/// A journal folder that cannot be listed refuses the format with a message Settings can show,
/// not the system error's text.
#[cfg(unix)]
#[test]
fn a_journal_folder_that_cannot_be_listed_is_refused_in_words() {
    use std::os::unix::fs::PermissionsExt as _;

    let (mocked, heard) = opened();
    let daily = mocked.vault.join("Daily");
    fs::set_permissions(&daily, fs::Permissions::from_mode(0o000)).unwrap();
    let refused = mocked.invoke(
        "vault_update_config",
        json!({ "config": { "journalDateFormat": "YYYY-MM-DD dddd" } }),
    );
    fs::set_permissions(&daily, fs::Permissions::from_mode(0o755)).unwrap();

    let refused = refused.unwrap_err();
    assert_eq!(
        (&refused["kind"], &refused["code"]),
        (&json!("storage"), &json!("journal_unlisted"))
    );
    assert!(
        refused["message"]
            .as_str()
            .unwrap()
            .starts_with("The journal folder couldn't be read"),
        "{refused}"
    );
    assert!(heard.lock().unwrap().is_empty());
}

/// The journal folder moved outside the app: once the watcher's batch is applied, the setting
/// follows it, and every window hears the folder that followed.
#[test]
fn a_journal_folder_moved_outside_is_followed_and_every_window_hears_it() {
    let (mocked, heard) = opened();
    fs::rename(mocked.vault.join("Daily"), mocked.vault.join("Diary")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while heard.lock().unwrap().is_empty() {
        assert!(Instant::now() < deadline, "the follow was not heard");
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(500));
    let heard = heard.lock().unwrap();
    assert_eq!(heard.len(), 1, "{heard:?}");
    assert_eq!(heard[0]["journalFolder"], "Diary");
}

/// The journal folder moved outside the app while the settings could not be read, so the
/// watcher's batch followed nothing: each command that has the setting follow first lets every
/// window hear the folder that followed, whether it then goes through, changes nothing or is
/// refused.
#[test]
fn a_command_that_follows_the_journal_folder_first_is_heard() {
    // The command, its arguments, and the journal folder every window hears.
    let commands: [(&str, Value, &str); 7] = [
        (
            "journal_create_entry",
            json!({ "input": { "date": "2025-01-07" } }),
            "Diary",
        ),
        (
            "journal_update_entry",
            json!({ "input": { "date": "2025-01-07", "content": "Typed." } }),
            "Diary",
        ),
        (
            "notes_rename_folder",
            json!({ "oldPath": "Apart", "newPath": "Moved" }),
            "Diary",
        ),
        ("notes_delete_folder", json!({ "path": "Diary" }), "Diary"),
        (
            "vault_update_config",
            json!({ "config": { "preferences": { "theme": "dark" } } }),
            "Diary",
        ),
        (
            "vault_update_config",
            json!({ "config": { "journalFolder": "canvases" } }),
            "Diary",
        ),
        (
            "vault_update_config",
            json!({ "config": { "journalFolder": "Other" } }),
            "Other",
        ),
    ];
    for (command, args, folder) in commands {
        let (mocked, heard) = opened();
        let config = mocked.vault.join(".memry/config.json");
        let saved = fs::read_to_string(&config).unwrap();
        fs::write(&config, "{").unwrap();
        fs::create_dir(mocked.vault.join("Apart")).unwrap();
        fs::rename(mocked.vault.join("Daily"), mocked.vault.join("Diary")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !held(&mocked) {
            assert!(Instant::now() < deadline, "{command}: the day was not held");
            std::thread::sleep(Duration::from_millis(50));
        }
        std::thread::sleep(Duration::from_millis(500));
        fs::write(&config, saved).unwrap();
        assert!(heard.lock().unwrap().is_empty(), "{command}");
        let _ = mocked.invoke(command, args.clone());
        let heard = heard.lock().unwrap();
        assert_eq!(heard.len(), 1, "{command} {args}: {heard:?}");
        assert_eq!(heard[0]["journalFolder"], folder, "{command} {args}");
    }
}

/// Whether the watcher took the day's move: its row at the moved folder.
fn held(mocked: &Mocked) -> bool {
    let open = mocked.session().current().unwrap();
    open.vault
        .note_files()
        .list_paths()
        .unwrap()
        .iter()
        .any(|(_, path)| path == "Diary/2025-01-02.md")
}
