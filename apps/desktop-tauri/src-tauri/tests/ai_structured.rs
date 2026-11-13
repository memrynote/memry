//! Writing assist and the field fill through the IPC a renderer calls (#3539), on a mock app
//! over a real vault: what "Fill from note" shows, the first-run disclosure recorded only once
//! accepted, and the text a failed writing assist shows, which never carries the key.

#[allow(
    dead_code,
    reason = "the commands read the note through the session, never the vault path"
)]
mod support;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::ai::provider::AiProvider;
use memry_desktop::ai::proxy::AiProxy;
use memry_desktop::ai::settings::{InlineAiStore, InlineAiUpdates};
use memry_desktop::registry::AppConfig;
use memry_desktop::seams::secure_store::GenericSecrets;
use memry_desktop::settings::SettingsService;
use serde_json::{Value, json};
use support::Mocked;
use tauri::Manager;
use tauri::test::MockRuntime;
use tauri_specta::collect_commands;

/// The stored key: a test value, never a real one.
const KEY: &str = "test-key-not-real-42";

#[derive(Default)]
struct Store(Mutex<HashMap<SecureStoreKey, Vec<u8>>>);

impl SecureStore for Store {
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

#[derive(Default)]
struct Keychain(Mutex<HashMap<(String, String), Vec<u8>>>);

impl GenericSecrets for Keychain {
    fn get_secret(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Vec<u8>>, SecureStoreError> {
        let key = (service.to_owned(), account.to_owned());
        Ok(self.0.lock().unwrap().get(&key).cloned())
    }
    fn set_secret(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
    ) -> Result<(), SecureStoreError> {
        let key = (service.to_owned(), account.to_owned());
        self.0.lock().unwrap().insert(key, value.to_vec());
        Ok(())
    }
    fn delete_secret(&self, service: &str, account: &str) -> Result<(), SecureStoreError> {
        self.0
            .lock()
            .unwrap()
            .remove(&(service.to_owned(), account.to_owned()));
        Ok(())
    }
}

struct Fixture {
    mocked: Mocked,
    _app_dir: tempfile::TempDir,
    config: Arc<AppConfig>,
    store: Arc<InlineAiStore>,
    note: String,
}

fn fixture() -> Fixture {
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::ai_structured::writing_generate_assist::<MockRuntime>,
            memry_tauri::commands::ai_structured::tags_fill_status::<MockRuntime>,
            memry_tauri::commands::ai_structured::tags_fill_fields::<MockRuntime>,
        ]);
    let mocked = Mocked::open(&[("Note.md", "# Note\n\nMet Elif at Globex.\n")], commands);
    let note = mocked
        .session()
        .current()
        .unwrap()
        .vault
        .note_files()
        .by_path("Note.md")
        .unwrap()
        .expect("a row for Note.md")
        .note_id;
    let app_dir = tempfile::tempdir().unwrap();
    let config = Arc::new(AppConfig::load(app_dir.path().join("memry-config.json")));
    let store = Arc::new(InlineAiStore::new(
        SettingsService::new(Arc::new(Store::default()), config.clone()),
        Arc::new(Keychain::default()),
        None,
    ));
    let _ = rustls::crypto::ring::default_provider().install_default();
    let app = mocked.webview.app_handle();
    app.manage(config.clone());
    app.manage(store.clone());
    app.manage(AiProxy::new(memry_desktop::http::builder().no_proxy()));
    Fixture {
        mocked,
        _app_dir: app_dir,
        config,
        store,
        note,
    }
}

impl Fixture {
    fn set(&self, provider: AiProvider, enabled: bool, key: &str, base: &str) {
        let updates = InlineAiUpdates {
            enabled: Some(enabled),
            provider: Some(provider),
            model: Some("m".to_owned()),
            api_key: Some(key.to_owned()),
            base_url: Some(base.to_owned()),
        };
        let vault = self.mocked.session().current();
        self.store.write(vault.as_ref(), updates).unwrap();
    }

    fn assist(&self, text: &str) -> Result<Value, Value> {
        self.mocked.invoke(
            "writing_generate_assist",
            json!({ "input": { "kind": "alternatives", "text": text, "context": "" } }),
        )
    }
}

/// A provider on this host that answers every request with `status` and `body`, then closes.
fn provider(status: &'static str, body: String) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut request = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(read) = stream.read(&mut buf) {
                request.extend_from_slice(&buf[..read]);
                let text = String::from_utf8_lossy(&request);
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let length = text[..head_end]
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    if request.len() >= head_end + 4 + length {
                        break;
                    }
                }
                if read == 0 {
                    break;
                }
            }
            let answer = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(answer.as_bytes());
        }
    });
    format!("http://127.0.0.1:{port}/v1")
}

