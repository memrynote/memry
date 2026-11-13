//! The inline AI settings store against a real session and vault: each provider's key lives in the
//! keychain, the renderer sees it masked, a plaintext row (Electron's) moves into the keychain only
//! after a verified read-back, a locked keychain never loses the key or writes half a change, and
//! a key never follows a change of provider or custom host (#4451).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::ai::catalog::{ProbeClient, list_models};
use memry_desktop::ai::provider::AiProvider;
use memry_desktop::ai::settings::{
    AiSettingsError, InlineAiStore, InlineAiUpdates, MASKED_KEY, SERVICE,
};
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::seams::secure_store::{
    DEADLINE, GenericSecrets, KeyringStore, Store, StoreFactory,
};
use memry_desktop::session::{OpenSource, OpenVault, Session};
use memry_desktop::settings::SettingsService;
use serde_json::{Map, Value, json};

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

/// Runs inside `set_secret`, before the write lands: another writer acting mid-migration.
type OnSet = Box<dyn Fn() + Send + Sync>;

/// The keychain: an in-memory map that can be locked, can fail only reads, can refuse only
/// writes, can drop writes (a false-absent read) and counts reads.
#[derive(Default)]
struct Keychain {
    items: Mutex<HashMap<(String, String), Vec<u8>>>,
    locked: AtomicBool,
    get_fails: AtomicBool,
    set_fails: AtomicBool,
    drops_writes: AtomicBool,
    gets: AtomicUsize,
    on_set: Mutex<Option<OnSet>>,
}

impl Keychain {
    fn item(&self, account: &str) -> Option<String> {
        self.items
            .lock()
            .unwrap()
            .get(&(SERVICE.to_owned(), account.to_owned()))
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
        if self.get_fails.load(Ordering::SeqCst) {
            return Err(SecureStoreError::Failed {
                what: "the keychain failed the read".to_owned(),
            });
        }
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
        if self.set_fails.load(Ordering::SeqCst) {
            return Err(SecureStoreError::Failed {
                what: "the keychain refused the write".to_owned(),
            });
        }
        if let Some(on_set) = self.on_set.lock().unwrap().as_ref() {
            on_set();
        }
        if !self.drops_writes.load(Ordering::SeqCst) {
            let key = (service.to_owned(), account.to_owned());
            self.items.lock().unwrap().insert(key, value.to_vec());
        }
        Ok(())
    }
    fn delete_secret(&self, service: &str, account: &str) -> Result<(), SecureStoreError> {
        self.check()?;
        let key = (service.to_owned(), account.to_owned());
        self.items.lock().unwrap().remove(&key);
        Ok(())
    }
}

struct World {
    _dir: tempfile::TempDir,
    vault: OpenVault,
    _session: Session,
    device_keys: Arc<DeviceKeys>,
    keychain: Arc<Keychain>,
    store: InlineAiStore,
}

fn world_with(device: Option<&str>) -> World {
    let dir = tempfile::tempdir().expect("tmp");
    let app = dir.path().join("app");
    let vault_dir = dir.path().join("vault");
    std::fs::create_dir_all(&app).expect("app dir");
    std::fs::create_dir_all(&vault_dir).expect("vault dir");
    let config = Arc::new(AppConfig::load(app.join("memry-config.json")));
    let session = Session::new(VaultRegistry::new(config.clone()));
    let vault = session
        .open(&vault_dir, OpenSource::Select)
        .expect("open")
        .vault;
    let device_keys = Arc::new(DeviceKeys::default());
    let keychain = Arc::new(Keychain::default());
    let store = InlineAiStore::new(
        SettingsService::new(device_keys.clone(), config),
        keychain.clone(),
        device.map(str::to_owned),
    );
    World {
        _dir: dir,
        vault,
        _session: session,
        device_keys,
        keychain,
        store,
    }
}

fn world() -> World {
    world_with(None)
}

impl World {
    /// The `ai-inline` row as stored, read through the core and not through the store.
    fn row(&self) -> Map<String, Value> {
        let settings = self
            .vault
            .vault
            .app_settings(self.device_keys.clone())
            .expect("app settings");
        settings
            .get_group("ai-inline")
            .expect("group")
            .value
            .as_object()
            .cloned()
            .expect("object")
    }

    /// A row as Electron (or an import of it) left it: the key in plaintext.
    fn seed_plaintext(&self, key: &str) {
        let patch = json!({"provider": "openai", "model": "gpt-4.1", "apiKey": key});
        write_row(&self.vault, &self.device_keys, patch);
    }

