//! The local agent provider settings and probes (#3539): the key lives only in the keychain under
//! this app's service, a non-loopback URL needs the user's confirmation before it is stored or
//! asked, a locked keychain writes nothing half way, and the capability probe classifies the
//! provider as `local-provider-probe.ts` does, against a local fake server.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use memry_core::api::errors::SecureStoreError;
use memry_desktop::ai::catalog::ProbeClient;
use memry_desktop::ai::local_provider::probe::{
    AgentToolsOffReason, ToolChoice, ToolVerdict, list_models, probe, test_connection,
};
use memry_desktop::ai::local_provider::{
    AgentLocalProviderPreset, AgentLocalProviderSettingsUpdate, AgentLocalThinking,
    LocalProviderError, LocalProviderStore, SERVICE,
};
use memry_desktop::registry::AppConfig;
use memry_desktop::seams::secure_store::{
    DEADLINE, GenericSecrets, KeyringStore, Store, StoreFactory,
};
use serde_json::{Value, json};
use tokio::net::TcpListener;

/// A test value, never a real key.
const KEY: &str = "sk-local-test";

/// The keychain: an in-memory map that can be locked and counts reads.
#[derive(Default)]
struct Keychain {
    items: Mutex<HashMap<(String, String), Vec<u8>>>,
    locked: AtomicBool,
    gets: AtomicUsize,
}

impl Keychain {
    fn item(&self, account: &str) -> Option<String> {
        let key = (SERVICE.to_owned(), account.to_owned());
        let items = self.items.lock().unwrap();
        items
            .get(&key)
            .map(|bytes| String::from_utf8(bytes.clone()).unwrap())
    }
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
        self.gets.fetch_add(1, Ordering::SeqCst);
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
    keychain: Arc<Keychain>,
    store: LocalProviderStore,
}

impl Fixture {
    fn new(config: Value) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memry-config.json");
        std::fs::write(&path, config.to_string()).unwrap();
        let keychain = Arc::new(Keychain::default());
        let store =
            LocalProviderStore::new(Arc::new(AppConfig::load(path)), keychain.clone(), None);
        Self {
            dir,
            keychain,
            store,
        }
    }

    fn config_text(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("memry-config.json")).unwrap()
    }

    fn local(&self) -> Value {
        let config: Value = serde_json::from_str(&self.config_text()).unwrap();
        config["agent"]["localProvider"].clone()
    }
}

/// An update as the renderer sends it, through serde.
fn update(value: Value) -> AgentLocalProviderSettingsUpdate {
    serde_json::from_value(value).unwrap()
}

fn lm_studio(extra: Value) -> AgentLocalProviderSettingsUpdate {
    let mut base = json!({
        "preset": "lm_studio",
        "baseUrl": "http://localhost:1234/v1",
        "model": "qwen2.5",
        "allowNonLoopback": false,
    });
    base.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    update(base)
}

#[test]
fn absent_settings_read_as_electrons_defaults_and_an_unknown_preset_as_custom() {
    let fixture = Fixture::new(json!({}));
    let settings = fixture.store.settings();
    assert_eq!(settings.preset, AgentLocalProviderPreset::Ollama);
    assert_eq!(settings.base_url, "http://localhost:11434/v1");
    assert_eq!(settings.model, "");
    assert!(!settings.api_key_configured);
    assert!(!settings.allow_non_loopback);
    assert_eq!(settings.thinking, AgentLocalThinking::Default);

    let fixture = Fixture::new(json!({"agent": {"localProvider": {"preset": "llama_cpp"}}}));
    assert_eq!(
        fixture.store.settings().base_url,
        "http://127.0.0.1:8080/v1"
    );

    let fixture = Fixture::new(json!({"agent": {"localProvider": {
        "preset": "vllm", "baseUrl": "http://localhost:8000/v1", "thinking": "deep"
    }}}));
    let settings = fixture.store.settings();
    assert_eq!(settings.preset, AgentLocalProviderPreset::Custom);
    assert_eq!(settings.base_url, "http://localhost:8000/v1");
    assert_eq!(settings.thinking, AgentLocalThinking::Default);
}

