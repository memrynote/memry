//! The editor commands through the IPC a renderer calls (#3531 14b-1b), on a mock app over a real
//! vault and `EditorHost`: the argument and header names, the framed answers of `crdt_open_doc`
//! and `crdt_sync_step_1`, an edit taken from the raw body, and a window that never opened the
//! note refused by its code. What reaches a window's channel is tested on the host
//! (`memry-desktop/tests/editor_host.rs`): a mock webview runs no channel callback.

use std::collections::HashMap;
use std::fs;
use std::sync::{Arc, Mutex};

use memry_core::api::errors::SecureStoreError;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::editor::EditorHost;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use memry_tauri::binary;
use memry_tauri::registry::dispatcher;
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_specta::{ErrorHandlingMode, collect_commands};
use yrs::updates::decoder::Decode as _;
use yrs::updates::encoder::Encode as _;
use yrs::{Doc, GetString as _, ReadTxn as _, StateVector, Text as _, Transact as _, Update};

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
    vault: String,
    note: String,
    main: WebviewWindow<MockRuntime>,
    side: WebviewWindow<MockRuntime>,
}

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
    let host = EditorHost::new(store.clone(), |_| {});
    host.register(&session);
    let open = session.open(&vault, OpenSource::Select).unwrap();
    let note = open
        .vault
        .vault
        .notes_writer(store)
        .unwrap()
        .create("A note".into(), None)
        .unwrap();

    // As `registry::invoke_handler` routes them, with its error handling.
    let typed = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::editor::crdt_close_doc::<MockRuntime>,
            memry_tauri::commands::editor::crdt_get_health::<MockRuntime>,
        ]);
    let app = mock_builder()
        .invoke_handler(dispatcher(
            binary::COMMANDS,
            binary::handler(),
            typed.invoke_handler(),
        ))
        .build(mock_context(noop_assets()))
        .unwrap();
    app.manage(session);
    app.manage(host);
    let window = |label| {
        WebviewWindowBuilder::new(&app, label, WebviewUrl::default())
            .build()
            .unwrap()
    };
    let (main, side) = (window("main"), window("side"));
    std::mem::forget(app);
    Fixture {
        _dir: dir,
        vault: vault.to_string_lossy().into_owned(),
        note,
        main,
        side,
    }
}

/// `cmd` invoked as the renderer invokes it: the answer, or the `CommandError` it threw.
fn invoke(
    window: &WebviewWindow<MockRuntime>,
    cmd: &str,
    body: InvokeBody,
    meta: Option<Value>,
) -> Result<InvokeResponseBody, Value> {
    let mut headers = tauri::http::HeaderMap::new();
    if let Some(meta) = meta {
        headers.insert(binary::META_HEADER, meta.to_string().parse().unwrap());
    }
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: LOCAL_ORIGIN.parse().unwrap(),
            body,
            headers,
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

/// A framed answer: its JSON header, and the bytes after it.
fn unframe(answer: InvokeResponseBody) -> (Value, Vec<u8>) {
    let InvokeResponseBody::Raw(bytes) = answer else {
        panic!("expected a raw answer");
    };
    let length = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
    let header = serde_json::from_slice(&bytes[4..4 + length]).unwrap();
    (header, bytes[4 + length..].to_vec())
}

fn json(answer: InvokeResponseBody) -> Value {
    let InvokeResponseBody::Json(text) = answer else {
        panic!("expected a JSON answer");
    };
    serde_json::from_str(&text).unwrap()
}

impl Fixture {
    /// `window` opens the note; the window's copy of the document.
    fn open_doc(&self, window: &WebviewWindow<MockRuntime>) -> (Value, Doc) {
        let args =
            json!({ "noteId": self.note, "vaultPath": self.vault, "onUpdate": "__CHANNEL__:7" });
        let (header, rest) =
            unframe(invoke(window, "crdt_open_doc", InvokeBody::Json(args), None).unwrap());
        let state_length = header["stateLength"].as_u64().unwrap() as usize;
        let doc = Doc::new();
        doc.transact_mut()
            .apply_update(Update::decode_v1(&rest[..state_length]).unwrap())
            .unwrap();
        assert_eq!(
            StateVector::decode_v1(&rest[state_length..]).unwrap(),
            doc.transact().state_vector(),
            "the state vector follows the state"
        );
        (header, doc)
    }

    fn apply(
        &self,
        window: &WebviewWindow<MockRuntime>,
        update: Vec<u8>,
    ) -> Result<InvokeResponseBody, Value> {
        let meta = json!({ "noteId": self.note });
        invoke(
            window,
            "crdt_apply_update",
            InvokeBody::Raw(update),
            Some(meta),
        )
    }
}

fn type_text(doc: &Doc, text: &str) -> Vec<u8> {
    let root = doc.get_or_insert_text("t");
    let before = doc.transact().state_vector();
    root.insert(&mut doc.transact_mut(), 0, text);
    doc.transact().encode_diff_v1(&before)
}

#[test]
fn a_window_opens_edits_and_another_catches_up_through_the_ipc() {
    let f = opened();
    let (header, main) = f.open_doc(&f.main);
    assert_eq!(header["needsSeed"], true, "a new note's body is empty");

    let typed = type_text(&main, "typed in main");
    assert_eq!(json(f.apply(&f.main, typed.clone()).unwrap()), Value::Null);
    let refused = f.apply(&f.side, typed).unwrap_err();
    assert_eq!(refused["code"], "document_not_open", "side never opened it");

    let (_, side) = f.open_doc(&f.side);
    let step = invoke(
        &f.side,
        "crdt_sync_step_1",
        InvokeBody::Raw(StateVector::default().encode_v1()),
        Some(json!({ "noteId": f.note })),
    );
    let (header, rest) = unframe(step.unwrap());
    let diff_length = header["diffLength"].as_u64().unwrap() as usize;
    let late = Doc::new();
    late.transact_mut()
        .apply_update(Update::decode_v1(&rest[..diff_length]).unwrap())
        .unwrap();
    let text = |doc: &Doc| doc.get_or_insert_text("t").get_string(&doc.transact());
    assert_eq!(text(&late), "typed in main");
    assert_eq!(
        text(&side),
        "typed in main",
        "the open's state had it already"
    );
}

#[test]
fn a_closed_editor_takes_no_more_edits_and_the_health_is_persistent() {
    let f = opened();
    let (_, main) = f.open_doc(&f.main);
    let closed = invoke(
        &f.main,
        "crdt_close_doc",
        InvokeBody::Json(json!({ "noteId": f.note })),
        None,
    );
    assert_eq!(json(closed.unwrap()), Value::Null);

    let refused = f.apply(&f.main, type_text(&main, "late")).unwrap_err();
    assert_eq!(refused["code"], "document_not_open");
    let health = invoke(
        &f.main,
        "crdt_get_health",
        InvokeBody::Json(json!({})),
        None,
    );
    assert_eq!(
        json(health.unwrap()),
        json!({ "persistent": true, "inMemorySessions": 0 })
    );
}