    fn account(&self) -> String {
        format!("api-key:{}", self.vault.vault_id)
    }

    /// A cloud provider with `key` in the keychain, and the cached copy dropped (a new session).
    fn cloud_with_key(&self, key: &str) {
        let updates = InlineAiUpdates {
            provider: Some(AiProvider::Openai),
            model: Some("gpt-4.1".to_owned()),
            ..key_update(key)
        };
        self.store.write(Some(&self.vault), updates).expect("write");
        self.store.forget();
    }
}

/// Writes the `ai-inline` row through the core, around the store.
fn write_row(vault: &OpenVault, device_keys: &Arc<DeviceKeys>, patch: Value) {
    memry_core::api::auth::ensure_device_identity(device_keys.clone()).expect("identity");
    let settings = vault
        .vault
        .app_settings(device_keys.clone())
        .expect("app settings");
    settings
        .set_group("ai-inline", patch.as_object().cloned().unwrap())
        .expect("row write");
}

fn key_update(key: &str) -> InlineAiUpdates {
    InlineAiUpdates {
        api_key: Some(key.to_owned()),
        ..InlineAiUpdates::default()
    }
}

#[test]
fn a_plaintext_row_moves_into_the_keychain_after_a_verified_read_back() {
    let w = world();
    w.seed_plaintext("sk-electron");

    let masked = w.store.masked(Some(&w.vault)).expect("read");
    assert_eq!(masked.api_key, MASKED_KEY);
    assert_eq!(masked.provider, AiProvider::Openai);
    assert_eq!(masked.model, "gpt-4.1");
    assert_eq!(
        w.keychain.item(&w.slot("openai")).as_deref(),
        Some("sk-electron")
    );
    assert_eq!(w.row()["apiKey"], json!(""));
    assert_eq!(w.row()["model"], json!("gpt-4.1"));
    assert_eq!(
        w.store.read(Some(&w.vault)).expect("read").api_key,
        "sk-electron"
    );
}

#[test]
fn a_false_absent_read_back_never_empties_the_row() {
    let w = world();
    w.seed_plaintext("sk-electron");
    w.keychain.drops_writes.store(true, Ordering::SeqCst);

    // The key did not land: it is not sent, and the row keeps it for the next read.
    assert!(matches!(
        w.store.read(Some(&w.vault)),
        Err(AiSettingsError::Keychain(SecureStoreError::Failed { .. }))
    ));
    assert_eq!(w.row()["apiKey"], json!("sk-electron"));
}

#[test]
fn a_typed_key_goes_to_the_keychain_and_never_back_to_the_renderer() {
    let w = world();
    w.select(AiProvider::Openai, "");
    let written = w
        .store
        .write(Some(&w.vault), key_update("sk-new"))
        .expect("write");
    assert_eq!(written.api_key, MASKED_KEY);
    assert_eq!(
        w.store.masked(Some(&w.vault)).expect("read").api_key,
        MASKED_KEY
    );
    assert_eq!(
        w.keychain.item(&w.slot("openai")).as_deref(),
        Some("sk-new")
    );
    assert_eq!(w.row()["apiKey"], json!(""));
    assert!(!serde_json::to_string(&w.row()).unwrap().contains("sk-new"));
}

#[test]
fn the_masked_value_is_ignored_and_the_empty_string_deletes_the_key() {
    let w = world();
    w.select(AiProvider::Openai, "");
    w.store
        .write(Some(&w.vault), key_update("sk-new"))
        .expect("write");

    let mut updates = key_update(MASKED_KEY);
    updates.model = Some("gpt-4o".to_owned());
    let written = w.store.write(Some(&w.vault), updates).expect("write");
    assert_eq!(written.model, "gpt-4o");
    assert_eq!(
        w.keychain.item(&w.slot("openai")).as_deref(),
        Some("sk-new")
    );

    let cleared = w
        .store
        .write(Some(&w.vault), key_update(""))
        .expect("write");
    assert_eq!(cleared.api_key, "");
    assert_eq!(w.keychain.item(&w.slot("openai")), None);
}

