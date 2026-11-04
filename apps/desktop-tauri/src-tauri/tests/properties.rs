//! The `properties_*` commands through the IPC a renderer calls, on a mock app over a real vault,
//! vault tier and note index (#3530 13k-3): the argument names the generated bindings send, a
//! merge and a rename landing in the note's file, and a refused edit reaching the renderer by
//! its code.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::api::errors::SecureStoreError;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
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

const NOTE: &str = "---\ntags: [x]\ndue: 2026-10-07\nstage: Draft\n---\nThe body.\n";

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
    id: String,
}

/// A vault holding `Plan.md`, opened with its first walk and index pass done, and a webview whose
/// IPC routes the four property commands.
fn opened() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::write(vault.join("Plan.md"), NOTE).unwrap();
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
    NoteIndex::new(tier.clone(), |_| {}, |_| {}).register(&session);
    let mut facts = tier.subscribe();
    session.open(&vault, OpenSource::Select).unwrap();
    let deadline = Instant::now() + WAIT;
    while !matches!(facts.try_recv(), Ok(Applied::Indexed { .. })) {
        assert!(Instant::now() < deadline, "the open walk did not end");
        std::thread::sleep(Duration::from_millis(20));
    }
    let open = session.current().unwrap();
    let id = open
        .vault
        .note_files()
        .by_path("Plan.md")
        .unwrap()
        .expect("a row for Plan.md")
        .note_id;

    // As `registry::builder` lists them, with its error handling.
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::properties::properties_get::<MockRuntime>,
            memry_tauri::commands::properties::properties_merge::<MockRuntime>,
            memry_tauri::commands::properties::properties_rename::<MockRuntime>,
            memry_tauri::commands::properties::properties_set::<MockRuntime>,
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
        id,
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

    fn file(&self) -> String {
        fs::read_to_string(self.vault.join("Plan.md")).unwrap()
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
    let open = f.webview.state::<Session>().current().unwrap();
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
