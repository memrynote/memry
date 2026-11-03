//! `notes_link_mention` through the IPC on a mock app over a real vault and vault tier
//! (#3530 13i-5): the renderer's camelCase arguments, the file rewritten, the
//! `NoteUpdatedEvent` with `source: external` the link's row fact sends through the shell's
//! note events, `false` for a mention that is gone, and an unknown note's error code.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::api::errors::SecureStoreError;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::vault::consumer::{Applied, VaultTier};
use memry_tauri::commands::notes::notes_link_mention;
// The command's handler macros, which `#[tauri::command]` exports at the crate root.
use memry_tauri::events::NoteUpdatedEvent;
use memry_tauri::shell::note_events;
use memry_tauri::{__cmd__notes_link_mention, __tauri_command_name_notes_link_mention};
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_specta::Event;

const WAIT: Duration = Duration::from_secs(25);

// The origin Tauri treats as local; ACL rejects app commands from any other.
#[cfg(windows)]
const LOCAL_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
const LOCAL_ORIGIN: &str = "tauri://localhost";

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
    window: WebviewWindow<MockRuntime>,
    notes: Arc<NotesService>,
    updated: Arc<Mutex<Vec<Value>>>,
}

/// An open vault with its first walk done, its tier's note events forwarded, every
/// `NoteUpdatedEvent` heard, and `notes_link_mention` behind the IPC of a window.
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

    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![notes_link_mention])
        .build(mock_context(noop_assets()))
        .expect("mock app");
    app.manage(session);
    let notes = NotesService::new(tier.clone(), store);
    app.manage(notes.clone());
    note_events::forward(app.handle().clone(), tier.subscribe());
    let updated = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&updated);
    app.listen_any(NoteUpdatedEvent::NAME, move |event| {
        let payload = serde_json::from_str(event.payload()).unwrap();
        sink.lock().unwrap().push(payload);
    });
    let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .build()
        .expect("window");
    // The app must outlive the window handle.
    std::mem::forget(app);
    Fixture {
        _dir: dir,
        vault,
        window,
        notes,
        updated,
    }
}

impl Fixture {
    fn create(&self, title: &str, content: &str) -> String {
        let open = self.window.state::<Session>().current().unwrap();
        let note = NewNoteFile {
            title: title.into(),
            content: content.into(),
            ..NewNoteFile::default()
        };
        self.notes.create(&open, note).unwrap().id
    }

    /// `notes_link_mention` as the renderer calls it.
    fn link(&self, source: &str, target: &str, ordinal: u32) -> Result<bool, Value> {
        let body = json!({ "sourceId": source, "targetId": target, "ordinal": ordinal });
        let response = get_ipc_response(
            &self.window,
            InvokeRequest {
                cmd: "notes_link_mention".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: LOCAL_ORIGIN.parse().expect("url"),
                body: InvokeBody::Json(body),
                headers: tauri::http::HeaderMap::new(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )?;
        let InvokeResponseBody::Json(json) = response else {
            panic!("expected a JSON response");
        };
        Ok(serde_json::from_str(&json).unwrap())
    }

    /// The next `NoteUpdatedEvent` heard.
    fn next_updated(&self) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(event) = self.updated.lock().unwrap().pop() {
                return event;
            }
            assert!(Instant::now() < deadline, "no NoteUpdatedEvent");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
fn a_linked_mention_rewrites_the_file_and_sends_notes_updated_as_an_outside_edit() {
    let f = opened();
    let target = f.create("Target", "A target.");
    let source = f.create("Standup", "We met about Target today.");
    let before = fs::read_to_string(f.vault.join("Standup.md")).unwrap();

    assert_eq!(f.link(&source, &target, 0), Ok(true));
    let after = fs::read_to_string(f.vault.join("Standup.md")).unwrap();
    assert_eq!(
        after,
        before.replace("about Target today", "about [[Target]] today")
    );
    let event = f.next_updated();
    assert_eq!(event["id"], json!(source));
    assert_eq!(event["source"], json!("external"));
    let content = event["changes"]["content"].as_str().unwrap();
    assert!(content.contains("[[Target]]"), "{content}");

    // The mention is a link now: nothing is left to link, and nothing is written.
    assert_eq!(f.link(&source, &target, 0), Ok(false));
    assert_eq!(
        fs::read_to_string(f.vault.join("Standup.md")).unwrap(),
        after
    );
    let error = f.link(&source, "missing", 0).unwrap_err();
    assert_eq!(error["code"], json!("note_not_found"));
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(*f.updated.lock().unwrap(), Vec::<Value>::new());
}