#[test]
fn a_locked_keychain_refuses_a_key_write_and_writes_nothing() {
    let w = world();
    w.select(AiProvider::Openai, "");
    w.keychain.locked.store(true, Ordering::SeqCst);
    let mut updates = key_update("sk-new");
    updates.model = Some("gpt-4o".to_owned());
    let error = w.store.write(Some(&w.vault), updates).expect_err("locked");
    assert!(matches!(
        error,
        AiSettingsError::Keychain(SecureStoreError::Locked)
    ));
    assert_eq!(w.row()["model"], json!("llama3.2"));
    assert_eq!(w.row()["apiKey"], json!(""));
}

#[test]
fn a_failed_key_write_leaves_the_row_and_the_cached_key_alone() {
    let w = world();
    w.cloud_with_key("sk-old");
    assert_eq!(
        w.store.read(Some(&w.vault)).expect("read").api_key,
        "sk-old"
    );
    w.keychain.set_fails.store(true, Ordering::SeqCst);

    let mut updates = key_update("sk-new");
    updates.model = Some("gpt-4o".to_owned());
    let error = w
        .store
        .write(Some(&w.vault), updates)
        .expect_err("set fails");
    assert!(matches!(
        error,
        AiSettingsError::Keychain(SecureStoreError::Failed { .. })
    ));
    assert_eq!(w.row()["model"], json!("gpt-4.1"));
    assert_eq!(
        w.keychain.item(&w.slot("openai")).as_deref(),
        Some("sk-old")
    );
    let gets = w.keychain.gets.load(Ordering::SeqCst);
    assert_eq!(
        w.store.read(Some(&w.vault)).expect("read").api_key,
        "sk-old"
    );
    assert_eq!(
        w.keychain.gets.load(Ordering::SeqCst),
        gets,
        "served from the cache"
    );
}

#[test]
fn a_locked_keychain_masks_an_unknown_key_and_takes_non_key_edits() {
    let w = world();
    w.cloud_with_key("sk-old");
    w.keychain.locked.store(true, Ordering::SeqCst);

    // Unknown, not absent: masked, so the renderer echoing it back leaves the key alone.
    let masked = w.store.masked(Some(&w.vault)).expect("masked read");
    assert_eq!(masked.api_key, MASKED_KEY);

    let updates = InlineAiUpdates {
        model: Some("gpt-4o".to_owned()),
        ..key_update(MASKED_KEY)
    };
    let written = w
        .store
        .write(Some(&w.vault), updates)
        .expect("non-key write");
    assert_eq!(written.model, "gpt-4o");
    assert_eq!(written.api_key, MASKED_KEY);
    assert_eq!(w.row()["model"], json!("gpt-4o"));

    // The key itself is still needed for a cloud call: that fails.
    assert!(matches!(
        w.store.read(Some(&w.vault)),
        Err(AiSettingsError::Keychain(SecureStoreError::Locked))
    ));
    w.keychain.locked.store(false, Ordering::SeqCst);
    assert_eq!(
        w.store.read(Some(&w.vault)).expect("read").api_key,
        "sk-old"
    );
}

#[test]
fn ollama_works_with_a_locked_keychain() {
    let w = world();
    w.keychain.locked.store(true, Ordering::SeqCst);

    // The model list and the connection test read the settings with `read`.
    let read = w.store.read(Some(&w.vault)).expect("ollama read");
    assert_eq!(read.provider, AiProvider::Ollama);
    assert_eq!(read.api_key, "");
    assert_eq!(w.keychain.gets.load(Ordering::SeqCst), 0);
    w.store.masked(Some(&w.vault)).expect("ollama masked read");
    let updates = InlineAiUpdates {
        base_url: Some("http://localhost:11435/v1".to_owned()),
        ..InlineAiUpdates::default()
    };
    let written = w
        .store
        .write(Some(&w.vault), updates)
        .expect("ollama write");
    assert_eq!(written.base_url, "http://localhost:11435/v1");
}

#[test]
fn a_failing_keychain_never_stops_ollama_from_opening_its_settings() {
    let w = world();
    w.cloud_with_key("sk-old");
    let updates = InlineAiUpdates {
        provider: Some(AiProvider::Ollama),
        ..InlineAiUpdates::default()
    };
    w.store
        .write(Some(&w.vault), updates)
        .expect("switch to ollama");
    w.store.forget();
    w.keychain.get_fails.store(true, Ordering::SeqCst);

    // Ollama has no key of its own, so neither read asks the keychain.
    let masked = w.store.masked(Some(&w.vault)).expect("ollama masked read");
    assert_eq!(masked.provider, AiProvider::Ollama);
    assert_eq!(masked.api_key, "");
    w.store.read(Some(&w.vault)).expect("ollama read");

    w.keychain.get_fails.store(false, Ordering::SeqCst);
    w.store.forget();
    let back = InlineAiUpdates {
        provider: Some(AiProvider::Openai),
        ..InlineAiUpdates::default()
    };
    w.store.write(Some(&w.vault), back).expect("switch back");
    assert!(w.store.read(Some(&w.vault)).expect("read").api_key == "sk-old");
}

