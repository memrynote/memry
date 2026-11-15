//! The palette's `search_*` commands through the IPC a renderer calls, over a real vault and its
//! SQLite databases (Electron's `ipc/search-handlers.ts` and `search/semantic.ts`, #3540): the
//! contract shapes, the refused inputs, the counts, the recently opened results, and the query's
//! semantic leg with a fake text model and raw `vec_notes` rows.

#[allow(dead_code, reason = "only the open and invoke of the harness are used")]
mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use memry_core::storage::vec::{EMBEDDING_DIMENSION, VecTable, to_blob};
use memry_desktop::ai::features::{self, AiSettingsPatch};
use memry_desktop::embedding::download::Abort;
use memry_desktop::embedding::service::{
    EmbeddingService, Engine, ModelLoader, ModelProgress, Timing,
};
use memry_desktop::registry::AppConfig;
use memry_desktop::settings::SettingsService;
use serde_json::{Value, json};
use support::{MemoryStore, Mocked, WAIT};
use tauri::Manager;
use tauri::test::MockRuntime;
use tauri_specta::collect_commands;

const ALPHA: &str = "# Alpha\n\nThe quarterly roadmap lives here.\n";
const GARDEN: &str = "# Garden\n\nTomatoes and basil, planted in May.\n";

struct Fixture {
    mocked: Mocked,
    _app_dir: tempfile::TempDir,
}

