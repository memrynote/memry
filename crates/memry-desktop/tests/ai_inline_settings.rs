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

/// The keychain: an in-memory map that can be locked, can drop writes (a false-absent read) and
/// counts reads.
#[derive(Default)]
struct Keychain {
    items: Mutex<HashMap<(String, String), Vec<u8>>>,
    locked: AtomicBool,
    drops_writes: AtomicBool,
    gets: AtomicUsize,
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
        memry_core::api::auth::ensure_device_identity(self.device_keys.clone()).expect("identity");
        let settings = self
            .vault
            .vault
            .app_settings(self.device_keys.clone())
            .expect("app settings");
        let patch = json!({"provider": "openai", "model": "gpt-4.1", "apiKey": key});
        settings
            .set_group("ai-inline", patch.as_object().cloned().unwrap())
            .expect("seed");
    }

    fn account(&self) -> String {
        format!("api-key:{}", self.vault.vault_id)
    }
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
fn the_key_is_read_from_the_keychain_once_per_session() {
    let w = world();
    w.store
        .write(Some(&w.vault), key_update("sk-new"))
        .expect("write");
    w.store.forget();
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
fn the_account_names_the_vault_and_the_device() {
    let w = world_with(Some("a"));
    assert_eq!(
        w.store.account(&w.vault.vault_id),
        format!("api-key:{}:a", w.vault.vault_id)
    );
    w.store
        .write(Some(&w.vault), key_update("sk-a"))
        .expect("write");
    assert_eq!(
        w.keychain
            .item(&format!("api-key:{}:a", w.vault.vault_id))
            .as_deref(),
        Some("sk-a")
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
