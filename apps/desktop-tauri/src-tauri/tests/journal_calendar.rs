//! The journal calendar's commands through the IPC a renderer calls, on a mock app over a real
//! vault, vault tier and note index (#3530 13m-4): the argument names the generated bindings
//! send, the contract's field names in the answers, and a year out of range refused by its code.

use std::collections::HashMap;
use std::fs;
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

/// A vault holding one day file, opened with its first walk done and the file measured, and a
/// webview whose IPC routes the four calendar commands.
fn opened(dir: &tempfile::TempDir) -> WebviewWindow<MockRuntime> {
    let vault = dir.path().join("vault");
    fs::create_dir_all(vault.join("journal")).unwrap();
    fs::write(
        vault.join("journal/2025-03-03.md"),
        "---\ntags: [walk]\n---\nA walk.\n",
    )
    .unwrap();
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
    let open = session.current().unwrap();
    let mut walked = false;
    while !walked || open.search.note_stats("j2025-03-03").unwrap().is_none() {
        assert!(Instant::now() < deadline, "the day file was not measured");
        walked |= matches!(facts.try_recv(), Ok(Applied::Indexed { .. }));
        std::thread::sleep(Duration::from_millis(20));
    }

    // As `registry::builder` lists them, with its error handling.
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::journal::journal_get_heatmap::<MockRuntime>,
            memry_tauri::commands::journal::journal_get_month_entries::<MockRuntime>,
            memry_tauri::commands::journal::journal_get_streak::<MockRuntime>,
            memry_tauri::commands::journal::journal_get_year_stats::<MockRuntime>,
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
    webview
}

/// `cmd` invoked as the generated bindings invoke it: the answer, or the `CommandError` thrown.
fn invoke(webview: &WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> Result<Value, Value> {
    let request = InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: LOCAL_ORIGIN.parse().unwrap(),
        body: InvokeBody::Json(args),
        headers: tauri::http::HeaderMap::new(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(webview, request).map(|body| match body {
        InvokeResponseBody::Json(json) => serde_json::from_str(&json).unwrap(),
        InvokeResponseBody::Raw(_) => panic!("{cmd} answered raw bytes"),
    })
}

#[test]
fn the_calendar_commands_answer_the_contracts_shapes() {
    let dir = tempfile::tempdir().unwrap();
    let webview = opened(&dir);
    let call = |cmd: &str, args: Value| invoke(&webview, cmd, args);

    assert_eq!(
        call("journal_get_heatmap", json!({ "year": 2025 })),
        Ok(json!([{ "date": "2025-03-03", "characterCount": 8, "level": 1 }]))
    );
    assert_eq!(
        call(
            "journal_get_month_entries",
            json!({ "year": 2025, "month": 3 })
        ),
        Ok(json!([{
            "date": "2025-03-03",
            "preview": "A walk.",
            "wordCount": 2,
            "characterCount": 8,
            "activityLevel": 1,
            "tags": ["walk"],
        }]))
    );
    assert_eq!(
        call("journal_get_year_stats", json!({ "year": 2025 })),
        Ok(json!([{
            "year": 2025,
            "month": 3,
            "entryCount": 1,
            "totalWordCount": 2,
            "totalCharacterCount": 8,
            "averageLevel": 1.0,
        }]))
    );
    assert_eq!(
        call("journal_get_streak", json!({})),
        Ok(json!({ "currentStreak": 0, "longestStreak": 1, "lastEntryDate": "2025-03-03" }))
    );

    let refused = call("journal_get_heatmap", json!({ "year": 1969 })).unwrap_err();
    assert_eq!(
        (&refused["kind"], &refused["code"]),
        (&json!("invalid"), &json!("invalid"))
    );
}
