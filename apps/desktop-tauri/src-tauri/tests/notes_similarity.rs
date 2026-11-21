//! `notes_get_similar`, `notes_get_tag_suggestions` and `notes_cluster` through the IPC a renderer
//! calls, over a real vault, its SQLite databases and stored `vec_note_similar` rows (Electron's
//! `notes:get-similar`, `notes:get-tag-suggestions` and `notes:cluster`,
//! `ipc/notes-handlers.ts:512-530`, `similarity/index.ts`).

#[allow(dead_code, reason = "only the open and invoke of the harness are used")]
mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use memry_core::storage::vec::EMBEDDING_DIMENSION;
use memry_desktop::ai::features::{self, AiSettingsPatch};
use memry_desktop::registry::AppConfig;
use memry_desktop::settings::SettingsService;
use serde_json::{Value, json};
use support::{MemoryStore, Mocked, WAIT};
use tauri::Manager;
use tauri::test::MockRuntime;
use tauri_specta::collect_commands;

const ALPHA: &str = "# Alpha\n\nThe quarterly roadmap lives here.\n";
const BETA: &str = "---\ntags: [garden]\n---\n# Beta\n\nTomatoes and basil.\n";
const DELTA: &str = "---\ntags: [garden]\n---\n# Delta\n\nSee [[alpha]] for zucchini.\n";
const GAMMA: &str = "# Gamma\n\nInvoices for March.\n";

struct Fixture {
    mocked: Mocked,
    ids: Ids,
    _app_dir: tempfile::TempDir,
}

struct Ids {
    alpha: String,
    beta: String,
    gamma: String,
    delta: String,
}

/// A unit vector of `x` along the first axis and `y` along `axis`.
fn vector(x: f32, axis: usize, y: f32) -> Vec<f32> {
    let mut v = vec![0.0; EMBEDDING_DIMENSION];
    v[0] = x;
    v[axis] += y;
    let norm = v.iter().map(|c| c * c).sum::<f32>().sqrt();
    v.iter().map(|c| c / norm).collect()
}

fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !done() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn note_id(mocked: &Mocked, word: &str) -> Option<String> {
    let response = mocked
        .invoke("search_query", json!({ "input": { "text": word } }))
        .unwrap();
    let ids: Vec<String> = response["groups"]
        .as_array()?
        .iter()
        .filter(|group| group["type"] == "note")
        .flat_map(|group| group["results"].as_array().unwrap().iter())
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect();
    (ids.len() == 1).then(|| ids[0].clone())
}

/// Alpha, Beta and Delta near each other (Delta links to Alpha, Beta and Delta are tagged
/// `garden`), Gamma unrelated to all three.
fn opened() -> Fixture {
    let commands = tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::notes_similarity::notes_get_similar::<MockRuntime>,
            memry_tauri::commands::notes_similarity::notes_get_tag_suggestions::<MockRuntime>,
            memry_tauri::commands::notes_similarity::notes_cluster::<MockRuntime>,
            memry_tauri::commands::search::search_query::<MockRuntime>,
        ]);
    let mocked = Mocked::open(
        &[
            ("alpha.md", ALPHA),
            ("beta.md", BETA),
            ("gamma.md", GAMMA),
            ("delta.md", DELTA),
        ],
        commands,
    );
    let app_dir = tempfile::tempdir().unwrap();
    let config = Arc::new(AppConfig::load(app_dir.path().join("memry-config.json")));
    mocked.webview.app_handle().manage(SettingsService::new(
        Arc::new(MemoryStore::default()),
        config,
    ));
    until("every note reached the search index", || {
        ["roadmap", "tomatoes", "invoices", "zucchini"]
            .iter()
            .all(|word| note_id(&mocked, word).is_some())
    });
    let id = |word| note_id(&mocked, word).unwrap();
    let ids = Ids {
        alpha: id("roadmap"),
        beta: id("tomatoes"),
        gamma: id("invoices"),
        delta: id("zucchini"),
    };
    let search = mocked.session().current().unwrap().search;
    let indexed = || {
        let incoming = search.incoming_links(&ids.alpha);
        let tags = search.tags_of_notes(vec![ids.beta.clone(), ids.delta.clone()]);
        let done = incoming
            .as_ref()
            .is_ok_and(|incoming| incoming.sources.iter().any(|s| s.source_id == ids.delta))
            && tags.as_ref().is_ok_and(|tags| tags.len() == 2);
        (done, format!("{incoming:?} {tags:?}"))
    };
    let deadline = Instant::now() + WAIT;
    loop {
        let (done, state) = indexed();
        if done {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Delta's link to Alpha and the tags are indexed: {state}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    for (id, stored) in [
        (&ids.alpha, vector(1.0, 1, 0.0)),
        (&ids.beta, vector(1.0, 1, 0.3)),
        (&ids.delta, vector(1.0, 2, 0.1)),
        (&ids.gamma, vector(0.0, 3, 1.0)),
    ] {
        let note = search.embeddable_note(id).unwrap().unwrap();
        search
            .store_note_embeddings(&note, Some("hash"), vec![stored.clone()], stored)
            .unwrap();
    }
    Fixture {
        mocked,
        ids,
        _app_dir: app_dir,
    }
}

