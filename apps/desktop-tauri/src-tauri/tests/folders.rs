//! The folder commands through the IPC a renderer calls, on a mock app over a real vault and
//! vault tier (#3530 13h-1b, 13h-2): the argument names the generated bindings send, a created
//! folder, its settings and its rename read back, and a refusal reaching the renderer by its
//! code. A pulled folder (#3906) reaches the vault and goes out as `FolderConfigUpdatedEvent`, and
//! a journal setting that follows a folder move as `VaultConfigChangedEvent` (#3530 13m-7b-2).

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::api::errors::SecureStoreError;
use memry_core::crypto::sodium;
use memry_core::domain::folders;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::vault::consumer::{Applied, VaultTier};
use memry_tauri::events::{FolderConfigUpdatedEvent, VaultConfigChangedEvent};
use memry_tauri::shell::folder_sync;
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_specta::{ErrorHandlingMode, Event, collect_commands};

#[cfg(windows)]
const LOCAL_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
const LOCAL_ORIGIN: &str = "tauri://localhost";

const WAIT: Duration = Duration::from_secs(25);

#[derive(Default)]
struct MemoryStore(Mutex<HashMap<SecureStoreKey, Vec<u8>>>);

impl SecureStore for MemoryStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self.0.lock().unwrap().get(&key).cloned())
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().insert(key, value);
        Ok(())
    }

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().remove(&key);
        Ok(())
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().clear();
        Ok(())
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    vault: PathBuf,
    webview: WebviewWindow<MockRuntime>,
    app: AppHandle<MockRuntime>,
}

/// An empty vault, opened with its first walk done, and a webview whose IPC routes the folder
/// commands a mock runtime can run.
fn opened() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::create_dir_all(dir.path().join("app")).unwrap();
    let store: Arc<dyn SecureStore> = Arc::new(MemoryStore::default());
    let (_, secret) = sodium::sign_seed_keypair(&[7u8; 32]).unwrap();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .unwrap();
    let config = AppConfig::load(dir.path().join("app/memry-config.json"));
    let session = Session::new(VaultRegistry::new(Arc::new(config)));
    let tier = VaultTier::new(store.clone());
    tier.set_identity(NotesIdentity::new(store.clone()));
    tier.register(&session);
    let mut facts = tier.subscribe();
    session.open(&vault, OpenSource::Select).unwrap();
    let deadline = Instant::now() + WAIT;
    while !matches!(facts.try_recv(), Ok(Applied::Indexed { .. })) {
        assert!(Instant::now() < deadline, "the open walk did not end");
        std::thread::sleep(Duration::from_millis(20));
    }

    // As `registry::builder` lists them, with its error handling.
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::folders::notes_create_folder::<MockRuntime>,
            memry_tauri::commands::folders::notes_delete_folder::<MockRuntime>,
            memry_tauri::commands::folders::notes_get_folder_config::<MockRuntime>,
            memry_tauri::commands::folders::notes_get_folder_template::<MockRuntime>,
            memry_tauri::commands::folders::notes_get_folders::<MockRuntime>,
            memry_tauri::commands::folders::notes_rename_folder::<MockRuntime>,
            memry_tauri::commands::folders::notes_set_folder_config::<MockRuntime>,
            memry_tauri::commands::journal::journal_create_entry::<MockRuntime>,
        ]);
    let app = mock_builder()
        .invoke_handler(commands.invoke_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    app.manage(session);
    app.manage(NotesService::new(tier, store));
    app.manage(Arc::new(LocaleService::new("en")));
    let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .build()
        .unwrap();
    let handle = app.handle().clone();
    std::mem::forget(app);
    Fixture {
        _dir: dir,
        vault,
        webview,
        app: handle,
    }
}

impl Fixture {
    /// `cmd` invoked as the generated bindings invoke it, with `args` as the JSON body: the
    /// answer, or the serialized `CommandError` it threw.
    fn invoke(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        let request = InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: LOCAL_ORIGIN.parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: tauri::http::HeaderMap::new(),
            invoke_key: INVOKE_KEY.to_string(),
        };
        get_ipc_response(&self.webview, request).map(|body| match body {
            InvokeResponseBody::Json(json) => serde_json::from_str(&json).unwrap(),
            InvokeResponseBody::Raw(_) => panic!("{cmd} answered raw bytes"),
        })
    }
}

#[test]
fn a_folder_created_and_set_through_the_ipc_reads_back() {
    let f = opened();
    let created = f.invoke("notes_create_folder", json!({ "path": "Work/Plans" }));
    assert_eq!(created, Ok(Value::Null));
    let set = f.invoke(
        "notes_set_folder_config",
        json!({
            "folderPath": "Work",
            "config": { "icon": "lucide:book", "template": "daily" },
        }),
    );
    assert_eq!(set, Ok(Value::Null));

    assert_eq!(
        f.invoke("notes_get_folders", json!({})),
        Ok(json!([
            { "path": "Work", "icon": "lucide:book" },
            { "path": "Work/Plans", "icon": null },
        ]))
    );
    assert_eq!(
        f.invoke("notes_get_folder_config", json!({ "folderPath": "Work" })),
        Ok(json!({ "icon": "lucide:book", "template": "daily", "inherit": true }))
    );
    assert_eq!(
        f.invoke(
            "notes_get_folder_template",
            json!({ "folderPath": "Work/Plans" })
        ),
        Ok(json!("daily"))
    );

    let renamed = f.invoke(
        "notes_rename_folder",
        json!({ "oldPath": "Work/Plans", "newPath": "Work/Later" }),
    );
    assert_eq!(renamed, Ok(Value::Null));
    assert!(f.vault.join("Work/Later").is_dir());
    let gone = f.invoke(
        "notes_rename_folder",
        json!({ "oldPath": "Work/Plans", "newPath": "Work/Again" }),
    );
    assert_eq!(gone.unwrap_err()["code"], "folder_not_found");
    // The refusal only: a delete that went through would use the OS trash of the machine.
    let missing = f.invoke("notes_delete_folder", json!({ "path": "Work/Plans" }));
    assert_eq!(missing.unwrap_err()["code"], "folder_not_found");
}

