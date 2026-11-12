//! The inline AI settings store against a real session and vault: the key lives in the keychain,
//! the renderer sees it masked, a plaintext row (Electron's) moves into the keychain only after a
//! verified read-back, and a locked keychain never loses the key or writes half a change.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
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
        w.keychain.item(&w.account()).as_deref(),
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
fn a_locked_keychain_keeps_the_plaintext_row_and_this_session_uses_it() {
    let w = world();
    w.seed_plaintext("sk-electron");
    w.keychain.locked.store(true, Ordering::SeqCst);

    let read = w.store.read(Some(&w.vault)).expect("read");
    assert_eq!(read.api_key, "sk-electron");
    assert_eq!(w.row()["apiKey"], json!("sk-electron"));
    assert_eq!(w.keychain.item(&w.account()), None);

    // The next read retries once the keychain is back.
    w.keychain.locked.store(false, Ordering::SeqCst);
    assert_eq!(
        w.store.read(Some(&w.vault)).expect("read").api_key,
        "sk-electron"
    );
    assert_eq!(w.row()["apiKey"], json!(""));
    assert_eq!(
        w.keychain.item(&w.account()).as_deref(),
        Some("sk-electron")
    );
}

#[test]
fn a_false_absent_read_back_never_empties_the_row() {
    let w = world();
    w.seed_plaintext("sk-electron");
    w.keychain.drops_writes.store(true, Ordering::SeqCst);

    assert_eq!(
        w.store.read(Some(&w.vault)).expect("read").api_key,
        "sk-electron"
    );
    assert_eq!(w.row()["apiKey"], json!("sk-electron"));
}

#[test]
fn a_typed_key_goes_to_the_keychain_and_never_back_to_the_renderer() {
    let w = world();
    let written = w
        .store
        .write(Some(&w.vault), key_update("sk-new"))
        .expect("write");
    assert_eq!(written.api_key, MASKED_KEY);
    assert_eq!(
        w.store.masked(Some(&w.vault)).expect("read").api_key,
        MASKED_KEY
    );
    assert_eq!(w.keychain.item(&w.account()).as_deref(), Some("sk-new"));
    assert_eq!(w.row()["apiKey"], json!(""));
    assert!(!serde_json::to_string(&w.row()).unwrap().contains("sk-new"));
}

#[test]
fn the_masked_value_is_ignored_and_the_empty_string_deletes_the_key() {
    let w = world();
    w.store
        .write(Some(&w.vault), key_update("sk-new"))
        .expect("write");

    let mut updates = key_update(MASKED_KEY);
    updates.model = Some("gpt-4o".to_owned());
    let written = w.store.write(Some(&w.vault), updates).expect("write");
    assert_eq!(written.model, "gpt-4o");
    assert_eq!(w.keychain.item(&w.account()).as_deref(), Some("sk-new"));

    let cleared = w
        .store
        .write(Some(&w.vault), key_update(""))
        .expect("write");
    assert_eq!(cleared.api_key, "");
    assert_eq!(w.keychain.item(&w.account()), None);
}

#[test]
fn a_locked_keychain_refuses_a_key_write_and_writes_nothing() {
    let w = world();
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
    assert_eq!(w.keychain.item(&w.account()).as_deref(), Some("sk-old"));
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

    // The stored cloud key is unknown, not absent: masked, so it survives a round trip.
    let masked = w.store.masked(Some(&w.vault)).expect("ollama masked read");
    assert_eq!(masked.provider, AiProvider::Ollama);
    assert_eq!(masked.api_key, MASKED_KEY);
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
    assert_eq!(w.store.account(id), format!("api-key:{id}-a"));
    w.store
        .write(Some(&w.vault), key_update("sk-a"))
        .expect("write");
    assert_eq!(
        w.keychain.item(&format!("api-key:{id}-a")).as_deref(),
        Some("sk-a")
    );

    let worktree = world_with(Some("dev-0123abcd"));
    let id = &worktree.vault.vault_id;
    assert_eq!(worktree.store.account(id), format!("api-key:{id}-dev"));
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