fn invoke(f: &Fixture, cmd: &str, args: Value) -> Result<Value, Value> {
    f.mocked.invoke(cmd, args)
}

fn set_ai(f: &Fixture, enabled: bool) {
    let settings = f.mocked.webview.state::<SettingsService>();
    let vault = f.mocked.session().current();
    let patch = AiSettingsPatch {
        enabled: Some(enabled),
        ..AiSettingsPatch::default()
    };
    features::write(&settings, vault.as_ref(), &patch).unwrap();
}

#[test]
fn similar_notes_leave_out_linked_and_unrelated_notes_in_the_contract_shape() {
    let f = opened();
    let answer = invoke(&f, "notes_get_similar", json!({ "noteId": f.ids.alpha })).unwrap();
    assert_eq!(answer["status"], "ready");
    let notes = answer["notes"].as_array().unwrap();
    // Delta links to Alpha and Gamma sits under the 0.5 floor.
    assert_eq!(notes.len(), 1, "{answer}");
    let beta = &notes[0];
    assert_eq!(beta["id"], f.ids.beta.as_str());
    assert_eq!(beta["title"], "beta");
    assert_eq!(beta["path"], "beta.md");
    assert_eq!(beta["emoji"], Value::Null);
    assert!(
        beta["snippet"].as_str().unwrap().contains("Tomatoes"),
        "{beta}"
    );
    // calibrateSimilarity(cos) = (cos - 0.6) / 0.4, cos = 1 / sqrt(1.09).
    let expected = (1.0 / 1.09_f64.sqrt() - 0.6) / 0.4;
    assert!((beta["similarity"].as_f64().unwrap() - expected).abs() < 1e-4);

    let none = invoke(&f, "notes_get_similar", json!({ "noteId": "no-such-note" })).unwrap();
    assert_eq!(none, json!({ "status": "no-embedding", "notes": [] }));
}

