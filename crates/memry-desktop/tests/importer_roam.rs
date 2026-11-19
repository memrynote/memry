//! The Roam importer over graph exports written to a temp folder: the outline, Roam markup,
//! TODO/DONE checkboxes, block references, daily pages, slash titles, page times, and hostile
//! exports refused before anything is written.

use std::path::{Path, PathBuf};

use memry_desktop::import::roam::{
    MAX_MAPPED_BYTES, RoamImporter, quoted_bytes_scrubbed, scrub_markup,
};
use memry_desktop::import::{ImportContext, ImportError, ImportInput, ImportSummary, Importer};
use memry_test_kit::{assert_steps_at_most, on_small_stack, proptest_config};
use proptest::prelude::*;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::import_support::{RecordingSink, Timeline};

fn write_json(dir: &Path, name: &str, value: &Value) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
    path
}

fn run_with(
    paths: &[PathBuf],
    cancel: CancellationToken,
) -> (Result<(), ImportError>, Vec<Value>, ImportSummary) {
    let timeline = Timeline::default();
    let sink = RecordingSink::new(timeline.clone());
    let mut ctx = ImportContext::new("roam", cancel, Box::new(|_| {}));
    let input = ImportInput {
        source_paths: paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        options: None,
    };
    let result = RoamImporter.run(&input, &mut ctx, &sink);
    let writes = timeline.lock().unwrap().clone();
    (result, writes, ctx.summary())
}

fn run(paths: &[PathBuf]) -> (Result<(), ImportError>, Vec<Value>, ImportSummary) {
    run_with(paths, CancellationToken::new())
}

fn notes(writes: &[Value]) -> Vec<&Value> {
    writes.iter().filter(|w| w["op"] == "createNote").collect()
}

fn note<'a>(writes: &'a [Value], title: &str) -> &'a Value {
    notes(writes)
        .into_iter()
        .find(|n| n["title"] == title)
        .unwrap_or_else(|| panic!("no note titled {title}"))
}

/// Electron's fixture, `apps/desktop/src/main/import/roam/__fixtures__/graph.json`.
fn graph() -> Value {
    json!([
      {
        "title": "Project Plan", "uid": "page-project",
        "create-time": 1709596800000_i64, "edit-time": 1709683200000_i64,
        "children": [
          { "uid": "blk-overview", "string": "Overview", "heading": 1, "children": [
            { "uid": "blk-goals", "string": "Goals are __important__ and ^^urgent^^", "children": [
              { "uid": "blk-ship", "string": "{{[[TODO]]}} Ship the importer" },
              { "uid": "blk-done", "string": "{{[[DONE]]}} Write the parser" }
            ]}
          ]},
          { "uid": "blk-noise", "string": "Distraction {{[[POMO]]}} and a {{word-count}} widget" }
        ]
      },
      {
        "title": "Meeting Notes", "uid": "page-meeting",
        "children": [{ "uid": "blk-ref", "string": "Discussed: ((blk-goals))" }]
      },
      {
        "title": "January 1st, 2024", "uid": "01-01-2024",
        "children": [{ "uid": "blk-journal", "string": "First entry of the year" }]
      }
    ])
}

#[test]
fn roam_pages_become_nested_bullet_notes_under_roam() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_json(dir.path(), "graph.json", &graph());

    let (result, writes, summary) = run(&[path]);

    result.unwrap();
    assert_eq!(summary.imported, 3);
    assert!(summary.failed.is_empty());
    let project = note(&writes, "Project Plan");
    assert_eq!(project["folder"], "Roam");
    assert_eq!(project["id"], Value::Null);
    assert_eq!(
        project["content"],
        "- # Overview\n  - Goals are *important* and ==urgent==\n    - [ ] Ship the importer\n    - [x] Write the parser\n- Distraction  and a  widget"
    );
}

#[test]
fn roam_block_refs_resolve_to_a_wiki_link_and_the_quoted_text() {
    let dir = tempfile::tempdir().unwrap();
    let mut pages = graph();
    pages.as_array_mut().unwrap().push(json!({
        "title": "Refs",
        "children": [
            { "string": "embed {{embed: ((blk-goals))}} and {{[[embed]]: ((blk-ship))}}" },
            { "string": "unknown ((nope)) and empty ((blk-empty))" },
            { "uid": "blk-empty", "string": "  " },
            { "uid": "blk-nested", "string": "see ((blk-ref))" },
            { "string": "nested ((blk-nested))" }
        ]
    }));
    let path = write_json(dir.path(), "graph.json", &pages);

    let (result, writes, _) = run(&[path]);

    result.unwrap();
    assert_eq!(
        note(&writes, "Meeting Notes")["content"],
        "- Discussed: [[Project Plan]]: \"Goals are *important* and ==urgent==\""
    );
    assert_eq!(
        note(&writes, "Refs")["content"],
        "- embed [[Project Plan]]: \"Goals are *important* and ==urgent==\" and [[Project Plan]]: \"[ ] Ship the importer\"\n\
         - unknown nope and empty [[Refs]]\n\
         -\n\
         - see [[Meeting Notes]]: \"Discussed: ((blk-goals))\"\n\
         - nested [[Refs]]: \"see ((blk-ref))\""
    );
}