#[test]
fn the_key_goes_to_the_keychain_and_never_into_the_config() {
    let fixture = Fixture::new(json!({"agent": {
        "accessMode": "vault_only",
        "localProvider": {"preset": "ollama", "thinking": "off", "futureField": 7}
    }}));
    let saved = fixture
        .store
        .write(lm_studio(json!({"apiKey": KEY})))
        .expect("write");

    assert!(saved.api_key_configured);
    assert_eq!(fixture.keychain.item("api-key").as_deref(), Some(KEY));
    assert!(!fixture.config_text().contains(KEY));
    let local = fixture.local();
    assert_eq!(local["preset"], "lm_studio");
    assert_eq!(local["baseUrl"], "http://localhost:1234/v1");
    assert_eq!(local["model"], "qwen2.5");
    assert_eq!(local["allowNonLoopback"], false);
    // Absent `thinking` keeps the stored value; a newer build's field survives.
    assert_eq!(local["thinking"], "off");
    assert_eq!(local["futureField"], 7);
    let config: Value = serde_json::from_str(&fixture.config_text()).unwrap();
    assert_eq!(config["agent"]["accessMode"], "vault_only");

    let provider = fixture.store.read().expect("read");
    assert_eq!(provider.key(), Some(KEY));
    assert!(!format!("{provider:?}").contains(KEY));
}

#[test]
fn an_absent_key_is_kept_and_null_empty_or_clear_deletes_it() {
    for clear in [
        json!({"apiKey": null}),
        json!({"apiKey": ""}),
        json!({"clearApiKey": true}),
        json!({"clearApiKey": true, "apiKey": "ignored"}),
    ] {
        let fixture = Fixture::new(json!({}));
        fixture
            .store
            .write(lm_studio(json!({"apiKey": KEY})))
            .unwrap();
        let kept = fixture.store.write(lm_studio(json!({}))).unwrap();
        assert!(kept.api_key_configured);
        assert_eq!(fixture.keychain.item("api-key").as_deref(), Some(KEY));

        let cleared = fixture.store.write(lm_studio(clear.clone())).unwrap();
        assert!(!cleared.api_key_configured, "{clear}");
        assert_eq!(fixture.keychain.item("api-key"), None, "{clear}");
        assert_eq!(fixture.store.read().unwrap().key(), None);
    }
}

#[test]
fn a_non_loopback_url_needs_confirmation_and_a_refusal_writes_nothing() {
    for loopback in [
        "http://localhost:1234/v1",
        "http://LOCALHOST:1234/v1",
        "http://127.0.0.1:8080/v1",
        "http://[::1]:8080/v1",
    ] {
        let fixture = Fixture::new(json!({}));
        let input = lm_studio(json!({"baseUrl": loopback}));
        fixture.store.write(input).expect(loopback);
    }

    for remote in [
        "https://api.deepseek.com/v1",
        "http://127.0.0.2:8080/v1",
        "http://localhost.example.com/v1",
        "http://192.168.1.4:11434/v1",
    ] {
        let fixture = Fixture::new(json!({}));
        let refused = fixture
            .store
            .write(lm_studio(json!({"baseUrl": remote, "apiKey": KEY})));
        assert!(
            matches!(refused, Err(LocalProviderError::NonLoopback)),
            "{remote}"
        );
        assert_eq!(fixture.local(), Value::Null, "{remote}");
        assert_eq!(fixture.keychain.item("api-key"), None, "{remote}");

        let confirmed = fixture.store.write(lm_studio(
            json!({"baseUrl": remote, "allowNonLoopback": true, "apiKey": KEY}),
        ));
        assert!(confirmed.expect(remote).allow_non_loopback);
    }

    let fixture = Fixture::new(json!({}));
    for invalid in ["not a url", "ftp://localhost/v1", "file:///tmp/x"] {
        let refused = fixture.store.write(lm_studio(
            json!({"baseUrl": invalid, "allowNonLoopback": true}),
        ));
        assert!(
            matches!(refused, Err(LocalProviderError::InvalidUrl(_))),
            "{invalid}"
        );
    }
}

#[test]
fn a_locked_keychain_shows_the_key_unknown_and_writes_no_half_change() {
    let fixture = Fixture::new(json!({"agent": {"localProvider": {"preset": "ollama"}}}));
    fixture.keychain.locked.store(true, Ordering::SeqCst);

    assert!(fixture.store.settings().api_key_configured);
    assert!(matches!(
        fixture.store.read(),
        Err(LocalProviderError::Keychain(SecureStoreError::Locked))
    ));
    let refused = fixture.store.write(lm_studio(json!({"apiKey": KEY})));
    assert!(matches!(refused, Err(LocalProviderError::Keychain(_))));
    assert_eq!(fixture.local()["preset"], "ollama");

    // A write that leaves the key alone does not need the keychain.
    fixture.store.write(lm_studio(json!({}))).expect("no key");
    assert_eq!(fixture.local()["preset"], "lm_studio");

    fixture.keychain.locked.store(false, Ordering::SeqCst);
    assert!(!fixture.store.settings().api_key_configured);
}