#[test]
fn a_migration_never_empties_a_row_that_changed_under_it() {
    let w = world();
    w.seed_plaintext("sk-electron");
    let (vault, device_keys) = (w.vault.clone(), w.device_keys.clone());
    *w.keychain.on_set.lock().unwrap() = Some(Box::new(move || {
        write_row(&vault, &device_keys, json!({"apiKey": "sk-other"}));
    }));

    w.store.read(Some(&w.vault)).expect("read");
    assert_eq!(w.row()["apiKey"], json!("sk-other"));
}

/// Electron after c44a4afcfd writes `provider: "custom"` with the endpoint in `baseUrl`; this
/// build reads the row as that provider, moves its key, and hands the key to Rust callers.
#[test]
fn a_custom_provider_row_from_a_newer_electron_reads_as_custom_with_its_key() {
    let w = world();
    let row = json!({
        "enabled": true,
        "provider": "custom",
        "model": "anthropic/claude-sonnet-4",
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKey": "sk-or"
    });
    write_row(&w.vault, &w.device_keys, row);

    let masked = w.store.masked(Some(&w.vault)).expect("masked");
    assert_eq!(masked.provider, AiProvider::Custom);
    assert_eq!(masked.model, "anthropic/claude-sonnet-4");
    assert_eq!(masked.base_url, "https://openrouter.ai/api/v1");
    assert_eq!(masked.api_key, MASKED_KEY);
    assert_eq!(w.row()["provider"], json!("custom"));
    assert_eq!(
        w.keychain
            .item(&w.slot("custom:https://openrouter.ai"))
            .as_deref(),
        Some("sk-or")
    );

    w.store.forget();
    assert_eq!(w.store.read(Some(&w.vault)).expect("read").api_key, "sk-or");
}

#[test]
fn the_key_is_read_from_the_keychain_once_per_session() {
    let w = world();
    w.cloud_with_key("sk-new");
    let before = w.keychain.gets.load(Ordering::SeqCst);
    for _ in 0..3 {
        assert_eq!(
            w.store.read(Some(&w.vault)).expect("read").api_key,
            "sk-new"
        );
    }
    assert_eq!(w.keychain.gets.load(Ordering::SeqCst) - before, 1);
}

#[test]
fn without_a_vault_reads_are_the_defaults_and_writes_say_so() {
    let w = world();
    let read = w.store.masked(None).expect("defaults");
    assert_eq!(read.provider, AiProvider::Ollama);
    assert_eq!(read.base_url, "http://localhost:11434/v1");
    assert!(read.enabled);
    assert!(matches!(
        w.store.write(None, key_update("sk")),
        Err(AiSettingsError::NoVault)
    ));
}

#[test]
fn the_account_names_the_vault_and_the_device_as_the_sync_entries_do() {
    let w = world_with(Some("a"));
    let id = &w.vault.vault_id;
    assert_eq!(w.store.legacy_account(id), format!("api-key:{id}-a"));
    assert_eq!(
        w.store.key_account(id, AiProvider::Openai, ""),
        Some(format!("api-key:{id}:openai-a"))
    );
    assert_eq!(w.store.key_account(id, AiProvider::Ollama, ""), None);
    w.select(AiProvider::Openai, "");
    w.store
        .write(Some(&w.vault), key_update("sk-a"))
        .expect("write");
    assert_eq!(
        w.keychain
            .item(&format!("api-key:{id}:openai-a"))
            .as_deref(),
        Some("sk-a")
    );

    let worktree = world_with(Some("dev-0123abcd"));
    let id = &worktree.vault.vault_id;
    assert_eq!(
        worktree.store.legacy_account(id),
        format!("api-key:{id}-dev")
    );
    assert_eq!(
        worktree.store.key_account(id, AiProvider::Google, ""),
        Some(format!("api-key:{id}:google-dev"))
    );
}

/// The OS credential store, as keyring-core's in-memory mock.
struct Mock(Store);

