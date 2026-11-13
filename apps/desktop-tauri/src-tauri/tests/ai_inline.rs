//! The inline AI settings commands through the IPC a renderer calls, on a mock app over a real
//! vault: the settings screen opens with the key masked whatever the keychain says, and
//! `ai_inline_get_settings` reports the key exactly as `ai_inline_set_settings` does, and a
//! provider call whose settings read fails lets go of the renderer's early cancel (#3539).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::ai::provider::AiProvider;
use memry_desktop::ai::proxy::{AiProviderRequest, AiProxy};
use memry_desktop::ai::settings::{InlineAiStore, InlineAiUpdates, MASKED_KEY};
use memry_desktop::locale::LocaleService;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::seams::secure_store::GenericSecrets;
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::settings::SettingsService;
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

/// The stored key: a test value, never a real one.
const STORED: &str = "sk-stored";

#[cfg(windows)]
const LOCAL_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
const LOCAL_ORIGIN: &str = "tauri://localhost";

/// The device key the settings clocks need.
#[derive(Default)]
struct DeviceKeys(Mutex<HashMap<SecureStoreKey, Vec<u8>>>);

impl SecureStore for DeviceKeys {
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

/// The OS keychain: an in-memory map that can be locked.
#[derive(Default)]
struct Keychain {
    items: Mutex<HashMap<(String, String), Vec<u8>>>,
    locked: AtomicBool,
}

impl Keychain {
    fn check(&self) -> Result<(), SecureStoreError> {
        if self.locked.load(Ordering::SeqCst) {
            return Err(SecureStoreError::Locked);
        }
        Ok(())
    }
}

impl GenericSecrets for Keychain {
    fn get_secret(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Vec<u8>>, SecureStoreError> {
        self.check()?;
        let key = (service.to_owned(), account.to_owned());
        Ok(self.items.lock().unwrap().get(&key).cloned())
    }
    fn set_secret(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
    ) -> Result<(), SecureStoreError> {
        self.check()?;
        let key = (service.to_owned(), account.to_owned());
        self.items.lock().unwrap().insert(key, value.to_vec());
        Ok(())
    }
    fn delete_secret(&self, service: &str, account: &str) -> Result<(), SecureStoreError> {
        self.check()?;
        let key = (service.to_owned(), account.to_owned());
        self.items.lock().unwrap().remove(&key);
        Ok(())
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    webview: WebviewWindow<MockRuntime>,
    keychain: Arc<Keychain>,
    store: Arc<InlineAiStore>,
    session: Session,
    proxy: Arc<AiProxy>,
}

/// An open vault whose inline AI provider is `provider`, with a cloud key stored in the
/// keychain, and the cached key dropped (a new session).
fn opened(provider: AiProvider) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    std::fs::create_dir_all(dir.path().join("app")).unwrap();
    let config = Arc::new(AppConfig::load(dir.path().join("app/memry-config.json")));
    let session = Session::new(VaultRegistry::new(config.clone()));
    session.open(&vault, OpenSource::Select).unwrap();
    let keychain = Arc::new(Keychain::default());
    let store = Arc::new(InlineAiStore::new(
        SettingsService::new(Arc::new(DeviceKeys::default()), config),
        keychain.clone(),
        None,
    ));
    let updates = InlineAiUpdates {
        provider: Some(AiProvider::Openai),
        model: Some("gpt-4.1".to_owned()),
        api_key: Some(STORED.to_owned()),
        ..InlineAiUpdates::default()
    };
    store.write(session.current().as_ref(), updates).unwrap();
    let updates = InlineAiUpdates {
        provider: Some(provider),
        ..InlineAiUpdates::default()
    };
    store.write(session.current().as_ref(), updates).unwrap();
    store.forget();

    // As `registry::builder` lists them, with its error handling.
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::ai::ai_inline_get_settings::<MockRuntime>,
            memry_tauri::commands::ai::ai_inline_set_settings::<MockRuntime>,
            memry_tauri::commands::ai::ai_provider_cancel::<MockRuntime>,
        ]);
    let app = mock_builder()
        .invoke_handler(dispatcher(
            binary::COMMANDS,
            binary::handler(),
            commands.invoke_handler(),
        ))
        .build(mock_context(noop_assets()))
        .unwrap();
    app.manage(session.clone());
    app.manage(store.clone());
    app.manage(Arc::new(LocaleService::new("en")));
    let _ = rustls::crypto::ring::default_provider().install_default();
    let proxy = AiProxy::new(memry_desktop::http::builder().no_proxy());
    app.manage(proxy.clone());
    let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .build()
        .unwrap();
    std::mem::forget(app);
    Fixture {
        _dir: dir,
        webview,
        keychain,
        store,
        session,
        proxy,
    }
}

