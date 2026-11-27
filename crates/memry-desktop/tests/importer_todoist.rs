//! The Todoist importer over CSV exports written to a temp folder: Electron's task mapping
//! (project per file, hierarchy, priority, due dates, comments, sections), the preview, files and
//! tasks the sink refuses, and exports refused before any of their tasks is created.

use std::path::{Path, PathBuf};

use chrono::NaiveDate;
use memry_desktop::import::csv_lex::steps;
use memry_desktop::import::todoist::TodoistImporter;
use memry_desktop::import::{
    FailedItem, ImportContext, ImportInput, ImportSummary, Importer, MAX_PLANNED_BYTES,
};
use memry_test_kit::{assert_steps_at_most, on_small_stack, proptest_config};
use proptest::prelude::*;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::import_support::{RecordingSink, Timeline};

const HEADER: &str = "TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,DATE,DATE_LANG,DEADLINE";
const TOO_MANY: &str = "The picked Todoist files hold more tasks than one import can take. \
                        Import fewer files at a time, or split the export into smaller files.";

/// A Wednesday.
fn today() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 1, 14).unwrap()
}

fn importer() -> TodoistImporter {
    TodoistImporter {
        today: Some(today()),
        ..TodoistImporter::default()
    }
}

fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, text).unwrap();
    path
}

fn export(dir: &Path, name: &str, rows: &[&str]) -> PathBuf {
    write(dir, name, &format!("{HEADER}\n{}", rows.join("\n")))
}

fn input(paths: &[PathBuf]) -> ImportInput {
    ImportInput {
        source_paths: paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        options: None,
    }
}

struct Run {
    writes: Vec<Value>,
    summary: ImportSummary,
}

impl Run {
    fn tasks(&self) -> Vec<&Value> {
        self.writes
            .iter()
            .filter(|w| w["op"] == "createTask")
            .collect()
    }

    fn titles(&self) -> Vec<&str> {
        self.tasks()
            .iter()
            .map(|t| t["title"].as_str().unwrap())
            .collect()
    }
}

fn run_with(
    importer: &TodoistImporter,
    paths: &[PathBuf],
    sink: impl FnOnce(&mut RecordingSink),
    cancel: CancellationToken,
) -> Run {
    let timeline = Timeline::default();
    let mut recording = RecordingSink::new(timeline.clone());
    sink(&mut recording);
    let mut ctx = ImportContext::new("todoist", cancel, Box::new(|_| {}));
    importer.run(&input(paths), &mut ctx, &recording).unwrap();
    let writes = timeline.lock().unwrap().clone();
    Run {
        writes,
        summary: ctx.summary(),
    }
}

fn run(paths: &[PathBuf]) -> Run {
    run_with(&importer(), paths, |_| {}, CancellationToken::new())
}

fn preview(importer: &TodoistImporter, paths: &[PathBuf]) -> Value {
    let preview = importer
        .preview(&input(paths), &CancellationToken::new())
        .unwrap();
    serde_json::to_value(preview).unwrap()
}

fn failed(item: &str, error: &str) -> FailedItem {
    FailedItem {
        item: item.to_owned(),
        error: error.to_owned(),
    }
}

/// The due date `DATE` gives a task.
fn due(date: &str) -> Value {
    let dir = tempfile::tempdir().unwrap();
    let path = export(dir.path(), "d.csv", &[&format!("task,T,,1,1,\"{date}\",,")]);
    run(&[path]).tasks()[0]["dueDate"].clone()
}