fn closed_base() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    format!("http://127.0.0.1:{port}/v1")
}

#[test]
fn fill_status_shows_only_a_configured_provider_and_names_a_local_one() {
    let f = fixture();
    f.set(AiProvider::Ollama, true, "", "");
    assert_eq!(
        f.mocked.invoke("tags_fill_status", json!({})).unwrap(),
        json!({ "available": true, "model": "m", "local": true, "disclosureAccepted": false })
    );
    f.set(AiProvider::Openai, true, "", "");
    let status = f.mocked.invoke("tags_fill_status", json!({})).unwrap();
    assert_eq!(
        (status["available"].clone(), status["local"].clone()),
        (json!(false), json!(false))
    );
    f.set(AiProvider::Openai, false, KEY, "");
    assert_eq!(
        f.mocked.invoke("tags_fill_status", json!({})).unwrap()["available"],
        json!(false)
    );
}

#[test]
fn the_fill_asks_for_the_disclosure_and_records_it_only_once_accepted() {
    let f = fixture();
    f.set(AiProvider::Ollama, true, "", &closed_base());
    let fill = |accept: Option<bool>| {
        let mut input = json!({ "noteId": f.note });
        if let Some(accept) = accept {
            input["acceptDisclosure"] = json!(accept);
        }
        f.mocked
            .invoke("tags_fill_fields", json!({ "input": input }))
            .unwrap()
    };

    assert_eq!(
        fill(None),
        json!({ "kind": "disclosure-required", "model": "m", "local": true })
    );
    assert_eq!(fill(Some(false))["kind"], json!("disclosure-required"));
    assert!(!f.config.agent().field_fill_disclosure_accepted);

    // The note has no header tag with fields: nothing to ask the model, no proposals.
    assert_eq!(
        fill(Some(true)),
        json!({ "kind": "proposals", "proposals": [] })
    );
    assert!(f.config.agent().field_fill_disclosure_accepted);
    let status = f.mocked.invoke("tags_fill_status", json!({})).unwrap();
    assert_eq!(status["disclosureAccepted"], json!(true));
    assert_eq!(fill(None)["kind"], json!("proposals"));

    f.set(AiProvider::Openai, true, "", "");
    assert_eq!(fill(None), json!({ "kind": "unavailable" }));
}

#[test]
fn a_failed_writing_assist_says_what_to_fix_and_never_shows_the_key() {
    let f = fixture();
    let refused = |result: Result<Value, Value>| {
        let error = result.expect_err("refused");
        let text = error.to_string();
        assert!(!text.contains(&KEY[..12]), "key text in {text}");
        (
            error["code"].as_str().unwrap().to_owned(),
            error["message"].as_str().unwrap().to_owned(),
        )
    };

    f.set(AiProvider::Custom, true, KEY, &closed_base());
    assert_eq!(
        refused(f.assist("  ")),
        (
            "ai.writingAssistInvalid".to_owned(),
            "That request could not be sent to the AI model.".to_owned()
        )
    );
    f.set(AiProvider::Custom, false, KEY, &closed_base());
    assert_eq!(
        refused(f.assist("Hello")),
        (
            "ai.inlineDisabled".to_owned(),
            "AI inline editing is disabled".to_owned()
        )
    );
    f.set(AiProvider::Anthropic, true, "", "");
    assert_eq!(
        refused(f.assist("Hello")),
        (
            "ai.apiKeyMissing".to_owned(),
            "Add your Anthropic API key in Settings → AI to use writing tools.".to_owned()
        )
    );

    let base = provider(
        "401 Unauthorized",
        r#"{"error":{"message":"bad key"}}"#.to_owned(),
    );
    f.set(AiProvider::Custom, true, KEY, &base);
    let host = &base["http://".len()..base.len() - "/v1".len()];
    assert_eq!(
        refused(f.assist("Hello")),
        (
            "ai.writingAssistFailed".to_owned(),
            format!("Your {host} API key was rejected. Check it in Settings → AI.")
        )
    );

    let quoted = json!({ "error": { "message": format!("Incorrect API key provided: {KEY}") } });
    f.set(
        AiProvider::Custom,
        true,
        KEY,
        &provider("400 Bad Request", quoted.to_string()),
    );
    assert_eq!(
        refused(f.assist("Hello")),
        (
            "ai.writingAssistFailed".to_owned(),
            "Incorrect API key provided: [redacted]".to_owned()
        )
    );

    // Unreachable after the SDK's two retries (2 s, then 4 s).
    f.set(AiProvider::Ollama, true, "", &closed_base());
    let (code, message) = refused(f.assist("Hello"));
    assert_eq!(code, "ai.writingAssistFailed");
    assert!(message.starts_with("Ollama is not running."), "{message}");
}