impl Fixture {
    /// `cmd` invoked as the generated bindings invoke it: the answer, or the serialized
    /// `CommandError` it threw.
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
fn a_cloud_provider_behind_a_locked_keychain_still_opens_its_settings() {
    let f = opened(AiProvider::Openai);
    f.keychain.locked.store(true, Ordering::SeqCst);

    let settings = f
        .invoke("ai_inline_get_settings", json!({}))
        .expect("the masked read never needs the key itself");
    assert_eq!(settings["provider"], json!("openai"));
    assert_eq!(settings["model"], json!("gpt-4.1"));
    assert_eq!(settings["apiKey"], json!(MASKED_KEY));
    // The key is untouched: Rust callers get it once the keychain opens.
    f.keychain.locked.store(false, Ordering::SeqCst);
    let read = f.store.read(f.session.current().as_ref()).unwrap();
    assert!(read.api_key == STORED, "the stored key changed");
}

#[test]
fn ollama_with_a_stored_cloud_key_reads_as_set_settings_answers() {
    let f = opened(AiProvider::Ollama);

    let got = f.invoke("ai_inline_get_settings", json!({})).unwrap();
    let set = f
        .invoke("ai_inline_set_settings", json!({ "updates": {} }))
        .unwrap();
    assert_eq!(got["provider"], json!("ollama"));
    assert_eq!(got["apiKey"], json!(MASKED_KEY));
    assert_eq!(got, set);
}

/// A custom endpoint on this host that answers every request `200 {}`, then closes.
fn endpoint() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut request = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(read) = stream.read(&mut buf) {
                request.extend_from_slice(&buf[..read]);
                // The request below is `{}`, two bytes.
                if read == 0 || request.ends_with(b"\r\n\r\n{}") {
                    break;
                }
            }
            let answer = "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}";
            let _ = stream.write_all(answer.as_bytes());
        }
    });
    format!("http://127.0.0.1:{port}/v1")
}

#[test]
fn a_provider_call_refused_by_a_locked_keychain_lets_go_of_its_early_cancel() {
    let f = opened(AiProvider::Custom);
    let updates = InlineAiUpdates {
        base_url: Some(endpoint()),
        ..InlineAiUpdates::default()
    };
    f.store
        .write(f.session.current().as_ref(), updates)
        .unwrap();
    f.store.forget();
    let request = json!({
        "requestId": "aborted",
        "provider": "custom",
        "method": "POST",
        "path": "/chat/completions",
        "headers": [],
        "body": "{}",
    });

    // The renderer aborted while Rust read the settings, and the read then failed.
    f.invoke("ai_provider_cancel", json!({ "requestId": "aborted" }))
        .unwrap();
    f.keychain.locked.store(true, Ordering::SeqCst);
    let error = f
        .invoke(
            "ai_provider_request",
            json!({ "request": request, "onChunk": "__CHANNEL__:7" }),
        )
        .expect_err("the key could not be read");
    assert_eq!(error["code"], json!("secure_store_locked"), "{error}");

    // The id is free again: no later request of it is refused as cancelled.
    f.keychain.locked.store(false, Ordering::SeqCst);
    let settings = f.store.read(f.session.current().as_ref()).unwrap();
    let request: AiProviderRequest = serde_json::from_value(request).unwrap();
    let answer = tauri::async_runtime::block_on(f.proxy.call(
        &settings,
        request,
        &f.proxy.owner("main"),
        1024,
    ));
    assert_eq!(answer.map(|answer| answer.status), Ok(200));
}