#[test]
fn a_file_becomes_a_project_and_its_rows_tasks_with_parents_before_children() {
    let dir = tempfile::tempdir().unwrap();
    let path = export(
        dir.path(),
        "Home.csv",
        &[
            "meta,view_style=list,,,,,,",
            "task,Plan,  the week  ,4,1,2026-02-01 14:30,en,",
            "task,Book,,3,2,,,",
            "task,Seat,,2,3,tomorrow,,",
            "task,Pack,,1,2,,,",
            "task,Water,,1,1,,,2026-03-01",
        ],
    );
    let run = run(&[path]);
    assert_eq!(
        run.writes[0],
        json!({ "op": "createProject", "name": "Home" })
    );
    let task = |title: &str, parent: Value, priority: u8, date: Value, time: Value| {
        json!({
            "op": "createTask", "projectId": "project-1", "parentId": parent, "title": title,
            "description": null, "priority": priority, "dueDate": date, "dueTime": time,
        })
    };
    let mut want = [
        task("Plan", Value::Null, 4, json!("2026-02-01"), json!("14:30")),
        task("Book", json!("task-1"), 3, Value::Null, Value::Null),
        task("Seat", json!("task-2"), 2, json!("2026-01-15"), Value::Null),
        task("Pack", json!("task-1"), 0, Value::Null, Value::Null),
        task("Water", Value::Null, 0, json!("2026-03-01"), Value::Null),
    ];
    want[0]["description"] = json!("the week");
    for (position, want) in want.iter_mut().enumerate() {
        want["position"] = json!(position);
    }
    assert_eq!(run.tasks(), want.iter().collect::<Vec<_>>());
    assert_eq!(run.summary.imported, 5);
}

#[test]
fn comments_append_to_the_task_above_and_an_attachment_becomes_a_link() {
    let dir = tempfile::tempdir().unwrap();
    let token = r#""[[file {""file_name"":""a.pdf"",""file_url"":""https://x/a.pdf""}]]""#;
    let path = export(
        dir.path(),
        "c.csv",
        &[
            "note,Before any task,,,,,,",
            "task,T,desc,1,1,,,",
            "note,  first  ,,,,,,",
            &format!("note,{token},,,,,,"),
            "note,\"[[file {\"\"image\"\":\"\"https://x/i.png\"\"}]]\",,,,,,",
            "note,   ,,,,,,",
        ],
    );
    let run = run(std::slice::from_ref(&path));
    assert_eq!(
        run.tasks()[0]["description"],
        "desc\n\nfirst\n\n[a.pdf](https://x/a.pdf)\n\n[attachment](https://x/i.png)"
    );
    let preview = preview(&importer(), &[path]);
    let counts = &preview["groups"][0]["counts"];
    assert_eq!(
        counts[3],
        json!({ "labelKey": "import.stats.comments", "value": 3 })
    );
    assert_eq!(
        counts[4],
        json!({ "labelKey": "import.stats.skipped", "value": 1 })
    );
}

#[test]
fn a_section_is_flattened_and_ends_the_hierarchy() {
    let dir = tempfile::tempdir().unwrap();
    let path = export(
        dir.path(),
        "s.csv",
        &[
            "task,A,,1,1,,,",
            "section, Errands ,,,,,,",
            "note,lost,,,,,,",
            "task,B,,1,2,,,",
        ],
    );
    let run = run(std::slice::from_ref(&path));
    assert_eq!(run.tasks()[1]["parentId"], Value::Null);
    let warnings = &preview(&importer(), &[path])["groups"][0]["warnings"];
    assert_eq!(
        warnings,
        &json!([
            { "code": "todoist.sectionFlattened", "message": "Section \"Errands\" flattened",
              "params": { "section": "Errands" } },
            { "code": "todoist.orphanComment", "message": "Comment with no preceding task skipped" },
            { "code": "todoist.subtaskNoParent",
              "message": "Sub-task \"B\" has no parent at indent 1; imported top-level",
              "params": { "title": "B", "indent": 1 } },
        ])
    );
}

#[test]
fn relative_dates_count_from_the_day_of_the_import() {
    assert_eq!(due("today"), "2026-01-14");
    assert_eq!(due("Yesterday"), "2026-01-13");
    assert_eq!(due("wed"), "2026-01-14");
    assert_eq!(due("Monday"), "2026-01-19");
    assert_eq!(due("in 2 weeks"), "2026-01-28");
    assert_eq!(
        due("Jan 5"),
        "2027-01-05",
        "a passed day rolls to next year"
    );
    assert_eq!(due("20 June, 2030"), "2030-06-20");
    assert_eq!(due("Feb 31"), "2026-02-31", "kept as Electron wrote it");
    assert_eq!(due("every monday"), Value::Null);
}