fn opened() -> Fixture {
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(collect_commands![
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

fn query(f: &Fixture, text: &str) -> Value {
    f.mocked
        .invoke("search_query", json!({ "input": { "text": text } }))
        .unwrap()
}

/// The ids of the note group's results, best first.
fn note_ids(response: &Value) -> Vec<String> {
    response["groups"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|group| group["type"] == "note")
        .flat_map(|group| group["results"].as_array().unwrap().iter())
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

fn note_id(f: &Fixture, word: &str) -> String {
    let ids = note_ids(&query(f, word));
    assert_eq!(ids.len(), 1, "{word} names one note");
    ids[0].clone()
}

fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !done() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_query_answers_the_note_group_in_the_contract_shape() {
    let f = opened();
    let response = query(&f, "roadmap");
    assert_eq!(response["totalCount"], 1);
    assert!(response["queryTimeMs"].is_number());
    let item = &response["groups"][0]["results"][0];
    assert_eq!(response["groups"][0]["type"], "note");
    assert_eq!(item["type"], "note");
    assert_eq!(item["title"], "alpha");
    assert!(
        item["snippet"]
            .as_str()
            .unwrap()
            .contains("<mark>roadmap</mark>"),
        "{item}"
    );
    assert!(
        item["modifiedAt"].as_str().unwrap().ends_with('Z'),
        "{item}"
    );
    assert_eq!(item["metadata"]["type"], "note");
    assert_eq!(item["metadata"]["path"], "alpha.md");

    let quick = f
        .mocked
        .invoke("search_quick", json!({ "text": "tomatoes" }))
        .unwrap();
    assert_eq!(quick["results"][0]["title"], "garden");
    let none = f
        .mocked
        .invoke(
            "search_quick",
            json!({ "text": "tomatoes", "noteFileTypes": ["pdf"] }),
        )
        .unwrap();
    assert_eq!(none["results"], json!([]));
}

#[test]
fn inputs_the_schema_refuses_are_refused_by_field() {
    let f = opened();
    let refused = |cmd: &str, args: Value| f.mocked.invoke(cmd, args).unwrap_err();
    let error = refused(
        "search_query",
        json!({ "input": { "text": "x", "limit": 0 } }),
    );
    assert_eq!(
        (error["kind"].as_str(), error["message"].as_str()),
        (Some("invalid"), Some("invalid limit"))
    );
    let long = "a".repeat(501);
    let error = refused("search_query", json!({ "input": { "text": long } }));
    assert_eq!(error["message"], "invalid text");
    let error = refused(
        "search_query",
        json!({ "input": { "text": "x", "dateRange": { "from": "yesterday", "to": "2026-01-01T00:00:00.000Z" } } }),
    );
    assert_eq!(error["message"], "invalid dateRange");
    let error = refused("search_quick", json!({ "text": "x", "noteFileTypes": [] }));
    assert_eq!(error["message"], "invalid noteFileTypes");
    let error = refused(
        "search_add_reason",
        json!({ "input": { "itemId": "", "itemType": "note", "itemTitle": "t", "searchQuery": "q" } }),
    );
    assert_eq!(error["message"], "invalid itemId");
}

#[test]
fn stats_count_the_live_notes() {
    let f = opened();
    let stats = f.mocked.invoke("search_get_stats", json!({})).unwrap();
    assert_eq!(stats["totalNotes"], 2);
    assert_eq!(stats["totalJournals"], 0);
    assert_eq!(stats["lastIndexedAt"], Value::Null);
}

#[test]
fn opened_results_are_listed_newest_first_and_cleared() {
    let f = opened();
    let alpha = note_id(&f, "roadmap");
    let garden = note_id(&f, "tomatoes");
    let add = |id: &str, title: &str, icon: Value| {
        f.mocked
            .invoke(
                "search_add_reason",
                json!({ "input": {
                    "itemId": id, "itemType": "note", "itemTitle": title,
                    "itemIcon": icon, "searchQuery": "q"
                } }),
            )
            .unwrap()
    };
    let added = add(&alpha, "alpha", json!("🌱"));
    assert_eq!(added["id"], format!("note:{alpha}"));
    // The icon is the note's own emoji as the recents store reads it, not the caller's.
    assert_eq!(added["itemIcon"], Value::Null);
    assert!(added["visitedAt"].as_str().unwrap().ends_with('Z'));
    add(&garden, "garden", Value::Null);

    let reasons = f.mocked.invoke("search_get_reasons", json!({})).unwrap();
    let ids: Vec<&str> = reasons
        .as_array()
        .unwrap()
        .iter()
        .map(|reason| reason["itemId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [garden.as_str(), alpha.as_str()]);

    f.mocked.invoke("search_clear_reasons", json!({})).unwrap();
    let reasons = f.mocked.invoke("search_get_reasons", json!({})).unwrap();
    assert_eq!(reasons, json!([]));
}

#[test]
fn with_no_vault_open_reads_answer_empty_and_writes_say_so() {
    let f = opened();
    f.mocked.session().close();
    let response = query(&f, "roadmap");
    assert_eq!(response["groups"], json!([]));
    assert_eq!(response["totalCount"], 0);
    let quick = f
        .mocked
        .invoke("search_quick", json!({ "text": "roadmap" }))
        .unwrap();
    assert_eq!(quick["results"], json!([]));
    let stats = f.mocked.invoke("search_get_stats", json!({})).unwrap();
    assert_eq!(stats["totalNotes"], 0);
    assert_eq!(
        f.mocked.invoke("search_get_reasons", json!({})).unwrap(),
        json!([])
    );
    let error = f
        .mocked
        .invoke(
            "search_add_reason",
            json!({ "input": { "itemId": "n", "itemType": "note", "itemTitle": "t", "searchQuery": "q" } }),
        )
        .unwrap_err();
    assert_eq!(error["code"], "no_vault_open");
    let error = f
        .mocked
        .invoke("search_clear_reasons", json!({}))
        .unwrap_err();
    assert_eq!(error["code"], "no_vault_open");
}

/// The unit vector every text embeds to, so a stored copy is the nearest note.
fn unit() -> Vec<f32> {
    let mut vector = vec![0.0; EMBEDDING_DIMENSION];
    vector[0] = 1.0;
    vector
}

/// A text model that embeds every text to [`unit`], or fails each embed with `broken`.
#[derive(Default)]
struct Model {
    loads: AtomicUsize,
    embeds: Arc<AtomicUsize>,
    broken: bool,
}

struct Loaded {
    embeds: Arc<AtomicUsize>,
    broken: bool,
}

impl Engine for Loaded {
    fn embed_text(&mut self, _: &str) -> Result<Vec<f32>, String> {
        self.embeds.fetch_add(1, Ordering::SeqCst);
        if self.broken {
            Err("inference failed".to_owned())
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
        Ok(Box::new(Loaded {
            embeds: self.embeds.clone(),
            broken: self.broken,
        }))
    }
}

fn with_model(f: &Fixture, model: Arc<Model>) -> Arc<EmbeddingService> {
    let service = EmbeddingService::new(model, Arc::new(|_| {}), Timing::default());
    f.mocked.webview.app_handle().manage(service.clone());
    service
}

/// Stores [`unit`] as the garden note's vector and answers its id.
fn garden_near_everything(f: &Fixture) -> String {
    let garden = note_id(f, "tomatoes");
    let id = garden.clone();
    f.mocked
        .session()
        .current()
        .unwrap()
        .search
        .index_handle()
        .call_blocking(move |index| {
            index
                .execute(
                    &format!(
                        "INSERT INTO {}(note_id, embedding) VALUES (?1, ?2)",
                        VecTable::Notes.name()
                    ),
                    (id, to_blob(&unit())),
                )
                .map_err(|error| memry_core::api::errors::StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .unwrap();
    garden
}

#[test]
fn a_cold_model_starts_loading_and_the_next_search_fuses_the_nearest_note() {
    let f = opened();
    let garden = garden_near_everything(&f);
    let model = Arc::new(Model::default());
    let service = with_model(&f, model.clone());

    // No text matches "vegetables": the first search answers from the index and starts the load.
    assert_eq!(note_ids(&query(&f, "vegetables")), Vec::<String>::new());
    until("the search started the model load", || {
        service.status().loaded
    });
    assert_eq!(model.loads.load(Ordering::SeqCst), 1);

    assert_eq!(
        note_ids(&query(&f, "vegetables")),
        std::slice::from_ref(&garden)
    );
    let quick = f
        .mocked
        .invoke("search_quick", json!({ "text": "vegetables" }))
        .unwrap();
    assert_eq!(quick["results"][0]["id"], garden.as_str());
}

#[test]
fn ai_off_answers_from_the_index_without_embedding() {
    let f = opened();
    garden_near_everything(&f);
    let model = Arc::new(Model::default());
    let service = with_model(&f, model.clone());
    assert!(service.load());
    let settings = f.mocked.webview.state::<SettingsService>();
    let vault = f.mocked.session().current();
    let off = AiSettingsPatch {
        enabled: Some(false),
        ..AiSettingsPatch::default()
    };
    features::write(&settings, vault.as_ref(), &off).unwrap();

    assert_eq!(note_ids(&query(&f, "vegetables")), Vec::<String>::new());
    assert_eq!(model.embeds.load(Ordering::SeqCst), 0);
}

#[test]
fn a_failed_embed_answers_from_the_index() {
    let f = opened();
    garden_near_everything(&f);
    let model = Arc::new(Model {
        broken: true,
        ..Model::default()
    });
    let service = with_model(&f, model.clone());
    assert!(service.load());

    assert_eq!(note_ids(&query(&f, "vegetables")), Vec::<String>::new());
    assert_eq!(note_ids(&query(&f, "tomatoes")).len(), 1);
    assert!(model.embeds.load(Ordering::SeqCst) >= 1);
}

#[test]
fn with_no_model_the_query_answers_from_the_index() {
    let f = opened();
    garden_near_everything(&f);
    assert_eq!(note_ids(&query(&f, "vegetables")), Vec::<String>::new());
    assert_eq!(note_ids(&query(&f, "basil")).len(), 1);
}