impl StoreFactory for Mock {
    fn build(&self) -> keyring_core::Result<Store> {
        Ok(self.0.clone())
    }
}

#[test]
fn the_real_keychain_worker_accepts_the_inline_service() {
    let credentials: Store = keyring_core::mock::Store::new().unwrap();
    let keychain = KeyringStore::with_factory(Mock(credentials), None, DEADLINE);
    keychain
        .set_secret(SERVICE, "api-key:v", b"sk")
        .expect("an app service under com.memrynote.memry.");
    assert_eq!(
        keychain.get_secret(SERVICE, "api-key:v").expect("get"),
        Some(b"sk".to_vec())
    );
}

// #4451: a key belongs to one provider, and a custom key to one endpoint origin.

impl World {
    fn slot(&self, slot: &str) -> String {
        format!("api-key:{}:{slot}", self.vault.vault_id)
    }

    fn select(&self, provider: AiProvider, base_url: &str) {
        let updates = InlineAiUpdates {
            provider: Some(provider),
            base_url: Some(base_url.to_owned()),
            ..InlineAiUpdates::default()
        };
        self.store
            .write(Some(&self.vault), updates)
            .expect("select");
    }

    fn key(&self) -> String {
        let read = self.store.read(Some(&self.vault)).expect("read");
        read.api_key.clone()
    }

    /// A key Tauri stored before #4451: one entry for every provider.
    fn seed_legacy(&self, provider: &str, key: &str) {
        write_row(
            &self.vault,
            &self.device_keys,
            json!({"provider": provider}),
        );
        let item = (SERVICE.to_owned(), self.account());
        let mut items = self.keychain.items.lock().unwrap();
        items.insert(item, key.as_bytes().to_vec());
    }
}