#[test]
fn roam_daily_pages_are_retitled_to_the_journal_date() {
    let dir = tempfile::tempdir().unwrap();
    let pages = json!([
        { "title": "January 1st, 2024", "uid": "x" },
        { "title": "Some log", "uid": "02-29-2024" },
        { "title": "  march 5, 2023 " },
        { "title": "February 30th, 2024", "uid": "02-30-2024" },
        { "title": "January 1st, 0024" },
        { "title": "December 31st, 2023", "uid": "05-05-2020" }
    ]);
    let path = write_json(dir.path(), "daily.json", &pages);

    let (result, writes, _) = run(&[path]);

    result.unwrap();
    let titles: Vec<&str> = notes(&writes)
        .iter()
        .map(|n| n["title"].as_str().unwrap())
        .collect();
    assert_eq!(
        titles,
        [
            "2024-01-01",
            "2024-02-29",
            "2023-03-05",
            "February 30th, 2024",
            "January 1st, 0024",
            "2023-12-31"
        ]
    );
    assert!(notes(&writes).iter().all(|n| n["folder"] == "Roam"));
}

#[test]
fn roam_slash_titles_become_nested_folders() {
    let dir = tempfile::tempdir().unwrap();
    let pages = json!([
        { "title": "Area/ Project / Leaf" },
        { "title": "/Lone/" },
        { "title": "   " }
    ]);
    let path = write_json(dir.path(), "slash.json", &pages);

    let (result, writes, _) = run(&[path]);

    result.unwrap();
    let all = notes(&writes);
    assert_eq!(all[0]["title"], "Leaf");
    assert_eq!(all[0]["folder"], "Roam/Area/Project");
    assert_eq!(all[1]["title"], "/Lone/");
    assert_eq!(all[1]["folder"], "Roam");
    assert_eq!(all[2]["title"], "   ");
}

#[test]
fn roam_page_times_become_iso_instants() {
    let dir = tempfile::tempdir().unwrap();
    let pages = json!([
        { "title": "Timed", "create-time": 1709596800000_i64, "edit-time": 1709683200999.9 },
        { "title": "Untimed", "create-time": "1709596800000", "edit-time": 9e15 }
    ]);
    let path = write_json(dir.path(), "times.json", &pages);

    let (result, writes, _) = run(&[path]);

    result.unwrap();
    let timed = note(&writes, "Timed");
    assert_eq!(timed["created"], "<birthtime>");
    assert_eq!(timed["modified"], "2024-03-06T00:00:00.999Z");
    let untimed = note(&writes, "Untimed");
    assert_eq!(untimed["created"], Value::Null);
    assert_eq!(untimed["modified"], Value::Null);
}

#[test]
fn a_file_that_is_not_a_roam_export_fails_and_the_others_import() {
    let dir = tempfile::tempdir().unwrap();
    let good = write_json(dir.path(), "good.json", &json!([{ "title": "Fine" }]));
    let object = write_json(dir.path(), "object.json", &json!({ "title": "x" }));
    let untitled = write_json(dir.path(), "untitled.json", &json!([{ "title": 5 }]));
    let garbage = dir.path().join("garbage.json");
    std::fs::write(&garbage, b"[{ not json").unwrap();

    let (result, writes, summary) = run(&[object, untitled, garbage, good]);

    result.unwrap();
    assert_eq!(notes(&writes).len(), 1);
    let errors: Vec<&str> = summary.failed.iter().map(|f| f.error.as_str()).collect();
    assert_eq!(
        errors,
        [
            "Not a Roam JSON export (expected an array of pages)",
            "Not a Roam JSON export (expected an array of pages)",
            "Invalid JSON"
        ]
    );
}

#[test]
fn an_oversized_roam_file_fails_before_it_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let big = dir.path().join("big.json");
    std::fs::File::create(&big)
        .unwrap()
        .set_len(memry_desktop::import::MAX_SOURCE_BYTES + 1)
        .unwrap();

    let (result, writes, summary) = run(&[big]);

    result.unwrap();
    assert!(writes.is_empty());
    assert_eq!(summary.failed.len(), 1);
    assert!(summary.failed[0].error.contains("larger than"));
}

#[test]
fn a_page_title_that_climbs_out_of_the_folder_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let pages = json!([
        { "title": "../../escape/Note" },
        { "title": "a/..\\../Note" },
        { "title": "Safe" }
    ]);
    let path = write_json(dir.path(), "climb.json", &pages);

    let (result, writes, summary) = run(&[path]);

    result.unwrap();
    let all = notes(&writes);
    assert_eq!(all.len(), 1);
    assert_eq!(all[0]["title"], "Safe");
    assert_eq!(summary.failed.len(), 2);
}

