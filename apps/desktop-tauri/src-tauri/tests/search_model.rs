//! The text model's settings actions through the IPC a renderer calls (Electron's
//! `settings/ai-settings.ts:124-171`, #3540): its status, load and reindex, and the progress
//! events they send, over the vault and fake model of `search_support`.

#[allow(dead_code, reason = "search.rs uses the rest")]
mod search_support;
#[allow(dead_code, reason = "only the open and invoke of the harness are used")]
mod support;

use std::sync::atomic::Ordering;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

use memry_desktop::ai::features;
use memry_desktop::embedding::projector::NoteEmbeddingProjector;
use memry_desktop::locale::LocaleService;
use memry_desktop::session::OpenSource;
use memry_desktop::settings::SettingsService;
use memry_tauri::events::AiEmbeddingProgressEvent;
use memry_tauri::ml_worker::pass_progress;
use search_support::{
    Fixture, Model, garden_near_everything, note_id, note_ids, opened, query, set_ai, until,
    with_model,
};
use serde_json::{Value, json};
use tauri::{Listener, Manager};
use tauri_specta::Event;

fn reindex(f: &Fixture) -> Value {
    f.mocked.invoke("ai_reindex_embeddings", json!({})).unwrap()
}

/// The app's embedding lane over `model`, on the vault reopened so its runtime runs the lane.
/// Opened with AI off, so the open's reconcile embeds nothing.
fn with_lane(f: &Fixture, model: Arc<Model>) {
    let service = with_model(f, model);
    let session = f.mocked.session();
    let settings = f.mocked.webview.state::<SettingsService>().inner().clone();
    session.register_projector(NoteEmbeddingProjector::new(
        &session,
        service,
        Arc::new(move |vault| features::read(&settings, Some(vault)).is_ok_and(|ai| ai.enabled)),
        Arc::new(|| false),
        pass_progress(f.mocked.webview.app_handle()),
    ));
    set_ai(f, false);
    session.close();
    session.open(&f.mocked.vault, OpenSource::Select).unwrap();
    until("the reopened vault answered a search", || {
        query(f, "tomatoes")["totalCount"] == 1
    });
}

#[test]
fn a_reindex_embeds_every_note_and_the_query_finds_them_by_meaning() {
    let f = opened();
    let model = Arc::new(Model::default());
    with_lane(&f, model.clone());
    let mut notes = vec![note_id(&f, "roadmap"), note_id(&f, "tomatoes")];
    notes.sort();

    assert_eq!(
        reindex(&f),
        json!({ "success": false, "computed": 0, "skipped": 0, "error": "AI is disabled" })
    );
    assert_eq!(note_ids(&query(&f, "vegetables")), Vec::<String>::new());

    set_ai(&f, true);
    assert_eq!(
        reindex(&f),
        json!({ "success": true, "computed": 2, "skipped": 0 })
    );
    let mut found = note_ids(&query(&f, "vegetables"));
    found.sort();
    assert_eq!(found, notes);
}

#[test]
fn a_reindex_with_no_embedding_lane_says_the_model_did_not_load() {
    let f = opened();
    assert_eq!(
        reindex(&f),
        json!({
            "success": false, "computed": 0, "skipped": 0,
            "error": "Failed to load embedding model"
        })
    );
    f.mocked.session().close();
    assert_eq!(reindex(&f)["error"], "No vault is open");
}

/// Every [`AiEmbeddingProgressEvent`] the app sends from here on.
fn progress_heard(f: &Fixture) -> Arc<Mutex<Vec<Value>>> {
    let heard = Arc::new(Mutex::new(Vec::new()));
    let sink = heard.clone();
    f.mocked
        .webview
        .app_handle()
        .listen_any(AiEmbeddingProgressEvent::NAME, move |event| {
            sink.lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        });
    heard
}

fn model_status(f: &Fixture) -> Value {
    f.mocked.invoke("ai_get_model_status", json!({})).unwrap()
}

fn load_model(f: &Fixture) -> Value {
    f.mocked.invoke("ai_load_model", json!({})).unwrap()
}

#[test]
fn the_model_status_counts_the_open_vaults_notes_with_a_vector() {
    let f = opened();
    assert_eq!(
        model_status(&f),
        json!({
            "name": "EmbeddingGemma 2", "dimension": 256, "loaded": false, "loading": false,
            "error": "Failed to load embedding model", "embeddingCount": 0
        })
    );

    garden_near_everything(&f);
    let service = with_model(&f, Arc::new(Model::default()));
    assert!(service.load());
    assert_eq!(
        model_status(&f),
        json!({
            "name": "EmbeddingGemma 2", "dimension": 256, "loaded": true, "loading": false,
            "error": null, "embeddingCount": 1
        })
    );

    f.mocked.session().close();
    assert_eq!(model_status(&f)["embeddingCount"], 0);
}

#[test]
fn a_model_load_answers_as_electron_and_tells_the_windows_its_progress() {
    let f = opened();
    assert_eq!(
        load_model(&f),
        json!({ "success": false, "error": "Failed to load model" })
    );

    let heard = progress_heard(&f);
    let model = Arc::new(Model::default());
    with_model(&f, model.clone());
    assert_eq!(load_model(&f), json!({ "success": true }));
    assert_eq!(
        load_model(&f),
        json!({ "success": true, "message": "Model already loaded" })
    );
    assert_eq!(model.loads.load(Ordering::SeqCst), 1);
    assert_eq!(
        *heard.lock().unwrap(),
        [
            json!({ "phase": "loading", "progress": 0, "status": "Initializing model..." }),
            json!({ "phase": "ready", "progress": 100, "status": "Model ready" }),
        ]
    );
}

#[test]
fn a_failed_load_answers_the_models_reason_and_a_load_in_flight_is_refused() {
    let f = opened();
    let (release, hold) = channel();
    let service = with_model(
        &f,
        Arc::new(Model {
            refuse: Some("offline"),
            hold: Mutex::new(Some(hold)),
            ..Model::default()
        }),
    );
    let loading = {
        let service = service.clone();
        std::thread::spawn(move || service.load())
    };
    until("the load started", || service.status().loading);
    f.mocked.webview.state::<Arc<LocaleService>>().switch("de");
    assert_eq!(
        load_model(&f),
        json!({ "success": false, "error": "Das Modell wird bereits geladen" })
    );
    release.send(()).unwrap();
    assert!(!loading.join().unwrap());

    // The back-off of the failed load is cleared: the user's load is attempted at once.
    assert_eq!(
        load_model(&f),
        json!({ "success": false, "error": "offline" })
    );
}

#[test]
fn a_reindex_tells_the_windows_how_far_the_pass_got() {
    let f = opened();
    with_lane(&f, Arc::new(Model::default()));
    set_ai(&f, true);
    let heard = progress_heard(&f);

    assert_eq!(
        reindex(&f),
        json!({ "success": true, "computed": 2, "skipped": 0 })
    );
    let passes: Vec<Value> = heard
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.get("current").is_some())
        .cloned()
        .collect();
    assert_eq!(
        passes,
        [
            json!({ "phase": "embedding", "current": 0, "total": 2 }),
            json!({ "phase": "embedding", "current": 2, "total": 2 }),
            json!({ "phase": "complete", "current": 2, "total": 2 }),
        ]
    );
}