/// A provider that records the request headers of `GET /v1/models`.
async fn recording_host() -> (String, Arc<Mutex<Vec<axum::http::HeaderMap>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();
    let app = axum::Router::new().route(
        "/v1/models",
        axum::routing::get(move |headers: axum::http::HeaderMap| {
            let record = record.clone();
            async move {
                record.lock().unwrap().push(headers);
                r#"{"data":[]}"#
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move { axum::serve(listener, app).await });
    (format!("http://127.0.0.1:{port}/v1"), seen)
}

#[tokio::test]
async fn switching_openai_to_a_custom_host_sends_that_host_no_key() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let w = world();
    w.cloud_with_key("sk-openai");
    let (evil, seen) = recording_host().await;
    w.select(AiProvider::Custom, &evil);

    let settings = w.store.read(Some(&w.vault)).expect("read");
    assert_eq!(settings.api_key, "");
    assert_eq!(w.store.masked(Some(&w.vault)).expect("masked").api_key, "");
    let client = ProbeClient::new(memry_desktop::http::builder());
    list_models(&client, &settings).await.expect("listed");
    let headers = seen.lock().unwrap()[0].clone();
    assert!(headers.get("authorization").is_none(), "{headers:?}");
}

#[test]
fn switching_back_to_openai_restores_its_key() {
    let w = world();
    w.cloud_with_key("sk-openai");
    w.select(AiProvider::Custom, "https://evil.example/v1");
    w.store
        .write(Some(&w.vault), key_update("sk-evil"))
        .expect("custom key");
    w.select(AiProvider::Anthropic, "");
    assert_eq!(w.key(), "");

    w.select(AiProvider::Openai, "");
    assert_eq!(w.key(), "sk-openai");
    assert_eq!(
        w.store.masked(Some(&w.vault)).expect("masked").api_key,
        MASKED_KEY
    );
    assert_eq!(
        w.keychain.item(&w.slot("openai")).as_deref(),
        Some("sk-openai")
    );
    w.select(AiProvider::Custom, "https://evil.example/v1");
    assert_eq!(w.key(), "sk-evil");
}

#[test]
fn a_custom_key_follows_the_normalized_origin_of_its_endpoint() {
    let w = world();
    w.select(AiProvider::Custom, "https://openrouter.ai/api/v1");
    w.store
        .write(Some(&w.vault), key_update("sk-or"))
        .expect("custom key");
    assert_eq!(
        w.keychain
            .item(&w.slot("custom:https://openrouter.ai"))
            .as_deref(),
        Some("sk-or")
    );

    w.select(AiProvider::Custom, " HTTPS://OpenRouter.AI:443/other/ ");
    assert_eq!(w.key(), "sk-or");
    for other in [
        "http://openrouter.ai/api/v1",
        "https://openrouter.ai:8443/api/v1",
        "https://evil.openrouter.ai/api/v1",
        "",
        "not a url",
    ] {
        w.select(AiProvider::Custom, other);
        assert_eq!(w.key(), "", "{other}");
    }
}

#[test]
fn a_key_typed_without_an_endpoint_is_refused_and_stored_nowhere() {
    let w = world();
    w.select(AiProvider::Custom, "");
    let error = w
        .store
        .write(Some(&w.vault), key_update("sk-x"))
        .expect_err("no endpoint");
    assert!(matches!(error, AiSettingsError::NoKeyTarget), "{error:?}");
    assert!(w.keychain.items.lock().unwrap().is_empty());
}

#[test]
fn the_legacy_key_moves_once_to_the_provider_selected_at_first_read() {
    let w = world();
    w.seed_legacy("openai", "sk-legacy");

    assert_eq!(w.key(), "sk-legacy");
    assert_eq!(
        w.keychain.item(&w.slot("openai")).as_deref(),
        Some("sk-legacy")
    );
    // Kept for the Electron import of Step 37.
    assert_eq!(w.keychain.item(&w.account()).as_deref(), Some("sk-legacy"));

    w.select(AiProvider::Custom, "https://evil.example/v1");
    w.store.forget();
    assert_eq!(w.key(), "");
    w.select(AiProvider::Anthropic, "");
    assert_eq!(w.key(), "");
    w.select(AiProvider::Openai, "");
    assert_eq!(w.key(), "sk-legacy");
}

#[test]
fn a_legacy_key_found_under_ollama_binds_to_no_provider() {
    let w = world();
    w.seed_legacy("ollama", "sk-legacy");
    w.store.read(Some(&w.vault)).expect("ollama read");
    assert_eq!(w.keychain.gets.load(Ordering::SeqCst), 0);

    w.select(AiProvider::Custom, "https://evil.example/v1");
    assert_eq!(w.key(), "");
    w.select(AiProvider::Openai, "");
    assert_eq!(w.key(), "");
    assert_eq!(w.keychain.item(&w.account()).as_deref(), Some("sk-legacy"));
}

#[test]
fn a_locked_keychain_holds_the_legacy_key_back_until_it_can_bind() {
    let w = world();
    w.seed_legacy("openai", "sk-legacy");
    w.keychain.locked.store(true, Ordering::SeqCst);

    assert!(matches!(
        w.store.read(Some(&w.vault)),
        Err(AiSettingsError::Keychain(SecureStoreError::Locked))
    ));
    assert_eq!(
        w.store.masked(Some(&w.vault)).expect("masked").api_key,
        MASKED_KEY
    );
    // A selection change would rebind the pending key: refused while it cannot move.
    let updates = InlineAiUpdates {
        provider: Some(AiProvider::Custom),
        base_url: Some("https://evil.example/v1".to_owned()),
        ..InlineAiUpdates::default()
    };
    assert!(matches!(
        w.store.write(Some(&w.vault), updates),
        Err(AiSettingsError::Keychain(SecureStoreError::Locked))
    ));
    assert_eq!(w.row()["provider"], json!("openai"));

    w.keychain.locked.store(false, Ordering::SeqCst);
    assert_eq!(w.key(), "sk-legacy");
    w.select(AiProvider::Custom, "https://evil.example/v1");
    assert_eq!(w.key(), "");
}

#[test]
fn a_locked_keychain_never_sends_a_plaintext_row_key() {
    let w = world();
    w.seed_plaintext("sk-electron");
    w.keychain.locked.store(true, Ordering::SeqCst);

    assert!(matches!(
        w.store.read(Some(&w.vault)),
        Err(AiSettingsError::Keychain(SecureStoreError::Locked))
    ));
    assert_eq!(w.row()["apiKey"], json!("sk-electron"));
    let updates = InlineAiUpdates {
        provider: Some(AiProvider::Custom),
        base_url: Some("https://evil.example/v1".to_owned()),
        ..InlineAiUpdates::default()
    };
    assert!(w.store.write(Some(&w.vault), updates).is_err());

    w.keychain.locked.store(false, Ordering::SeqCst);
    assert_eq!(w.key(), "sk-electron");
    assert_eq!(
        w.keychain.item(&w.slot("openai")).as_deref(),
        Some("sk-electron")
    );
    assert_eq!(w.row()["apiKey"], json!(""));
}