/// A folder that holds the journal takes the journal setting along, which every window hears as
/// `vault:config-changed` (Electron's `followJournalFolder`).
#[test]
fn a_folder_holding_the_journal_sends_the_setting_that_followed_it() {
    let f = opened();
    fs::write(
        f.vault.join(".memry/config.json"),
        r#"{"journalFolder":"Personal/journal"}"#,
    )
    .unwrap();
    fs::create_dir_all(f.vault.join("Personal/journal")).unwrap();
    let heard: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = heard.clone();
    f.webview
        .listen_any(VaultConfigChangedEvent::NAME, move |event| {
            sink.lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        });

    let renamed = f.invoke(
        "notes_rename_folder",
        json!({ "oldPath": "Personal", "newPath": "Private" }),
    );

    assert_eq!(renamed, Ok(Value::Null));
    let heard = heard.lock().unwrap();
    assert_eq!(heard.len(), 1, "{heard:?}");
    assert_eq!(heard[0]["journalFolder"], "Private/journal");
}

/// Settings that cannot be read refuse every folder move and delete, and a day create, each in
/// words that name what was refused and the file to fix.
#[test]
fn a_folder_move_with_unreadable_settings_says_which_file_to_fix() {
    let f = opened();
    f.invoke("notes_create_folder", json!({ "path": "Work" }))
        .unwrap();
    fs::write(f.vault.join(".memry/config.json"), "{").unwrap();

    let moved = f.invoke(
        "notes_rename_folder",
        json!({ "oldPath": "Work", "newPath": "Play" }),
    );
    let deleted = f.invoke("notes_delete_folder", json!({ "path": "Work" }));
    let day = f.invoke(
        "journal_create_entry",
        json!({ "input": { "date": "2025-01-06" } }),
    );

    let refusals = [
        (moved.unwrap_err(), "moved"),
        (deleted.unwrap_err(), "deleted"),
        (day.unwrap_err(), "Journal days"),
    ];
    for (refused, says) in refusals {
        assert_eq!(refused["code"], "vault_settings_unreadable");
        let message = refused["message"].as_str().unwrap_or_default();
        assert!(message.contains(".memry/config.json"), "{refused}");
        assert!(message.contains(says), "{refused}");
    }
    assert!(f.vault.join("Work").exists());
}

#[test]
fn a_refused_create_or_write_reaches_the_renderer_by_its_code() {
    let f = opened();
    f.invoke("notes_create_folder", json!({ "path": "Work" }))
        .unwrap();
    let respelled = f.invoke("notes_create_folder", json!({ "path": "work" }));
    assert_eq!(respelled.unwrap_err()["code"], "name_conflict");

    fs::write(f.vault.join("Work/.folder.md"), "---\nviews: [\n---\n").unwrap();
    let refused = f.invoke(
        "notes_set_folder_config",
        json!({ "folderPath": "Work", "config": { "icon": "x" } }),
    );
    assert_eq!(refused.unwrap_err()["code"], "folder_file_unreadable");
    assert_eq!(
        fs::read_to_string(f.vault.join("Work/.folder.md")).unwrap(),
        "---\nviews: [\n---\n"
    );
}

#[test]
fn a_pulled_folder_reaches_the_vault_and_the_renderer_hears_of_it() {
    let f = opened();
    let heard = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&heard);
    f.app
        .listen_any(FolderConfigUpdatedEvent::NAME, move |event| {
            sink.lock().unwrap().push(event.payload().to_owned());
        });
    let heard = || std::mem::take(&mut *heard.lock().unwrap());

    tauri::async_runtime::block_on(folder_sync::remote_folder_applied(
        f.app.clone(),
        "Remote/Plans".to_owned(),
        Some("lucide:book".to_owned()),
    ));
    assert_eq!(heard(), [r#"{"path":"Remote/Plans"}"#]);
    assert_eq!(
        fs::read_to_string(f.vault.join("Remote/Plans/.folder.md")).unwrap(),
        "---\nicon: 'lucide:book'\n---\n\n"
    );

    // As the pull leaves it: the record applied, then its delete.
    let vault = f.app.state::<Session>().current().unwrap().vault;
    vault
        .db_handle()
        .call_blocking(|conn| {
            folders::create(conn, "Remote/Plans", Some("lucide:book"), "other-device", 1)?;
            folders::delete_tree(conn, "Remote/Plans", "other-device", 2).map(drop)
        })
        .unwrap();
    tauri::async_runtime::block_on(folder_sync::remote_folder_deleted(
        f.app.clone(),
        "Remote/Plans".to_owned(),
    ));
    assert_eq!(heard(), [r#"{"path":"Remote/Plans"}"#]);
    assert!(!f.vault.join("Remote/Plans").exists());
    assert!(
        f.vault.join("Remote").is_dir(),
        "a folder with no tombstone stays"
    );

    // As a pull leaves a delete of a folder this device has no record of: no record, no clock.
    fs::create_dir(f.vault.join("Remote/Unknown")).unwrap();
    tauri::async_runtime::block_on(folder_sync::remote_folder_deleted(
        f.app.clone(),
        "Remote/Unknown".to_owned(),
    ));
    assert_eq!(heard(), [r#"{"path":"Remote/Unknown"}"#]);
    assert!(!f.vault.join("Remote/Unknown").exists());
}
