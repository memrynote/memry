//! The AI switches on a real vault (`settings/ai-settings.ts`, `getAISettings` and
//! `writeAISettings`): the rows Electron writes read back the same, and a write stores the text
//! Electron's `getSetting` reads.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::ai::features::{
    self, AiSettings, AiSettingsPatch, IMAGE_EMBEDDINGS_KEY, SUMMARIZE_AGENT_KEY,
    SUMMARIZE_LONG_NOTES_KEY,
};
use memry_desktop::fold::agent::FoldAgentChoice;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, OpenVault, Session};
use memry_desktop::settings::{SettingsError, SettingsService};

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

struct World {
    _dir: tempfile::TempDir,
    _session: Session,
    vault: OpenVault,
    settings: SettingsService,
}

fn world() -> World {
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
    World {
        _dir: dir,
        _session: session,
        vault,
        settings: SettingsService::new(Arc::new(DeviceKeys::default()), config),
    }
}

impl World {
    fn stored(&self, key: &str) -> Option<String> {
        self.settings
            .get_local_text(Some(&self.vault), key)
            .expect("read")
    }

    /// A row as Electron's `setSetting` left it: bare text.
    fn seed(&self, key: &str, text: &str) {
        self.settings
            .set_local_text(Some(&self.vault), key, text)
            .expect("seed");
    }

    fn read(&self) -> AiSettings {
        features::read(&self.settings, Some(&self.vault)).expect("read")
    }
}

#[test]
fn nothing_stored_and_no_vault_read_as_electrons_defaults() {
    let world = world();
    let defaults = AiSettings {
        enabled: true,
        image_embeddings: true,
        summarize_long_notes: false,
        summarize_agent: FoldAgentChoice::Auto,
    };
    assert_eq!(world.read(), defaults);
    assert_eq!(
        features::read(&world.settings, None).expect("read"),
        defaults
    );
}

#[test]
fn electrons_rows_read_back_including_the_bare_agent_choice() {
    let world = world();
    world.seed("ai.enabled", "false");
    world.seed(IMAGE_EMBEDDINGS_KEY, "false");
    world.seed(SUMMARIZE_LONG_NOTES_KEY, "true");
    world.seed(SUMMARIZE_AGENT_KEY, "codex_cli");
    assert_eq!(
        world.read(),
        AiSettings {
            enabled: false,
            image_embeddings: false,
            summarize_long_notes: true,
            summarize_agent: FoldAgentChoice::CodexCli,
        }
    );

    // Only `true` turns summaries on, only `false` turns AI off, and a newer build's agent
    // reads as auto.
    world.seed("ai.enabled", "0");
    world.seed(SUMMARIZE_LONG_NOTES_KEY, "1");
    world.seed(SUMMARIZE_AGENT_KEY, "gemini_cli");
    let read = world.read();
    assert!(read.enabled);
    assert!(!read.summarize_long_notes);
    assert_eq!(read.summarize_agent, FoldAgentChoice::Auto);
}

#[test]
fn a_write_stores_electrons_text_for_the_given_fields_only() {
    let world = world();
    let patch = AiSettingsPatch {
        summarize_long_notes: Some(true),
        summarize_agent: Some(FoldAgentChoice::LocalOpenaiCompatible),
        ..AiSettingsPatch::default()
    };
    features::write(&world.settings, Some(&world.vault), &patch).expect("write");

    assert_eq!(
        world.stored(SUMMARIZE_LONG_NOTES_KEY).as_deref(),
        Some("true")
    );
    assert_eq!(
        world.stored(SUMMARIZE_AGENT_KEY).as_deref(),
        Some("local_openai_compatible")
    );
    assert_eq!(world.stored("ai.enabled"), None);
    assert_eq!(world.stored(IMAGE_EMBEDDINGS_KEY), None);
    assert_eq!(patch.fields(), ["summarizeLongNotes", "summarizeAgent"]);
    assert!(patch.touches_fold());

    let off = AiSettingsPatch {
        enabled: Some(false),
        image_embeddings: Some(false),
        ..AiSettingsPatch::default()
    };
    features::write(&world.settings, Some(&world.vault), &off).expect("write");
    assert_eq!(world.stored("ai.enabled").as_deref(), Some("false"));
    assert_eq!(world.stored(IMAGE_EMBEDDINGS_KEY).as_deref(), Some("false"));
    let read = world.read();
    assert!(!read.enabled && !read.image_embeddings && read.summarize_long_notes);
    assert!(
        !AiSettingsPatch {
            image_embeddings: Some(true),
            ..AiSettingsPatch::default()
        }
        .touches_fold(),
        "image search alone leaves the fold alone"
    );
}

#[test]
fn a_write_with_no_vault_open_is_refused() {
    let world = world();
    let patch = AiSettingsPatch {
        enabled: Some(false),
        ..AiSettingsPatch::default()
    };
    assert!(matches!(
        features::write(&world.settings, None, &patch),
        Err(SettingsError::NoVault)
    ));
}