#[test]
fn a_month_past_its_last_day_rolls_over_as_js_dates_do() {
    let importer = TodoistImporter {
        today: NaiveDate::from_ymd_opt(2026, 1, 31),
        ..TodoistImporter::default()
    };
    let dir = tempfile::tempdir().unwrap();
    let path = export(dir.path(), "m.csv", &["task,T,,1,1,in 1 month,,"]);
    let run = run_with(&importer, &[path], |_| {}, CancellationToken::new());
    assert_eq!(run.tasks()[0]["dueDate"], "2026-03-03");
}

#[test]
fn a_relative_date_past_the_calendar_is_not_parsed() {
    assert_eq!(due("in 99999999999 days"), Value::Null);
    assert_eq!(due("in 999999999 months"), Value::Null);
    assert_eq!(due("in 99999999999999999999 months"), Value::Null);
    assert_eq!(due("constructor"), Value::Null);
}

#[test]
fn an_indent_past_v8_array_length_fails_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let bad = export(dir.path(), "bad.csv", &["task,A,,1,4294967295,,,"]);
    let deep = export(dir.path(), "deep.csv", &["task,A,,1,4294967294,,,"]);
    let run = run(&[bad, deep]);
    assert_eq!(run.titles(), ["A"]);
    assert_eq!(
        run.summary.failed,
        [failed("bad.csv", "Invalid array length")]
    );
}

#[test]
fn the_project_is_named_for_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let upper = export(dir.path(), "Loud.CSV", &["task,A,,1,1,,,"]);
    let blank = export(dir.path(), " .csv", &["task,B,,1,1,,,"]);
    let run = run(&[upper, blank]);
    let projects: Vec<&Value> = run
        .writes
        .iter()
        .filter(|w| w["op"] == "createProject")
        .map(|w| &w["name"])
        .collect();
    assert_eq!(projects, ["Loud", "Imported Todoist Project"]);
}

#[test]
fn a_file_that_is_not_a_todoist_export_fails_and_the_others_import() {
    let dir = tempfile::tempdir().unwrap();
    let other = write(dir.path(), "other.csv", "title,url\nA,https://a.com\n");
    let good = export(dir.path(), "good.csv", &["task,A,,1,1,,,"]);
    let run = run(&[other.clone(), good]);
    assert_eq!(run.titles(), ["A"]);
    let error = "Not a Todoist CSV: missing TYPE header row";
    assert_eq!(run.summary.failed, [failed("other.csv", error)]);
    let group = &preview(&importer(), &[other])["groups"][0];
    assert_eq!(
        group["error"],
        json!({ "code": "todoist.headerNotFound", "message": error })
    );
}

#[test]
fn a_project_the_sink_refuses_fails_its_file_alone() {
    let dir = tempfile::tempdir().unwrap();
    let first = export(dir.path(), "first.csv", &["task,A,,1,1,,,"]);
    let second = export(dir.path(), "second.csv", &["task,B,,1,1,,,"]);
    let run = run_with(
        &importer(),
        &[first, second],
        |sink| sink.fail_project = Some("first".to_owned()),
        CancellationToken::new(),
    );
    assert_eq!(run.titles(), ["B"]);
    assert_eq!(run.summary.failed, [failed("first.csv", "project boom")]);
}