#[test]
fn the_key_is_read_from_the_keychain_once_per_process() {
    let fixture = Fixture::new(json!({}));
    fixture.store.settings();
    fixture.store.settings();
    fixture.store.read().unwrap();
    assert_eq!(fixture.keychain.gets.load(Ordering::SeqCst), 1);
}

#[test]
fn accounts_take_the_device_suffix_rule_of_the_sync_entries() {
    let config = Arc::new(AppConfig::load(
        tempfile::tempdir().unwrap().path().join("c.json"),
    ));
    let keychain: Arc<dyn GenericSecrets> = Arc::new(Keychain::default());
    for (device, account) in [
        (None, "api-key"),
        (Some(""), "api-key"),
        (Some("dev-0123abcd"), "api-key-dev"),
        (Some("e2e-agent-1"), "api-key-e2e-agent-1"),
    ] {
        let store = LocalProviderStore::new(config.clone(), keychain.clone(), device);
        assert_eq!(store.account(), account);
    }
}

struct Mock(Store);

impl StoreFactory for Mock {
    fn build(&self) -> keyring_core::Result<Store> {
        Ok(self.0.clone())
    }
}

#[test]
fn the_real_keychain_worker_accepts_the_local_provider_service() {
    let credentials: Store = keyring_core::mock::Store::new().unwrap();
    let keychain = KeyringStore::with_factory(Mock(credentials), None, DEADLINE);
    keychain
        .set_secret(SERVICE, "api-key", b"sk")
        .expect("an app service under com.memrynote.memry.");
    assert_eq!(
        keychain.get_secret(SERVICE, "api-key").expect("get"),
        Some(b"sk".to_vec())
    );
}

// --- probes against a fake OpenAI-compatible server ---

type Script = Arc<dyn Fn(&Value) -> (StatusCode, String) + Send + Sync>;

#[derive(Default)]
struct Seen {
    auth: Vec<Option<String>>,
    chats: Vec<Value>,
}

