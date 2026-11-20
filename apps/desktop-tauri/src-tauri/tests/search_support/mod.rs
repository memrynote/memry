//! The vault, text model and helpers `search.rs` and `search_model.rs` share: a mock app over two
//! notes with the search and model commands, and a fake text model.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::storage::vec::EMBEDDING_DIMENSION;
use memry_desktop::ai::features::{self, AiSettingsPatch};
use memry_desktop::embedding::download::Abort;
use memry_desktop::embedding::service::{
    EmbedError, EmbeddingService, Engine, ModelLoader, ModelProgress, Timing,
};
use memry_desktop::registry::AppConfig;
use memry_desktop::settings::SettingsService;
use memry_tauri::ml_worker::model_progress;
use serde_json::{Value, json};
use tauri::Manager;
use tauri::test::MockRuntime;
use tauri_specta::collect_commands;

use crate::support::{MemoryStore, Mocked, WAIT};

pub const ALPHA: &str = "# Alpha\n\nThe quarterly roadmap lives here.\n";
pub const GARDEN: &str = "# Garden\n\nTomatoes and basil, planted in May.\n";

pub struct Fixture {
    pub mocked: Mocked,
    _app_dir: tempfile::TempDir,
}

pub fn opened() -> Fixture {
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::ai::ai_get_model_status::<MockRuntime>,
            memry_tauri::commands::ai::ai_load_model::<MockRuntime>,
            memry_tauri::commands::ai::ai_reindex_embeddings::<MockRuntime>,
            memry_tauri::commands::search::search_query::<MockRuntime>,
            memry_tauri::commands::search::search_quick::<MockRuntime>,
            memry_tauri::commands::search::search_get_stats::<MockRuntime>,
            memry_tauri::commands::search::search_get_reasons::<MockRuntime>,
            memry_tauri::commands::search::search_add_reason::<MockRuntime>,
            memry_tauri::commands::search::search_clear_reasons::<MockRuntime>,
        ]);
    let mocked = Mocked::open(&[("alpha.md", ALPHA), ("garden.md", GARDEN)], commands);
    let app_dir = tempfile::tempdir().unwrap();
    let config = Arc::new(AppConfig::load(app_dir.path().join("memry-config.json")));
    mocked.webview.app_handle().manage(SettingsService::new(
        Arc::new(MemoryStore::default()),
        config,
    ));
    let f = Fixture {
        mocked,
        _app_dir: app_dir,
    };
    // The search rows land after the open walk's `Indexed`, from the note index's pass.
    until("both notes reached the search index", || {
        ["roadmap", "tomatoes"]
            .iter()
            .all(|word| query(&f, word)["totalCount"] == 1)
    });
    f
}

pub fn query(f: &Fixture, text: &str) -> Value {
    f.mocked
        .invoke("search_query", json!({ "input": { "text": text } }))
        .unwrap()
}

/// The ids of the note group's results, best first.
pub fn note_ids(response: &Value) -> Vec<String> {
    response["groups"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|group| group["type"] == "note")
        .flat_map(|group| group["results"].as_array().unwrap().iter())
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

pub fn set_ai(f: &Fixture, enabled: bool) {
    let settings = f.mocked.webview.state::<SettingsService>();
    let vault = f.mocked.session().current();
    let patch = AiSettingsPatch {
        enabled: Some(enabled),
        ..AiSettingsPatch::default()
    };
    features::write(&settings, vault.as_ref(), &patch).unwrap();
}

pub fn note_id(f: &Fixture, word: &str) -> String {
    let ids = note_ids(&query(f, word));
    assert_eq!(ids.len(), 1, "{word} names one note");
    ids[0].clone()
}

pub fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !done() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub fn unit() -> Vec<f32> {
    let mut vector = vec![0.0; EMBEDDING_DIMENSION];
    vector[0] = 1.0;
    vector
}

/// A text model that embeds every text to [`unit`], or fails each embed with `broken`. Its load
/// fails with `refuse`, and waits for `hold` when one is set.
#[derive(Default)]
pub struct Model {
    pub loads: AtomicUsize,
    pub embeds: Arc<AtomicUsize>,
    pub broken: bool,
    pub refuse: Option<&'static str>,
    pub hold: Mutex<Option<Receiver<()>>>,
}

struct Loaded {
    embeds: Arc<AtomicUsize>,
    broken: bool,
}

impl Engine for Loaded {
    fn embed_text(&mut self, _: &str) -> Result<Vec<f32>, EmbedError> {
        self.embeds.fetch_add(1, Ordering::SeqCst);
        if self.broken {
            Err(EmbedError::Failed("inference failed".to_owned()))
        } else {
            Ok(unit())
        }
    }
}

impl ModelLoader for Model {
    fn load(
        &self,
        _: &Abort,
        _: &(dyn Fn(ModelProgress) + Sync),
    ) -> Result<Box<dyn Engine>, String> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        if let Some(hold) = self.hold.lock().unwrap().take() {
            hold.recv().unwrap();
        }
        if let Some(reason) = self.refuse {
            return Err(reason.to_owned());
        }
        Ok(Box::new(Loaded {
            embeds: self.embeds.clone(),
            broken: self.broken,
        }))
    }
}

pub fn with_model(f: &Fixture, model: Arc<Model>) -> Arc<EmbeddingService> {
    let app = f.mocked.webview.app_handle();
    let service = EmbeddingService::new(model, model_progress(app), Timing::default());
    f.mocked.webview.app_handle().manage(service.clone());
    service
}

/// Stores [`unit`] as the garden note's vectors, through the store the embedding lane writes
/// with, and answers its id.
pub fn garden_near_everything(f: &Fixture) -> String {
    let garden = note_id(f, "tomatoes");
    let search = f.mocked.session().current().unwrap().search;
    let note = search.embeddable_note(&garden).unwrap().unwrap();
    search
        .store_note_embeddings(&note, Some("hash"), vec![unit()], unit())
        .unwrap();
    garden
}