#[test]
fn a_task_the_sink_refuses_stops_its_file_and_keeps_the_tasks_before_it() {
    let dir = tempfile::tempdir().unwrap();
    let first = export(
        dir.path(),
        "first.csv",
        &["task,A,,1,1,,,", "task,Bad,,1,1,,,", "task,C,,1,1,,,"],
    );
    let second = export(dir.path(), "second.csv", &["task,D,,1,1,,,"]);
    let run = run_with(
        &importer(),
        &[first, second],
        |sink| sink.fail_project_task = Some("Bad".to_owned()),
        CancellationToken::new(),
    );
    assert_eq!(run.titles(), ["A", "D"]);
    assert_eq!(run.summary.imported, 2);
    assert_eq!(
        run.summary.failed,
        [failed("first.csv", "Task creation failed")]
    );
}

fn tiny_rows(dir: &Path, name: &str, rows: usize) -> PathBuf {
    write(
        dir,
        name,
        &format!("TYPE,CONTENT,PRIORITY\n{}", "task,a,1\n".repeat(rows)),
    )
}

#[test]
fn an_export_past_the_budget_fails_and_creates_none_of_its_tasks() {
    let dir = tempfile::tempdir().unwrap();
    let small = export(dir.path(), "small.csv", &["task,A,,1,1,,,"]);
    let big = tiny_rows(dir.path(), "big.csv", 1000);
    let importer = TodoistImporter {
        budget: 48 * 1024,
        ..importer()
    };
    let run = run_with(&importer, &[small, big], |_| {}, CancellationToken::new());
    assert_eq!(run.titles(), ["A"]);
    assert_eq!(run.summary.failed, [failed("big.csv", TOO_MANY)]);
    assert_eq!(
        run.writes
            .iter()
            .filter(|w| w["op"] == "createProject")
            .count(),
        1
    );
}

#[test]
fn the_budget_spans_every_picked_file() {
    let dir = tempfile::tempdir().unwrap();
    let first = tiny_rows(dir.path(), "first.csv", 60);
    let second = tiny_rows(dir.path(), "second.csv", 60);
    let importer = TodoistImporter {
        budget: 48 * 1024,
        ..importer()
    };
    let alone = run_with(
        &importer,
        std::slice::from_ref(&second),
        |_| {},
        CancellationToken::new(),
    );
    assert_eq!(alone.summary.imported, 60, "one file fits the budget");
    let both = run_with(
        &importer,
        &[first, second],
        |_| {},
        CancellationToken::new(),
    );
    assert_eq!(both.summary.imported, 60);
    assert_eq!(both.summary.failed, [failed("second.csv", TOO_MANY)]);
}

#[test]
fn comments_are_charged_to_the_budget() {
    let dir = tempfile::tempdir().unwrap();
    let comment = "c".repeat(1000);
    let rows: Vec<String> = std::iter::once("task,A,,1,1,,,".to_owned())
        .chain((0..100).map(|_| format!("note,{comment},,,,,,")))
        .collect();
    let rows: Vec<&str> = rows.iter().map(String::as_str).collect();
    let path = export(dir.path(), "notes.csv", &rows);
    let importer = TodoistImporter {
        budget: 48 * 1024,
        ..importer()
    };
    let run = run_with(&importer, &[path], |_| {}, CancellationToken::new());
    assert_eq!(run.summary.failed, [failed("notes.csv", TOO_MANY)]);
}

#[test]
fn preview_refuses_an_export_past_the_budget() {
    let dir = tempfile::tempdir().unwrap();
    let big = tiny_rows(dir.path(), "big.csv", 1000);
    let importer = TodoistImporter {
        budget: 48 * 1024,
        ..importer()
    };
    let group = &preview(&importer, &[big])["groups"][0];
    assert_eq!(group["error"], json!({ "message": TOO_MANY }));
}

#[test]
fn the_importer_runs_with_the_default_budget_and_todays_date() {
    let importer = TodoistImporter::default();
    assert_eq!(importer.budget, MAX_PLANNED_BYTES);
    assert_eq!(importer.today, None);
}

#[test]
fn a_cancelled_import_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = export(dir.path(), "a.csv", &["task,A,,1,1,,,"]);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let run = run_with(&importer(), &[path], |_| {}, cancel);
    assert!(run.writes.is_empty());
}

