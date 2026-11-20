//! The palette's `search_*` commands through the IPC a renderer calls, over a real vault and its
//! SQLite databases (Electron's `ipc/search-handlers.ts` and `search/semantic.ts`, #3540): the
//! contract shapes, the refused inputs, the counts, the recently opened results, the query's
//! semantic leg with a fake text model and raw `vec_notes` rows, and the `search_performed` event.
//! The text model's settings actions are in `search_model.rs`.

#[allow(dead_code, reason = "search_model.rs uses the rest")]
mod search_support;
#[allow(dead_code, reason = "only the open and invoke of the harness are used")]
mod support;

use std::sync::Arc;
use std::sync::atomic::Ordering;

use memry_desktop::seams::transport::NativeTransport;
use memry_desktop::telemetry::Service;
use memry_desktop::telemetry::service::{Context, Sender};
use search_support::{
    Model, garden_near_everything, note_id, note_ids, opened, query, set_ai, until, with_model,
};
use serde_json::{Value, json};
use tauri::Manager;

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
    set_ai(&f, false);

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

/// A telemetry service that queues every event, managed by the app as the shell's is.
fn with_telemetry(f: &search_support::Fixture) -> Arc<Service> {
    let context = Context {
        install_id: "i".into(),
        session_id: "s".into(),
        app_version: "1.0.0".into(),
        build_channel: "production".into(),
        platform: "linux".into(),
        arch: "x64".into(),
        locale: "en".into(),
        timezone_offset_minutes: 0,
    };
    let sender = Sender::new("http://127.0.0.1:1/x", NativeTransport::loopback());
    let dir = f.mocked.vault.parent().unwrap().join("telemetry");
    std::fs::create_dir_all(&dir).unwrap();
    let telemetry = Arc::new(Service::start(&dir, context, sender, true));
    f.mocked.webview.app_handle().manage(telemetry.clone());
    telemetry
}

/// `search_performed` (`search-handlers.ts:79-99,122-142`): one per search, with its source,
/// duration and result count, and never the query's text.
#[test]
fn each_search_reports_its_source_and_counts_and_never_the_query() {
    let f = opened();
    let telemetry = with_telemetry(&f);
    query(&f, "roadmap");
    f.mocked
        .invoke("search_quick", json!({ "text": "tomatoes" }))
        .unwrap();

    let events: Vec<_> = telemetry
        .queued()
        .into_iter()
        .filter(|event| event.name == "search_performed")
        .collect();
    assert_eq!(events.len(), 2);
    for (event, source) in events.iter().zip(["global", "quick"]) {
        assert_eq!(
            (event.surface.as_str(), event.action.as_str()),
            ("search", "queried")
        );
        assert_eq!(event.source.as_deref(), Some(source));
        assert_eq!(event.result.as_deref(), Some("success"));
        let metrics = event.metrics.as_ref().expect("metrics");
        assert_eq!(metrics.result_count, Some(1.0));
        assert!(metrics.duration_ms.is_some_and(|ms| ms >= 0.0));
        assert_eq!(
            event
                .dimensions
                .as_ref()
                .and_then(|d| d.get("result_bucket")),
            Some(&"one_to_five".to_owned())
        );
        let sent = serde_json::to_string(event).unwrap();
        for word in ["roadmap", "tomatoes"] {
            assert!(!sent.contains(word), "{source} carries the query: {sent}");
        }
    }
}
