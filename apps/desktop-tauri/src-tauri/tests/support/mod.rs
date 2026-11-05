//! A mock app over a real vault, vault tier and note index, for the command tests that go
//! through the IPC a renderer calls (`journal_calendar.rs`, `properties.rs`), with the tier's
//! journal events forwarded as the app forwards them.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
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
use memry_tauri::shell::journal_events;
use serde_json::Value;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::broadcast::error::TryRecvError;

#[cfg(windows)]
const LOCAL_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
const LOCAL_ORIGIN: &str = "tauri://localhost";

pub const WAIT: Duration = Duration::from_secs(25);

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

pub struct Mocked {
    _dir: tempfile::TempDir,
    pub vault: PathBuf,
    pub webview: WebviewWindow<MockRuntime>,
}

impl Mocked {
    /// A vault holding `files` (vault-relative path, text), opened with its first walk done,
    /// and a webview whose IPC routes `commands` with the app's error handling.
    pub fn open(files: &[(&str, &str)], commands: tauri_specta::Builder<MockRuntime>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        for (rel, text) in files {
            let path = vault.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
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
        // The app is built after the open; the index's `landed` reaches it once it is.
        let handle: Arc<OnceLock<AppHandle<MockRuntime>>> = Arc::default();
        let lander = handle.clone();
        let index = NoteIndex::new(
            tier.clone(),
            |_| {},
            |_| {},
            move |note_id| {
                if let Some(app) = lander.get() {
                    journal_events::landed(app, note_id);
                }
            },
        );
        index.register(&session);
        let mut facts = tier.subscribe();
        session.open(&vault, OpenSource::Select).unwrap();
        let deadline = Instant::now() + WAIT;
        loop {
            match facts.try_recv() {
                Ok(Applied::Indexed { .. }) => break,
                Ok(_) | Err(TryRecvError::Lagged(_)) => continue,
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Closed) => panic!("the tier closed before the open walk ended"),
            }
            assert!(Instant::now() < deadline, "the open walk did not end");
            std::thread::sleep(Duration::from_millis(20));
        }

        let app = mock_builder()
            .invoke_handler(commands.invoke_handler())
            .build(mock_context(noop_assets()))
            .unwrap();
        app.manage(session);
        app.manage(index);
        app.manage(NotesService::new(tier.clone(), store));
        let _ = handle.set(app.handle().clone());
        journal_events::forward(app.handle().clone(), tier.subscribe());
        let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        std::mem::forget(app);
        Self {
            _dir: dir,
            vault,
            webview,
        }
    }

    pub fn session(&self) -> tauri::State<'_, Session> {
        self.webview.state::<Session>()
    }

    /// `cmd` invoked as the generated bindings invoke it, with `args` as the JSON body: the
    /// answer, or the serialized `CommandError` it threw.
    pub fn invoke(&self, cmd: &str, args: Value) -> Result<Value, Value> {
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