#[test]
fn a_cancel_after_the_first_task_creates_no_more() {
    let dir = tempfile::tempdir().unwrap();
    let path = export(
        dir.path(),
        "a.csv",
        &["task,A,,1,1,,,", "task,B,,1,1,,,", "task,C,,1,1,,,"],
    );
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let timeline = Timeline::default();
    let sink = RecordingSink::new(timeline.clone());
    let mut ctx = ImportContext::new(
        "todoist",
        cancel,
        Box::new(move |progress| {
            if progress.imported == 1 {
                trigger.cancel();
            }
        }),
    );
    importer().run(&input(&[path]), &mut ctx, &sink).unwrap();
    let created = timeline
        .lock()
        .unwrap()
        .iter()
        .filter(|w| w["op"] == "createTask")
        .count();
    assert_eq!(created, 1);
    assert_eq!(ctx.summary().imported, 1);
}

#[test]
fn a_deeply_nested_attachment_token_stays_text_on_a_small_stack() {
    let nested = format!(
        "[[file {{\"\"file_url\"\":{}1{}}}]]",
        "[".repeat(100_000),
        "]".repeat(100_000)
    );
    let shallow = format!(
        "[[file {{\"\"file_url\"\":{}1{}}}]]",
        "[".repeat(100),
        "]".repeat(100)
    );
    let descriptions = on_small_stack(move || {
        let dir = tempfile::tempdir().unwrap();
        let path = export(
            dir.path(),
            "deep.csv",
            &[
                "task,A,,1,1,,,",
                &format!("note,\"{nested}\",,,,,,"),
                "task,B,,1,1,,,",
                &format!("note,\"{shallow}\",,,,,,"),
            ],
        );
        run(&[path])
            .tasks()
            .iter()
            .map(|t| t["description"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    });
    assert!(descriptions[0].starts_with("[[file {"));
    assert_eq!(descriptions[1], "[attachment](1)");
}

#[test]
fn reading_takes_steps_linear_in_the_export() {
    let dir = tempfile::tempdir().unwrap();
    let n = 50_000;
    let ramp: String = (1..=n).map(|i| format!("task,a,,1,{i}\n")).collect();
    let inputs = [
        format!("TYPE\n{}", "\"".repeat(4 * n)),
        format!("TYPE,{}\ntask", "CONTENT,".repeat(n)),
        format!("TYPE,CONTENT,DATE\ntask,a,\"{}\"", "jun 1 ".repeat(n)),
        format!(
            "TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT\n{ramp}{}",
            "task,b,,1,999999\n".repeat(n)
        ),
        format!("TYPE,CONTENT\ntask,a\n{}", "note,c\n".repeat(n)),
    ];
    for (at, text) in inputs.iter().enumerate() {
        let path = write(dir.path(), &format!("steps{at}.csv"), text);
        assert_steps_at_most(&format!("input {at}"), steps, 3 * text.len(), || {
            run(&[path]);
        });
    }
}

fn quoted(cell: &str) -> String {
    format!("\"{}\"", cell.replace('"', "\"\""))
}

proptest! {
    #![proptest_config(proptest_config(64))]

    #[test]
    fn quoted_titles_read_back_as_written(
        titles in prop::collection::vec("[a-z ,\"\r\n]{1,6}", 0..12),
        crlf in any::<bool>(),
    ) {
        let dir = tempfile::tempdir().unwrap();
        let end = if crlf { "\r\n" } else { "\n" };
        let mut text = format!("TYPE,CONTENT{end}");
        for title in &titles {
            text.push_str(&format!("task,{}{end}", quoted(title)));
        }
        let run = run(&[write(dir.path(), "p.csv", &text)]);
        let want: Vec<String> = titles
            .iter()
            .map(|title| match title.trim() {
                "" => "(untitled)".to_owned(),
                title => title.to_owned(),
            })
            .collect();
        prop_assert_eq!(run.titles(), want);
    }
}