#[test]
fn a_malformed_block_refuses_the_run_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let good = write_json(dir.path(), "good.json", &json!([{ "title": "Fine" }]));
    for (name, pages) in [
        (
            "text.json",
            json!([{ "title": "B", "children": [{ "string": 5 }] }]),
        ),
        ("null.json", json!([{ "title": "B", "children": [null] }])),
        (
            "kids.json",
            json!([{ "title": "B", "children": { "a": 1 } }]),
        ),
        ("uid.json", json!([{ "title": "B", "uid": 7 }])),
    ] {
        let bad = write_json(dir.path(), name, &pages);
        let (result, writes, _) = run(&[good.clone(), bad]);
        assert!(result.is_err(), "{name} must fail the run");
        assert!(notes(&writes).is_empty(), "{name} wrote a note");
    }
}

#[test]
fn odd_block_shapes_import_as_javascript_reads_them() {
    let dir = tempfile::tempdir().unwrap();
    let pages = json!([{ "title": "Odd", "children": [
        { "string": "a", "heading": 9, "children": "xy" },
        { "string": "b", "heading": "2" },
        { "string": "c", "heading": [3] },
        { "string": "d", "heading": 0.5 },
        { "string": "e", "heading": true },
        { "string": "f", "heading": {} },
        { "string": null },
        42
    ]}]);
    let path = write_json(dir.path(), "odd.json", &pages);

    let (result, writes, _) = run(&[path]);

    result.unwrap();
    assert_eq!(
        note(&writes, "Odd")["content"],
        "- ###### a\n  -\n  -\n- ## b\n- ### c\n- d\n- # e\n- f\n-\n-"
    );
}

#[test]
fn a_cancelled_roam_import_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_json(dir.path(), "graph.json", &graph());
    let cancel = CancellationToken::new();
    cancel.cancel();

    let (result, writes, summary) = run_with(&[path], cancel);

    result.unwrap();
    assert!(notes(&writes).is_empty());
    assert_eq!(summary.imported, 0);
}

/// `depth` blocks, each the only child of the one before.
fn chain(depth: usize) -> String {
    let mut json = String::from(r#"[{"title":"Deep","children":"#);
    for _ in 0..depth {
        json.push_str(r#"[{"string":"x","children":"#);
    }
    json.push_str("null");
    for _ in 0..depth {
        json.push_str("}]");
    }
    json.push_str("}]");
    json
}

#[test]
fn a_deep_roam_outline_imports_on_a_small_stack() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("deep.json");
    std::fs::write(&path, chain(490)).unwrap();

    let writes = on_small_stack(move || {
        let (result, writes, _) = run(&[path]);
        result.unwrap();
        writes
    });

    let body = note(&writes, "Deep")["content"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(body.lines().count(), 490);
    assert!(body.ends_with(&format!("{}- x", "  ".repeat(489))));
}

#[test]
fn a_roam_export_nested_past_the_parser_limit_is_refused_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("deeper.json");
    std::fs::write(&path, chain(100_000)).unwrap();

    let (writes, summary) = on_small_stack(move || {
        let (result, writes, summary) = run(&[path]);
        result.unwrap();
        (writes, summary)
    });

    assert!(writes.is_empty());
    assert_eq!(summary.failed[0].error, "Invalid JSON");
}

#[test]
fn a_roam_export_that_expands_past_the_budget_is_refused_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    // One block of 1 MiB, referenced from enough blocks to exceed the budget.
    let refs = MAX_MAPPED_BYTES / (1024 * 1024) + 2;
    let mut children = vec![json!({ "uid": "big", "string": "y".repeat(1024 * 1024) })];
    children.extend((0..refs).map(|_| json!({ "string": "((big))" })));
    let path = write_json(
        dir.path(),
        "bomb.json",
        &json!([{ "title": "Fine" }, { "title": "Bomb", "children": children }]),
    );

    let (result, writes, _) = run(&[path]);

    assert!(result.is_err());
    assert!(notes(&writes).is_empty());
}

#[test]
fn a_referenced_block_is_scrubbed_once_however_often_it_is_referenced() {
    let dir = tempfile::tempdir().unwrap();
    let text = format!("{}x", " ".repeat(64 * 1024));
    let mut children = vec![json!({ "uid": "w", "string": text })];
    children.extend((0..2_000).map(|_| json!({ "string": "((w))" })));
    let path = write_json(
        dir.path(),
        "refs.json",
        &json!([{ "title": "P", "children": children }]),
    );

    assert_steps_at_most(
        "bytes scrubbed for quoted refs",
        quoted_bytes_scrubbed,
        text.len(),
        || {
            let (result, writes, _) = run(&[path]);
            result.unwrap();
            assert_eq!(notes(&writes).len(), 1);
        },
    );
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn scrubbing_never_grows_a_block(
        text in "(\\{\\{(\\[\\[)?(TODO|DONE|embed|POMO)(\\]\\])?\\}\\}|\\{\\{embed: ?\\(\\(u\\)\\)\\}\\}|__|\\^\\^|[a {}()\n])*",
    ) {
        prop_assert!(scrub_markup(&text).len() <= text.len());
    }
}
