//! The settings service against a real session and vault: reads fall back to defaults without
//! a vault, a write splits between the local row and the synced item, the vault's `config.json`
//! mirrors portable fields, and opening a vault seeds from its preferences once.

use std::path::PathBuf;
use std::sync::Arc;

use memry_desktop::profile_store::ProfileDeviceKeyStore;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::settings::{SettingsError, SettingsService};
use memry_desktop::startup_values;
use memry_desktop::vault::config;
use serde_json::{Map, Value, json};

struct World {
    dir: tempfile::TempDir,
    session: Session,
    service: SettingsService,
    config: Arc<AppConfig>,
}

fn world() -> World {
    let dir = tempfile::tempdir().expect("tmp");
    let app = dir.path().join("app");
    std::fs::create_dir_all(&app).expect("app dir");
    let config = Arc::new(AppConfig::load(app.join("memry-config.json")));
    let session = Session::new(VaultRegistry::new(config.clone()));
    let service = SettingsService::new(ProfileDeviceKeyStore::shared(&app), config.clone());
    World {
        dir,
        session,
        service,
        config,
    }
}

impl World {
    fn vault(&self, name: &str) -> PathBuf {
        let path = self.dir.path().join(name);
        std::fs::create_dir_all(&path).expect("vault dir");
        path
    }

    fn open(&self, name: &str) -> memry_desktop::session::OpenVault {
        self.session
            .open(&self.vault(name), OpenSource::Select)
            .expect("open")
            .vault
    }
}

fn patch(value: Value) -> Map<String, Value> {
    value.as_object().cloned().expect("object")
}

#[test]
fn without_a_vault_a_read_is_the_defaults_and_a_write_says_so() {
    let w = world();
    let read = w.service.read_group(None, "general").expect("defaults");
    assert_eq!(read.value["theme"], "white");
    assert!(matches!(
        w.service
            .write_group(None, "general", patch(json!({"theme": "dark"}))),
        Err(SettingsError::NoVault)
    ));
    assert!(matches!(
        w.service.read_group(None, "nope"),
        Err(SettingsError::Invalid(_))
    ));
}

#[test]
fn a_write_round_trips_mirrors_the_portable_fields_and_caches_the_startup_theme() {
    let w = world();
    let vault = w.open("v1");
    let change = w
        .service
        .write_group(
            Some(&vault),
            "general",
            patch(json!({"theme": "dark", "zoomFactor": 1.4})),
        )
        .expect("write");
    assert_eq!(change.fields, ["theme", "zoomFactor"]);
    let read = w.service.read_group(Some(&vault), "general").expect("read");
    assert_eq!(
        (
            read.value["theme"].as_str(),
            read.value["zoomFactor"].as_f64()
        ),
        (Some("dark"), Some(1.4))
    );

    let on_disk: Value = serde_json::from_slice(
        &std::fs::read(config::config_path(&vault.path)).expect("config.json"),
    )
    .expect("json");
    assert_eq!(on_disk["preferences"]["theme"], "dark");
    assert!(
        on_disk["preferences"].get("zoomFactor").is_none(),
        "zoom describes this machine"
    );
    assert_eq!(startup_values::read(&w.config, None).theme, "dark");

    assert!(matches!(
        w.service
            .write_group(Some(&vault), "general", patch(json!({"fontSizePx": 99}))),
        Err(SettingsError::Invalid(_))
    ));
    assert_eq!(
        w.service
            .read_group(Some(&vault), "general")
            .expect("read")
            .value["fontSizePx"],
        16
    );
}

#[test]
fn opening_a_vault_with_stored_preferences_seeds_the_settings_once() {
    let w = world();
    let path = w.vault("v2");
    std::fs::create_dir_all(path.join(".memry")).expect("mkdir");
    std::fs::write(
        config::config_path(&path),
        r#"{"preferences":{"theme":"light","fontSize":"large","editor":{"width":"full"}}}"#,
    )
    .expect("seed");
    let vault = w
        .session
        .open(&path, OpenSource::Select)
        .expect("open")
        .vault;
    w.service.on_open(&vault).expect("seed");
    let general = w
        .service
        .read_group(Some(&vault), "general")
        .expect("read")
        .value;
    assert_eq!(
        (general["theme"].as_str(), general["fontSizePx"].as_i64()),
        (Some("light"), Some(20))
    );
    assert_eq!(
        w.service
            .read_group(Some(&vault), "editor")
            .expect("read")
            .value["width"],
        "full"
    );

    // A choice made since is not overwritten by a second open.
    w.service
        .write_group(Some(&vault), "general", patch(json!({"theme": "dark"})))
        .expect("write");
    w.service.on_open(&vault).expect("again");
    assert_eq!(
        w.service
            .read_group(Some(&vault), "general")
            .expect("read")
            .value["theme"],
        "dark"
    );
}

#[test]
fn flat_local_keys_and_resets() {
    let w = world();
    let vault = w.open("v3");
    assert_eq!(
        w.service
            .get_local(Some(&vault), "tagSearches")
            .expect("get"),
        None
    );
    w.service
        .set_local(Some(&vault), "tagSearches", &json!([{"id": "t"}]))
        .expect("set");
    assert_eq!(
        w.service
            .get_local(Some(&vault), "tagSearches")
            .expect("get"),
        Some(json!([{"id": "t"}]))
    );
    w.service
        .write_group(
            Some(&vault),
            "keyboard",
            patch(json!({"overrides": {"a": "b"}})),
        )
        .expect("write");
    w.service
        .reset_group(Some(&vault), "keyboard")
        .expect("reset");
    assert_eq!(
        w.service
            .read_group(Some(&vault), "keyboard")
            .expect("read")
            .value["overrides"],
        json!({})
    );
}