#[test]
fn a_relation_or_a_portal_keeps_a_note_out_of_the_similar_list() {
    let f = opened();
    let alpha = f.ids.alpha.clone();
    std::fs::write(
        f.mocked.vault.join("relater.md"),
        format!("---\nrelated: [\"memry://note/{alpha}\"]\n---\n# Relater\n\nOrchards.\n"),
    )
    .unwrap();
    std::fs::write(
        f.mocked.vault.join("host.md"),
        format!(
            "# Host\n\nVineyards.\n\n```memry-portal\n{{\"v\":1,\"note\":\"{alpha}\",\"blocks\":[\"abc1\"]}}\n```\n"
        ),
    )
    .unwrap();
    until("both new notes reached the search index", || {
        note_id(&f.mocked, "orchards").is_some() && note_id(&f.mocked, "vineyards").is_some()
    });
    let relater = note_id(&f.mocked, "orchards").unwrap();
    let host = note_id(&f.mocked, "vineyards").unwrap();
    let search = f.mocked.session().current().unwrap().search;
    // `property_refs` is written with the property rows, in one transaction.
    until("the relation is indexed", || {
        search.note_properties(&relater).is_ok_and(|rows| {
            rows.iter()
                .any(|row| row.name == "related" && row.type_name == "relation")
        })
    });
    until("the portal is indexed", || {
        search.block_refs(&alpha).is_ok_and(|refs| !refs.is_empty())
    });
    for (id, stored) in [
        (&relater, vector(1.0, 4, 0.1)),
        (&host, vector(1.0, 5, 0.1)),
    ] {
        let note = search.embeddable_note(id).unwrap().unwrap();
        search
            .store_note_embeddings(&note, Some("hash"), vec![stored.clone()], stored)
            .unwrap();
    }

    let ids = |note: &str| -> Vec<String> {
        let answer = invoke(&f, "notes_get_similar", json!({ "noteId": note })).unwrap();
        answer["notes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["id"].as_str().unwrap().to_owned())
            .collect()
    };
    // Both sit nearer Alpha than Beta does; the relation naming Alpha and the portal of Alpha
    // keep them out.
    assert_eq!(ids(&alpha), vec![f.ids.beta.clone()]);
    // The relation counts from its own side too.
    let from_relater = ids(&relater);
    assert!(!from_relater.contains(&alpha), "{from_relater:?}");
    assert!(from_relater.contains(&f.ids.beta), "{from_relater:?}");
}

#[test]
fn a_limit_outside_one_to_twenty_is_refused() {
    let f = opened();
    for limit in [0, 21] {
        let error = invoke(
            &f,
            "notes_get_similar",
            json!({ "noteId": f.ids.alpha, "limit": limit }),
        )
        .unwrap_err();
        assert_eq!(error["code"], "invalid", "limit {limit}");
    }
    let one = invoke(
        &f,
        "notes_get_similar",
        json!({ "noteId": f.ids.alpha, "limit": 1 }),
    )
    .unwrap();
    assert_eq!(one["notes"].as_array().unwrap().len(), 1);
}

#[test]
fn tag_suggestions_name_the_tag_two_neighbours_share() {
    let f = opened();
    let answer = invoke(
        &f,
        "notes_get_tag_suggestions",
        json!({ "noteId": f.ids.alpha }),
    )
    .unwrap();
    assert_eq!(answer["status"], "ready");
    let tags = answer["tags"].as_array().unwrap();
    assert_eq!(tags.len(), 1, "{answer}");
    assert_eq!(tags[0]["tag"], "garden");
    assert_eq!(tags[0]["support"], 2);
    assert!(tags[0]["confidence"].as_f64().unwrap() >= 0.3);

    // Beta carries the tag already; only Delta agrees with it, which is too few.
    let beta = invoke(
        &f,
        "notes_get_tag_suggestions",
        json!({ "noteId": f.ids.beta }),
    )
    .unwrap();
    assert_eq!(beta, json!({ "status": "ready", "tags": [] }));
}

#[test]
fn grouping_proposes_the_near_notes_and_names_the_rest() {
    let f = opened();
    let ids = &f.ids;
    let answer = invoke(
        &f,
        "notes_cluster",
        json!({ "noteIds": [ids.alpha, ids.beta, ids.gamma, ids.delta, "gone", ids.alpha] }),
    )
    .unwrap();
    assert_eq!(answer["status"], "ready");
    assert_eq!(answer["ungrouped"], json!([ids.gamma]));
    assert_eq!(answer["missing"], json!(["gone"]));
    let groups = answer["groups"].as_array().unwrap();
    assert_eq!(groups.len(), 1, "{answer}");
    let mut members: Vec<&str> = groups[0]["noteIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    let titles: Vec<&str> = groups[0]["titles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap())
        .collect();
    assert_eq!(titles.len(), 3);
    members.sort_unstable();
    let mut expected = vec![ids.alpha.as_str(), ids.beta.as_str(), ids.delta.as_str()];
    expected.sort_unstable();
    assert_eq!(members, expected);
    assert_eq!(groups[0]["suggestedName"], "garden");

    let too_many: Vec<String> = (0..301).map(|n| format!("n{n}")).collect();
    let error = invoke(&f, "notes_cluster", json!({ "noteIds": too_many })).unwrap_err();
    assert_eq!(error["code"], "invalid");
}

#[test]
fn every_answer_is_disabled_while_ai_is_off() {
    let f = opened();
    set_ai(&f, false);
    let id = json!({ "noteId": f.ids.alpha });
    assert_eq!(
        invoke(&f, "notes_get_similar", id.clone()).unwrap(),
        json!({ "status": "disabled", "notes": [] })
    );
    assert_eq!(
        invoke(&f, "notes_get_tag_suggestions", id).unwrap(),
        json!({ "status": "disabled", "tags": [] })
    );
    assert_eq!(
        invoke(&f, "notes_cluster", json!({ "noteIds": [f.ids.alpha] })).unwrap(),
        json!({ "status": "disabled", "groups": [], "ungrouped": [], "missing": [] })
    );
}

/// The ids of every result `word` finds, of any group.
fn result_ids(f: &Fixture, word: &str) -> Vec<String> {
    let response = invoke(f, "search_query", json!({ "input": { "text": word } })).unwrap();
    response["groups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|group| group["results"].as_array().unwrap().iter())
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

fn store_vector(f: &Fixture, id: &str, stored: Vec<f32>) {
    let search = f.mocked.session().current().unwrap().search;
    let note = search.embeddable_note(id).unwrap().unwrap();
    search
        .store_note_embeddings(&note, Some("hash"), vec![stored.clone()], stored)
        .unwrap();
}

fn similar(f: &Fixture, note: &str) -> Value {
    invoke(f, "notes_get_similar", json!({ "noteId": note })).unwrap()
}

#[test]
fn a_deleted_note_leaves_the_similar_list() {
    let f = opened();
    assert_eq!(
        similar(&f, &f.ids.alpha)["notes"][0]["id"],
        f.ids.beta.as_str()
    );

    std::fs::remove_file(f.mocked.vault.join("beta.md")).unwrap();
    until("the deleted note left the search index", || {
        note_id(&f.mocked, "tomatoes").is_none()
    });
    assert_eq!(
        similar(&f, &f.ids.alpha),
        json!({ "status": "ready", "notes": [] })
    );
}

#[test]
fn a_journal_day_is_a_similar_note_titled_with_its_date() {
    let f = opened();
    std::fs::create_dir_all(f.mocked.vault.join("journal")).unwrap();
    std::fs::write(
        f.mocked.vault.join("journal/2025-03-03.md"),
        "Planned the quarterly roadmap with apricots.\n",
    )
    .unwrap();
    until("the journal day reached the search index", || {
        result_ids(&f, "apricots").len() == 1
    });
    let day = result_ids(&f, "apricots").remove(0);
    store_vector(&f, &day, vector(1.0, 6, 0.1));

    let answer = similar(&f, &f.ids.alpha);
    let found = answer["notes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|note| note["id"] == day.as_str())
        .unwrap_or_else(|| panic!("the day is similar: {answer}"))
        .clone();
    assert_eq!(found["title"], "2025-03-03");
    assert_eq!(found["path"], "journal/2025-03-03.md");
}
