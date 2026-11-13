//! The local provider commands through the IPC a renderer calls, on a mock app: no answer ever
//! carries the key, an unconfirmed remote URL is refused with its code, and a locked keychain
//! still opens the settings while the probes run without the key and say why (#3539).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::api::errors::SecureStoreError;
use memry_desktop::ai::local_provider::{LocalProviderStore, SERVICE};
use memry_desktop::locale::LocaleService;
use memry_desktop::registry::AppConfig;
use memry_desktop::seams::secure_store::GenericSecrets;
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_specta::{ErrorHandlingMode, collect_commands};

/// A test value, never a real key.
const KEY: &str = "sk-local-ipc";

#[cfg(windows)]
const LOCAL_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
const LOCAL_ORIGIN: &str = "tauri://localhost";

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
    dir: tempfile::TempDir,
    webview: WebviewWindow<MockRuntime>,
    keychain: Arc<Keychain>,
}

fn app() -> Fixture {
    app_with(json!({}))
}

/// The app over a config file that already holds `config`.
fn app_with(config: Value) -> Fixture {
    // As `lib.rs` installs it at startup, for the probes' HTTP client.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("memry-config.json");
    std::fs::write(&path, config.to_string()).unwrap();
    let config = Arc::new(AppConfig::load(path));
    let keychain = Arc::new(Keychain::default());
    let store = Arc::new(LocalProviderStore::new(config, keychain.clone(), None));

    // As `registry::builder` lists them, with its error handling.
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::agent::agent_get_local_provider_settings::<MockRuntime>,
            memry_tauri::commands::agent::agent_set_local_provider_settings::<MockRuntime>,
            memry_tauri::commands::agent::agent_list_local_models::<MockRuntime>,
            memry_tauri::commands::agent::agent_test_local_provider::<MockRuntime>,
            memry_tauri::commands::agent::agent_probe_local_provider::<MockRuntime>,
        ]);
    let app = mock_builder()
        .invoke_handler(commands.invoke_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    app.manage(store);
    app.manage(Arc::new(LocaleService::new("en")));
    let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .build()
        .unwrap();
    std::mem::forget(app);
    Fixture {
        dir,
        webview,
        keychain,
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

fn input(base_url: &str, extra: Value) -> Value {
    let mut input = json!({
        "preset": "custom",
        "baseUrl": base_url,
        "model": "qwen",
        "allowNonLoopback": false,
    });
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    json!({ "input": input })
}

#[test]
fn the_key_is_stored_but_never_answered() {
    let f = app();
    let saved = f
        .invoke(
            "agent_set_local_provider_settings",
            input("http://localhost:1234/v1", json!({ "apiKey": KEY })),
        )
        .expect("set");
    let got = f
        .invoke("agent_get_local_provider_settings", json!({}))
        .expect("get");
    assert_eq!(saved, got);
    assert_eq!(got["apiKeyConfigured"], json!(true));
    assert_eq!(got["baseUrl"], json!("http://localhost:1234/v1"));
    assert_eq!(got["thinking"], json!("default"));
    assert!(!got.to_string().contains(KEY));
    let items = f.keychain.items.lock().unwrap();
    let stored = items.get(&(SERVICE.to_owned(), "api-key".to_owned()));
    assert_eq!(stored.map(Vec::as_slice), Some(KEY.as_bytes()));
    let config = std::fs::read_to_string(f.dir.path().join("memry-config.json")).unwrap();
    assert!(!config.contains(KEY));
}

#[test]
fn an_unconfirmed_remote_url_is_refused_with_its_code() {
    let f = app();
    let error = f
        .invoke(
            "agent_set_local_provider_settings",
            input("https://api.deepseek.com/v1", json!({ "apiKey": KEY })),
        )
        .expect_err("refused");
    assert_eq!(error["code"], json!("agent.nonLoopbackUnconfirmed"));
    assert!(f.keychain.items.lock().unwrap().is_empty());

    f.invoke(
        "agent_set_local_provider_settings",
        input(
            "https://api.deepseek.com/v1",
            json!({ "allowNonLoopback": true }),
        ),
    )
    .expect("confirmed");
}

#[test]
fn a_locked_keychain_opens_the_settings_and_the_probes_say_why_they_sent_no_key() {
    // Port 9 (discard) refuses the connection, so no local server answers.
    let f = app_with(json!({"agent": {"localProvider": {
        "preset": "custom", "baseUrl": "http://127.0.0.1:9/v1", "model": "qwen"
    }}}));
    f.keychain.locked.store(true, Ordering::SeqCst);
    let got = f
        .invoke("agent_get_local_provider_settings", json!({}))
        .expect("the settings never need the key itself");
    assert_eq!(got["apiKeyConfigured"], json!(true));

    let models = f
        .invoke("agent_list_local_models", json!({}))
        .expect("an empty list, as in Electron");
    assert_eq!(models, json!({ "models": [] }));

    for cmd in ["agent_test_local_provider", "agent_probe_local_provider"] {
        let result = f.invoke(cmd, json!({})).expect("sent without the key");
        assert_eq!(result["connected"], json!(false), "{cmd}");
        let detail = result["detail"].as_str().unwrap();
        assert!(detail.contains("keychain"), "{cmd}: {detail}");
    }
}