/// A server at `127.0.0.1:<port>/v1` that lists `models` and answers each non-streamed chat
/// completion with `script`; a streamed one gets one SSE chunk unless `stream` says otherwise.
async fn server(
    models: &'static [&'static str],
    stream: StatusCode,
    script: Script,
) -> (String, Arc<Mutex<Seen>>) {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let auth = |headers: &HeaderMap| {
        headers
            .get("authorization")
            .map(|value| value.to_str().unwrap().to_owned())
    };
    let on_list = seen.clone();
    let on_chat = seen.clone();
    let app = Router::new()
        .route(
            "/v1/models",
            get(move |headers: HeaderMap| {
                on_list.lock().unwrap().auth.push(auth(&headers));
                let data: Vec<Value> = models.iter().map(|id| json!({ "id": id })).collect();
                async move { json!({ "data": data }).to_string() }
            }),
        )
        .route(
            "/v1/chat/completions",
            post(move |headers: HeaderMap, body: String| {
                let body: Value = serde_json::from_str(&body).unwrap();
                let mut seen = on_chat.lock().unwrap();
                seen.auth.push(auth(&headers));
                let answer = if body["stream"] == true {
                    (stream, "data: {\"choices\":[]}\n\n".to_owned())
                } else {
                    seen.chats.push(body.clone());
                    script(&body)
                };
                async move { answer }
            }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move { axum::serve(listener, app).await });
    (format!("http://127.0.0.1:{port}/v1"), seen)
}

fn client() -> ProbeClient {
    let _ = rustls::crypto::ring::default_provider().install_default();
    ProbeClient::new(memry_desktop::http::builder().no_proxy())
}

fn message(message: Value) -> (StatusCode, String) {
    (
        StatusCode::OK,
        json!({ "choices": [{ "message": message }] }).to_string(),
    )
}

/// A store pointed at `base` with model `qwen` and the test key.
fn configured(base: &str) -> Fixture {
    let fixture = Fixture::new(json!({}));
    fixture
        .store
        .write(update(json!({
            "preset": "custom", "baseUrl": base, "model": "qwen",
            "allowNonLoopback": false, "apiKey": KEY
        })))
        .unwrap();
    fixture
}

fn native_call() -> Script {
    Arc::new(|body: &Value| {
        if body["messages"].as_array().unwrap().len() == 1 {
            message(
                json!({"role": "assistant", "content": null, "tool_calls": [{
                    "id": "call-1", "type": "function",
                    "function": {"name": "memry_probe_echo", "arguments": "{\"text\":\"ok\"}"}
                }]}),
            )
        } else {
            message(json!({"role": "assistant", "content": "ok"}))
        }
    })
}

#[tokio::test]
async fn list_and_test_send_the_key_as_a_bearer_and_report_a_missing_model() {
    let (base, seen) = server(&["llama3", "qwen"], StatusCode::OK, native_call()).await;
    let fixture = configured(&base);
    let provider = fixture.store.read().unwrap();
    assert_eq!(
        list_models(&client(), &provider).await.unwrap(),
        ["llama3", "qwen"]
    );
    let ok = test_connection(&client(), &provider).await;
    assert!(ok.connected && ok.model_available && ok.detail.is_none());
    assert_eq!(
        seen.lock().unwrap().auth,
        [Some(format!("Bearer {KEY}")), Some(format!("Bearer {KEY}"))]
    );

    let mut missing = provider.clone();
    missing.model = "mistral".to_owned();
    let result = test_connection(&client(), &missing).await;
    assert!(result.connected && !result.model_available);
    assert_eq!(
        result.detail.as_deref(),
        Some("Model mistral was not returned by /v1/models.")
    );
}

#[tokio::test]
async fn an_unconfirmed_remote_url_in_the_config_is_never_asked() {
    let fixture = Fixture::new(json!({"agent": {"localProvider": {
        "preset": "custom", "baseUrl": "https://models.example.invalid/v1", "model": "m"
    }}}));
    let provider = fixture.store.read().unwrap();
    let result = test_connection(&client(), &provider).await;
    assert!(!result.connected);
    assert_eq!(
        result.detail.as_deref(),
        Some("Non-loopback local provider endpoints require explicit confirmation.")
    );
    assert_eq!(
        probe(&client(), &provider).await.tools,
        ToolVerdict::Unreachable
    );
}

#[tokio::test]
async fn a_native_tool_call_and_its_continuation_turn_tools_on() {
    let (base, seen) = server(&["qwen"], StatusCode::OK, native_call()).await;
    let fixture = configured(&base);
    let run = probe(&client(), &fixture.store.read().unwrap()).await;
    assert_eq!(run.tools, ToolVerdict::On(ToolChoice::Auto));
    let result = run.result;
    assert!(result.connected && result.model_available && result.streaming_supported);
    assert!(result.tool_calling_supported && result.tool_continuation_supported);
    assert!(result.tools_enabled && result.detail.is_none());

    let seen = seen.lock().unwrap();
    assert_eq!(
        seen.chats[0]["tool_choice"]["function"]["name"],
        "memry_probe_echo"
    );
    let replay = &seen.chats[1]["messages"];
    assert_eq!(replay[1]["tool_calls"][0]["id"], "call-1");
    assert_eq!(replay[2]["role"], "tool");
    assert_eq!(replay[2]["tool_call_id"], "call-1");
    assert!(seen.chats[1].get("tools").is_none());
    assert!(
        seen.auth
            .iter()
            .all(|auth| auth.as_deref() == Some(&format!("Bearer {KEY}")))
    );
}

#[tokio::test]
async fn a_refused_named_tool_choice_is_retried_without_one() {
    let script: Script = Arc::new(|body: &Value| {
        if body.get("tool_choice").is_some() {
            return (
                StatusCode::BAD_REQUEST,
                json!({"error": {"message": "tool_choice is not supported in thinking mode"}})
                    .to_string(),
            );
        }
        native_call()(body)
    });
    let (base, seen) = server(&["qwen"], StatusCode::OK, script).await;
    let fixture = configured(&base);
    let run = probe(&client(), &fixture.store.read().unwrap()).await;
    assert_eq!(run.tools, ToolVerdict::On(ToolChoice::Omit));
    assert!(run.result.tools_enabled);
    assert_eq!(seen.lock().unwrap().chats.len(), 3);
}

#[tokio::test]
async fn a_call_left_in_the_reply_text_is_replayed_as_a_structured_call() {
    let script: Script = Arc::new(|body: &Value| {
        if body["messages"].as_array().unwrap().len() == 1 {
            message(json!({"role": "assistant", "content":
                "<tool_call>{\"name\":\"memry_probe_echo\",\"arguments\":{\"text\":\"ok\"}}</tool_call>"}))
        } else {
            message(json!({"role": "assistant", "content": "ok"}))
        }
    });
    let (base, seen) = server(&["qwen"], StatusCode::OK, script).await;
    let fixture = configured(&base);
    let run = probe(&client(), &fixture.store.read().unwrap()).await;
    assert_eq!(run.tools, ToolVerdict::On(ToolChoice::Auto));

    let seen = seen.lock().unwrap();
    let assistant = &seen.chats[1]["messages"][1];
    assert_eq!(assistant["content"], Value::Null);
    assert_eq!(assistant["tool_calls"][0]["id"], "probe-text-call");
    assert_eq!(
        assistant["tool_calls"][0]["function"],
        json!({"name": "memry_probe_echo", "arguments": "{\"text\":\"ok\"}"})
    );
}

#[tokio::test]
async fn a_model_that_never_calls_or_rejects_tools_turns_them_off() {
    let silent: Script =
        Arc::new(|_: &Value| message(json!({"role": "assistant", "content": "hi"})));
    let (base, _) = server(&["qwen"], StatusCode::OK, silent).await;
    let run = probe(&client(), &configured(&base).store.read().unwrap()).await;
    assert_eq!(
        run.tools,
        ToolVerdict::Off {
            reason: AgentToolsOffReason::NoToolCall,
            detail: None
        }
    );
    assert!(!run.result.tools_enabled && !run.result.tool_calling_supported);
    assert_eq!(
        run.result.detail.as_deref(),
        Some("Model did not emit the synthetic memry_probe_echo tool call.")
    );

    let rejecting: Script = Arc::new(|_: &Value| {
        (
            StatusCode::BAD_REQUEST,
            json!({"error": "model does not support tools"}).to_string(),
        )
    });
    let (base, _) = server(&["qwen"], StatusCode::OK, rejecting).await;
    let run = probe(&client(), &configured(&base).store.read().unwrap()).await;
    let detail = "/v1/chat/completions returned HTTP 400: model does not support tools";
    assert_eq!(
        run.tools,
        ToolVerdict::Off {
            reason: AgentToolsOffReason::ToolsRejected,
            detail: Some(detail.to_owned())
        }
    );
    assert_eq!(run.result.detail.as_deref(), Some(detail));
}

#[tokio::test]
async fn a_rejected_tool_result_counts_as_called_but_not_continued() {
    let script: Script = Arc::new(|body: &Value| {
        if body["messages"].as_array().unwrap().len() == 1 {
            native_call()(body)
        } else {
            message(Value::Null)
        }
    });
    let (base, _) = server(&["qwen"], StatusCode::OK, script).await;
    let run = probe(&client(), &configured(&base).store.read().unwrap()).await;
    assert_eq!(
        run.tools,
        ToolVerdict::Off {
            reason: AgentToolsOffReason::ToolResultRejected,
            detail: None
        }
    );
    assert!(run.result.tool_calling_supported && !run.result.tool_continuation_supported);
}

#[tokio::test]
async fn a_server_error_says_nothing_about_tools_and_keeps_them_on() {
    for status in [
        StatusCode::REQUEST_TIMEOUT,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::SERVICE_UNAVAILABLE,
    ] {
        let script: Script = Arc::new(move |_: &Value| (status, String::new()));
        let (base, seen) = server(&["qwen"], StatusCode::OK, script).await;
        let run = probe(&client(), &configured(&base).store.read().unwrap()).await;
        assert_eq!(run.tools, ToolVerdict::Transient, "{status}");
        assert!(run.result.tools_enabled);
        assert!(
            run.result
                .detail
                .unwrap()
                .starts_with("Tool check hit a temporary provider error, tools stay on:")
        );
        // A transient answer is not retried without `tool_choice`.
        assert_eq!(seen.lock().unwrap().chats.len(), 1, "{status}");
    }
}

#[tokio::test]
async fn no_streamed_reply_turns_tools_off_before_any_tool_request() {
    let (base, seen) = server(&["qwen"], StatusCode::NOT_FOUND, native_call()).await;
    let run = probe(&client(), &configured(&base).store.read().unwrap()).await;
    assert_eq!(
        run.tools,
        ToolVerdict::Off {
            reason: AgentToolsOffReason::StreamingUnsupported,
            detail: None
        }
    );
    assert!(!run.result.streaming_supported && !run.result.tools_enabled);
    assert_eq!(
        run.result.detail.as_deref(),
        Some("/v1/chat/completions streaming returned HTTP 404")
    );
    assert!(seen.lock().unwrap().chats.is_empty());
}
