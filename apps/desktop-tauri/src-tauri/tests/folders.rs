//! The folder commands through the IPC a renderer calls, on a mock app over a real vault and
//! vault tier (#3530 13h-1b): the argument names the generated bindings send, a created folder
//! and its settings read back, and a refused create or write reaching the renderer by its code.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::api::errors::SecureStoreError;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::vault::consumer::{Applied, VaultTier};
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_specta::{ErrorHandlingMode, collect_commands};

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
            memry_tauri::commands::folders::notes_get_folder_config::<MockRuntime>,
            memry_tauri::commands::folders::notes_get_folder_template::<MockRuntime>,
            memry_tauri::commands::folders::notes_get_folders::<MockRuntime>,
            memry_tauri::commands::folders::notes_set_folder_config::<MockRuntime>,
        ]);
    let app = mock_builder()
        .invoke_handler(commands.invoke_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    app.manage(session);
    app.manage(NotesService::new(tier, store));
    let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .build()
        .unwrap();
    std::mem::forget(app);
    Fixture {
        _dir: dir,
        vault,
        webview,
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
