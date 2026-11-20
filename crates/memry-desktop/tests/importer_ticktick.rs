//! The TickTick importer over backup CSVs written to a temp folder: Electron's `parse-csv`,
//! `map-rows`, `priority`, `rrule`, `apply-plan` and importer tests, the sink's refusals, the
//! plan budget, cancel, and hostile exports. Dates and reminders are in
//! `importer_ticktick_dates.rs`.

use std::path::{Path, PathBuf};

use jiff::tz::TimeZone;
use memry_desktop::import::csv_lex::steps;
use memry_desktop::import::ticktick::TickTickImporter;
use memry_desktop::import::{
    FailedItem, ImportContext, ImportInput, ImportSummary, Importer, MAX_PLANNED_BYTES,
};
use memry_test_kit::{assert_steps_at_most, proptest_config};
use proptest::prelude::*;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::import_support::{RecordingSink, Timeline};

const COLUMNS: [&str; 25] = [
    "Folder Name",
    "List Name",
    "Title",
    "Kind",
    "Tags",
    "Content",
    "Is Check list",
    "Start Date",
    "Due Date",
    "Reminder",
    "Repeat",
    "Priority",
    "Status",
    "Created Time",
    "Completed Time",
    "Order",
    "Timezone",
    "Is All Day",
    "Is Floating",
    "Column Name",
    "Column Order",
    "View Mode",
    "taskId",
    "parentId",
    "projectKind",
];
const PREAMBLE: &str = "\u{FEFF}\"Date: 2026-06-15+0000\"\n\"Version: 7.2\"\n\"Status: \n0 Normal\n1 Completed\n2 Archived\"\n";
pub(crate) const NOW: &str = "2026-06-15T00:00:00.000Z";
const TOO_MANY: &str = "The picked TickTick files hold more tasks than one import can take. \
                        Import fewer files at a time, or split the export into smaller files.";

fn quote(cell: &str) -> String {
    format!("\"{}\"", cell.replace('"', "\"\""))
}

/// The Electron tests' `row(overrides)` as a CSV line.
pub(crate) fn row(fields: &[(&str, &str)]) -> String {
    let defaults = [
        ("List Name", "Inbox"),
        ("Title", "Task"),
        ("Kind", "TEXT"),
        ("Is Check list", "N"),
        ("Priority", "0"),
        ("Status", "0"),
        ("Order", "0"),
        ("Timezone", "UTC"),
        ("Is All Day", "false"),
        ("Is Floating", "false"),
        ("View Mode", "list"),
        ("projectKind", "TASK"),
    ];
    COLUMNS
        .iter()
        .map(|column| {
            fn pick<'a>(set: &[(&str, &'a str)], column: &str) -> Option<&'a str> {
                set.iter().find(|(c, _)| *c == column).map(|f| f.1)
            }
            quote(
                pick(fields, column)
                    .or_else(|| pick(&defaults, column))
                    .unwrap_or(""),
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

pub(crate) fn backup(rows: &[String]) -> String {
    let header: Vec<String> = COLUMNS.iter().map(|c| quote(c)).collect();
    format!("{PREAMBLE}{}\n{}\n", header.join(","), rows.join("\n"))
}

pub(crate) fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, text).unwrap();
    path
}

pub(crate) fn now_ms() -> f64 {
    chrono::DateTime::parse_from_rfc3339(NOW)
        .unwrap()
        .timestamp_millis() as f64
}

pub(crate) fn importer() -> TickTickImporter {
    TickTickImporter {
        now: Some(now_ms()),
        local: Some(TimeZone::UTC),
        ..TickTickImporter::default()
    }
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

pub(crate) struct Run {
    pub writes: Vec<Value>,
    pub summary: ImportSummary,
}

impl Run {
    pub(crate) fn ops(&self, op: &str) -> Vec<&Value> {
        self.writes.iter().filter(|w| w["op"] == op).collect()
    }
}

pub(crate) fn run_with(
    importer: &TickTickImporter,
    paths: &[PathBuf],
    sink: impl FnOnce(&mut RecordingSink),
    cancel: CancellationToken,
) -> Run {
    let timeline = Timeline::default();
    let mut recording = RecordingSink::new(timeline.clone());
    sink(&mut recording);
    let mut ctx = ImportContext::new("ticktick", cancel, Box::new(|_| {}));
    importer.run(&input(paths), &mut ctx, &recording).unwrap();
    let writes = timeline.lock().unwrap().clone();
    Run {
        writes,
        summary: ctx.summary(),
    }
}

/// Runs one backup of `rows`.
pub(crate) fn run_rows(rows: &[String]) -> Run {
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "TickTick.csv", &backup(rows));
    run_with(&importer(), &[path], |_| {}, CancellationToken::new())
}

pub(crate) fn preview(importer: &TickTickImporter, paths: &[PathBuf]) -> Value {
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

fn default_statuses() -> Value {
    json!([
        { "name": "To Do", "color": "#6b7280", "type": "todo", "order": 0 },
        { "name": "In Progress", "color": "#F59E0B", "type": "in_progress", "order": 1 },
        { "name": "Done", "color": "#10b981", "type": "done", "order": 2 },
    ])
}

#[test]
fn a_backup_skips_its_preamble_and_maps_a_row() {
    let run = run_rows(&[row(&[
        ("Title", "Buy milk"),
        ("Tags", "home, errands"),
        ("Content", "note body"),
        ("Due Date", "2020-05-07T08:00:00+0000"),
        ("Reminder", "-PT1440M"),
        ("Repeat", "FREQ=YEARLY;INTERVAL=1"),
        ("Priority", "5"),
        ("Status", "2"),
        ("Created Time", "2020-04-21T16:04:14+0000"),
        ("Completed Time", "2020-04-22T10:00:00+0000"),
        ("Order", "-1099511627776"),
        ("Timezone", "Europe/Istanbul"),
        ("taskId", "1"),
    ])]);
    assert_eq!(
        run.writes,
        [
            json!({
                "op": "createTask", "projectId": "inbox", "title": "Buy milk",
                "description": "note body", "priority": 3, "statusId": "inbox-done",
                "parentId": null, "position": 0, "startDate": null, "dueDate": "2020-05-07",
                "dueTime": "11:00", "tags": ["home", "errands"],
                "repeatConfig": {
                    "frequency": "yearly", "interval": 1, "endType": "never",
                    "completedCount": 0, "createdAt": NOW,
                },
            }),
            json!({
                "op": "completeTask", "id": "task-1",
                "completedAt": "2020-04-22T10:00:00+0000", "recordOnly": true,
            }),
        ]
    );
    // The reminder, a day before a 2020 due date, is in the past.
    assert_eq!((run.summary.imported, run.summary.skipped), (1, 1));
}

#[test]
fn quoted_cells_keep_commas_newlines_and_quotes() {
    let run = run_rows(&[row(&[
        ("Title", "b,c"),
        ("Content", "line1\nline2 say \"hi\""),
    ])]);
    let task = run.ops("createTask")[0];
    assert_eq!(task["title"], "b,c");
    assert_eq!(task["description"], "line1\nline2 say \"hi\"");
}

#[test]
fn inbox_tasks_go_to_the_existing_inbox_with_its_statuses() {
    let run = run_rows(&[
        row(&[("Title", "A")]),
        row(&[("List Name", " "), ("Title", "B"), ("Status", "2")]),
    ]);
    assert!(run.ops("createProject").is_empty());
    let tasks = run.ops("createTask");
    assert_eq!(tasks[0]["projectId"], "inbox");
    assert_eq!(tasks[0]["statusId"], "inbox-todo");
    assert_eq!(tasks[1]["statusId"], "inbox-done");
}

#[test]
fn a_list_becomes_a_project_with_the_default_statuses() {
    let run = run_rows(&[row(&[("List Name", " Books "), ("Title", "B")])]);
    assert_eq!(
        run.ops("createProject"),
        [&json!({ "op": "createProject", "name": "Books", "statuses": default_statuses() })]
    );
    let task = run.ops("createTask")[0];
    assert_eq!(task["projectId"], "project-1");
    assert_eq!(task["statusId"], "project-1-st-0");
}

#[test]
fn kanban_columns_become_statuses_ordered_by_column_order() {
    let kanban = |title: &str, column: &str, order: &str| {
        row(&[
            ("List Name", "Vids"),
            ("Title", title),
            ("Column Name", column),
            ("Column Order", order),
            ("View Mode", "kanban"),
        ])
    };
    let run = run_rows(&[
        kanban("X", "To Do", "-100"),
        kanban("Y", "Watching", "50"),
        kanban("Z", "All DONE", "0x10"),
        kanban("W", "To Do", "999"),
        kanban("V", "", ""),
    ]);
    assert_eq!(
        run.ops("createProject")[0]["statuses"],
        json!([
            { "name": "To Do", "color": "#6b7280", "type": "todo", "order": 0 },
            { "name": "All DONE", "color": "#10b981", "type": "done", "order": 1 },
            { "name": "Watching", "color": "#6b7280", "type": "in_progress", "order": 2 },
        ])
    );
    let status: Vec<&Value> = run
        .ops("createTask")
        .iter()
        .map(|t| &t["statusId"])
        .collect();
    assert_eq!(
        status,
        [
            &json!("project-1-st-0"),
            &json!("project-1-st-2"),
            &json!("project-1-st-1"),
            &json!("project-1-st-0"),
            &Value::Null,
        ]
    );
}

#[test]
fn a_column_key_shared_by_two_lists_resolves_as_electron_did() {
    // `${list} ${column}`: list "a b" column "c" and list "a" column "b c" share "a b c".
    let card = |list: &str, column: &str| {
        row(&[
            ("List Name", list),
            ("Column Name", column),
            ("Title", column),
        ])
    };
    let run = run_rows(&[
        card("a b", "c"),
        card("a b", "d"),
        card("a", "b c"),
        card("a", "e"),
    ]);
    let status: Vec<&Value> = run
        .ops("createTask")
        .iter()
        .map(|t| &t["statusId"])
        .collect();
    // List "a" registered "a b c" last, so list "a b"'s column "c" takes list "a"'s status.
    assert_eq!(
        status,
        [
            &json!("project-2-st-0"),
            &json!("project-1-st-1"),
            &json!("project-2-st-0"),
            &json!("project-2-st-1"),
        ]
    );
}

#[test]
fn children_are_created_after_their_parents() {
    let run = run_rows(&[
        row(&[("Title", "Child"), ("taskId", "2"), ("parentId", " 1 ")]),
        row(&[("Title", "Parent"), ("taskId", "1")]),
        row(&[("Title", "Grandchild"), ("taskId", "3"), ("parentId", "2")]),
        row(&[("Title", "Self"), ("taskId", "4"), ("parentId", "4")]),
    ]);
    let tasks = run.ops("createTask");
    let order: Vec<(&Value, &Value)> = tasks
        .iter()
        .map(|t| (&t["title"], &t["parentId"]))
        .collect();
    assert_eq!(
        order,
        [
            (&json!("Parent"), &Value::Null),
            (&json!("Child"), &json!("task-1")),
            (&json!("Grandchild"), &json!("task-2")),
            (&json!("Self"), &Value::Null),
        ]
    );
    let dir = tempfile::tempdir().unwrap();
    let path = write(
        dir.path(),
        "t.csv",
        &backup(&[row(&[("taskId", "1")]), row(&[("parentId", "1")])]),
    );
    assert_eq!(
        preview(&importer(), &[path])["groups"][0]["counts"][2]["value"],
        1
    );
}

#[test]
fn a_child_whose_parent_is_missing_warns_and_imports_top_level() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(
        dir.path(),
        "t.csv",
        &backup(&[row(&[
            ("Title", "Orphan"),
            ("taskId", "2"),
            ("parentId", "99"),
        ])]),
    );
    assert_eq!(
        preview(&importer(), std::slice::from_ref(&path))["groups"][0]["warnings"],
        json!([{
            "code": "ticktick.subtaskParentMissing",
            "message": "Subtask \"Orphan\" parent not found; imported top-level",
            "params": { "title": "Orphan" },
        }])
    );
    let run = run_with(&importer(), &[path], |_| {}, CancellationToken::new());
    assert_eq!(run.ops("createTask")[0]["parentId"], Value::Null);
}

#[test]
fn completed_tasks_are_completed_and_wont_do_tasks_archived() {
    let run = run_rows(&[
        row(&[
            ("Title", "Done"),
            ("Status", "2"),
            ("Completed Time", "2020-04-22T10:00:00+0000"),
        ]),
        row(&[("Title", "Nope"), ("Status", "-1")]),
        row(&[("Title", "Status only"), ("Status", "2")]),
    ]);
    assert_eq!(
        run.writes[1..],
        [
            json!({ "op": "completeTask", "id": "task-1", "completedAt": "2020-04-22T10:00:00+0000", "recordOnly": true }),
            run.writes[2].clone(),
            json!({ "op": "archiveTask", "id": "task-2" }),
            run.writes[4].clone(),
            json!({ "op": "completeTask", "id": "task-3", "completedAt": NOW, "recordOnly": true }),
        ]
    );
}

#[test]
fn folders_warn_once_and_titles_and_descriptions_keep_their_text() {
    let run = run_rows(&[
        row(&[("Folder Name", "Work"), ("Title", ""), ("Content", "  ")]),
        row(&[
            ("Folder Name", "Home"),
            ("Title", "  Z "),
            ("Content", " body "),
        ]),
    ]);
    let tasks = run.ops("createTask");
    assert_eq!(
        (&tasks[0]["title"], &tasks[0]["description"]),
        (&json!("Untitled"), &Value::Null)
    );
    assert_eq!(
        (&tasks[1]["title"], &tasks[1]["description"]),
        (&json!("  Z "), &json!(" body "))
    );
    let dir = tempfile::tempdir().unwrap();
    let path = write(
        dir.path(),
        "t.csv",
        &backup(&[row(&[("Folder Name", "W")]), row(&[("Folder Name", "H")])]),
    );
    assert_eq!(
        preview(&importer(), &[path])["groups"][0]["warnings"],
        json!([{
            "code": "ticktick.foldersDropped",
            "message": "TickTick folders have no Memry equivalent and were dropped",
        }])
    );
}

#[test]
fn priorities_map_to_memry_and_an_unknown_one_warns() {
    let cells = [
        "0",
        "1",
        "3",
        "5",
        "-0",
        "5.9",
        " 3x",
        "",
        "9",
        "1e3",
        "99999999999999999999",
    ];
    let rows: Vec<String> = cells.iter().map(|p| row(&[("Priority", p)])).collect();
    let run = run_rows(&rows);
    let priorities: Vec<&Value> = run
        .ops("createTask")
        .iter()
        .map(|t| &t["priority"])
        .collect();
    let want = [0, 1, 2, 3, 0, 3, 2, 0, 0, 1, 0].map(|p| json!(p));
    assert_eq!(priorities, want.iter().collect::<Vec<_>>());
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "t.csv", &backup(&rows[8..]));
    let warnings = &preview(&importer(), &[path])["groups"][0]["warnings"];
    assert_eq!(
        warnings[0],
        json!({
            "code": "ticktick.unknownPriority",
            "message": "Unknown TickTick priority 9 \u{2192} none",
            "params": { "priority": 9 },
        })
    );
    // "1e3" reads as 1.
    assert_eq!(
        warnings[1],
        json!({
            "code": "ticktick.unknownPriority",
            "message": "Unknown TickTick priority 100000000000000000000 \u{2192} none",
            "params": { "priority": 1e20 },
        })
    );
    assert_eq!(warnings.as_array().unwrap().len(), 2);
}

#[test]
fn repeat_rules_become_repeat_configs() {
    let rules = [
        "FREQ=YEARLY;INTERVAL=1",
        "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15",
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR,+1SU,xx",
        "FREQ=DAILY;COUNT=10",
        "rrule:freq=daily;until=20261231T000000Z",
        "FREQ=MONTHLY;BYDAY=-1FR;BYSETPOS=2;INTERVAL=0",
        "FREQ=DAILY;UNTIL=2026;INTERVAL=-3;COUNT=",
        "FREQ=MONTHLY;BYMONTHDAY=x;FREQ=DAILY",
    ];
    let rows: Vec<String> = rules.iter().map(|r| row(&[("Repeat", r)])).collect();
    let run = run_rows(&rows);
    let configs: Vec<&Value> = run
        .ops("createTask")
        .iter()
        .map(|t| &t["repeatConfig"])
        .collect();
    let base = |extra: Value| {
        let mut config =
            json!({ "interval": 1, "endType": "never", "completedCount": 0, "createdAt": NOW });
        config
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        config
    };
    let want = [
        base(json!({ "frequency": "yearly" })),
        base(json!({ "frequency": "monthly", "monthlyType": "dayOfMonth", "dayOfMonth": 15 })),
        base(json!({ "frequency": "weekly", "interval": 2, "daysOfWeek": [1, 3, 5, 0] })),
        base(json!({ "frequency": "daily", "endType": "count", "endCount": 10 })),
        base(json!({ "frequency": "daily", "endType": "date", "endDate": "2026-12-31" })),
        base(
            json!({ "frequency": "monthly", "monthlyType": "weekPattern", "weekOfMonth": 2, "dayOfWeekForMonth": 5 }),
        ),
        base(json!({ "frequency": "daily" })),
        base(json!({ "frequency": "daily" })),
    ];
    assert_eq!(configs, want.iter().collect::<Vec<_>>());
}

#[test]
fn an_unsupported_repeat_rule_warns_and_imports_without_one() {
    let dir = tempfile::tempdir().unwrap();
    let rows = [
        row(&[("Repeat", "FREQ=HOURLY")]),
        row(&[("Repeat", "RRULE:")]),
        row(&[("Repeat", " ")]),
    ];
    let path = write(dir.path(), "t.csv", &backup(&rows));
    let warnings = &preview(&importer(), std::slice::from_ref(&path))["groups"][0]["warnings"];
    assert_eq!(
        warnings,
        &json!([
            { "code": "ticktick.unsupportedRepeat", "message": "Unsupported repeat rule \"FREQ=HOURLY\" skipped", "params": { "rule": "FREQ=HOURLY" } },
            { "code": "ticktick.unsupportedRepeat", "message": "Unsupported repeat rule \"RRULE:\" skipped", "params": { "rule": "RRULE:" } },
        ])
    );
    let run = run_with(&importer(), &[path], |_| {}, CancellationToken::new());
    assert!(
        run.ops("createTask")
            .iter()
            .all(|t| t["repeatConfig"].is_null())
    );
}

#[test]
fn positions_follow_order_as_a_bigint_within_each_status() {
    let orders = [
        "10",
        "-5",
        "0x10",
        "",
        "nope",
        "99999999999999999999999999999999999999999",
        "-1e3",
        "0b1",
    ];
    let rows: Vec<String> = orders.iter().map(|o| row(&[("Order", o)])).collect();
    let run = run_rows(&rows);
    let positions: Vec<&Value> = run
        .ops("createTask")
        .iter()
        .map(|t| &t["position"])
        .collect();
    // -5 < 0 ("", "nope", "-1e3") < 0b1 < 10 < 0x10 < 10^41, ties in file order.
    let want = [5, 0, 6, 1, 2, 7, 3, 4].map(|p| json!(p));
    assert_eq!(positions, want.iter().collect::<Vec<_>>());
}

#[test]
fn the_preview_counts_each_file_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let good = write(
        dir.path(),
        "TickTick.csv",
        &backup(&[
            row(&[("Title", "Buy milk"), ("taskId", "1")]),
            row(&[
                ("List Name", "Books"),
                ("Title", "Read Dune"),
                ("parentId", "1"),
            ]),
            row(&[
                ("Title", "R"),
                ("Due Date", "2999-01-01T00:00:00+0000"),
                ("Reminder", "PT0S;-PT1H"),
            ]),
        ]),
    );
    let bad = write(dir.path(), "bad.csv", "\"just\",\"data\"\n");
    let preview = preview(&importer(), &[good, bad]);
    assert_eq!(
        preview["groups"],
        json!([
            {
                "label": "TickTick.csv",
                "counts": [
                    { "labelKey": "import.stats.projects", "value": 2 },
                    { "labelKey": "import.stats.tasks", "value": 3 },
                    { "labelKey": "import.stats.subtasks", "value": 1 },
                    { "labelKey": "import.stats.reminders", "value": 2 },
                ],
                "sampleTitles": ["Buy milk", "Read Dune", "R"],
                "warnings": [],
            },
            {
                "label": "bad.csv",
                "counts": [],
                "error": {
                    "code": "ticktick.headerNotFound",
                    "message": "TickTick CSV header row (\"Folder Name\") not found",
                },
            },
        ])
    );
}

#[test]
fn a_run_writes_every_file_and_reports_one_without_a_header() {
    let dir = tempfile::tempdir().unwrap();
    let good = write(
        dir.path(),
        "TickTick.csv",
        &backup(&[
            row(&[("Title", "Buy milk")]),
            row(&[("List Name", "Books"), ("Title", "Read Dune")]),
        ]),
    );
    let bad = write(dir.path(), "bad.csv", "\"just\",\"data\"\n");
    let run = run_with(&importer(), &[bad, good], |_| {}, CancellationToken::new());
    let titles: Vec<&Value> = run.ops("createTask").iter().map(|t| &t["title"]).collect();
    assert_eq!(titles, [&json!("Buy milk"), &json!("Read Dune")]);
    assert_eq!(run.summary.imported, 2);
    assert_eq!(
        run.summary.failed,
        [failed(
            "bad.csv",
            "TickTick CSV header row (\"Folder Name\") not found"
        )]
    );
}

#[test]
fn a_non_ascii_file_name_is_the_preview_label() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "Ki\u{15f}isel.CSV", &backup(&[row(&[])]));
    assert_eq!(
        preview(&importer(), &[path])["groups"][0]["label"],
        "Ki\u{15f}isel.CSV"
    );
}

#[test]
fn refused_writes_skip_or_fail_their_tasks_and_the_import_goes_on() {
    let rows = [
        row(&[("List Name", "Gone"), ("Title", "In gone")]),
        row(&[("Title", "Refused")]),
        row(&[
            ("Title", "Kept"),
            ("Status", "2"),
            ("Due Date", "2999-01-01T00:00:00+0000"),
            ("Reminder", "PT0S"),
        ]),
    ];
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "t.csv", &backup(&rows));
    let run = run_with(
        &importer(),
        std::slice::from_ref(&path),
        |sink| {
            sink.fail_project = Some("Gone".to_owned());
            sink.fail_ticktick_task = Some("Refused".to_owned());
            sink.fail_complete = true;
        },
        CancellationToken::new(),
    );
    assert_eq!(run.summary.skipped, 1, "no project");
    assert_eq!(run.summary.imported, 1);
    assert_eq!(
        run.summary.failed,
        [
            failed("Refused", "task boom"),
            failed("Kept", "complete boom")
        ]
    );
    assert!(run.ops("createReminder").is_empty());

    let run = run_with(
        &importer(),
        &[path],
        |sink| {
            sink.inbox = None;
            sink.fail_reminder = true
        },
        CancellationToken::new(),
    );
    assert_eq!((run.summary.imported, run.summary.skipped), (1, 2));
    assert_eq!(run.ops("completeTask").len(), 0);
}

#[test]
fn an_export_past_the_budget_fails_and_writes_none_of_its_tasks() {
    let dir = tempfile::tempdir().unwrap();
    let small = write(
        dir.path(),
        "small.csv",
        &backup(&[row(&[("Title", "fits")])]),
    );
    let big = write(dir.path(), "big.csv", &backup(&vec![row(&[]); 50]));
    let importer = TickTickImporter {
        budget: 20_000,
        ..importer()
    };
    let run = run_with(
        &importer,
        &[small.clone(), big.clone()],
        |_| {},
        CancellationToken::new(),
    );
    assert_eq!(run.summary.imported, 1);
    assert_eq!(run.summary.failed, [failed("big.csv", TOO_MANY)]);
    // The budget spans the run: the small file's plan leaves too little for a second copy of it.
    let tight = TickTickImporter {
        budget: 1_500,
        ..importer
    };
    let run = run_with(
        &tight,
        &[small.clone(), small.clone()],
        |_| {},
        CancellationToken::new(),
    );
    assert_eq!(run.summary.failed, [failed("small.csv", TOO_MANY)]);
    assert_eq!(
        preview(&tight, &[small.clone(), small])["groups"][1]["error"]["message"],
        TOO_MANY
    );
}

#[test]
fn the_importer_runs_with_the_default_budget_and_the_system_clock_and_zone() {
    let default = TickTickImporter::default();
    assert_eq!(default.budget, MAX_PLANNED_BYTES);
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "t.csv", &backup(&[row(&[("Status", "2")])]));
    let run = run_with(&default, &[path], |_| {}, CancellationToken::new());
    assert_eq!(run.summary.imported, 1);
    assert!(run.ops("completeTask")[0]["completedAt"].as_str().unwrap() > NOW);
}

#[test]
fn a_cancel_after_the_first_task_creates_no_more() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(
        dir.path(),
        "t.csv",
        &backup(&[row(&[("Title", "a")]), row(&[("Title", "b")])]),
    );
    let cancel = CancellationToken::new();
    let timeline = Timeline::default();
    let sink = RecordingSink::new(timeline.clone());
    let watch = cancel.clone();
    let mut ctx = ImportContext::new(
        "ticktick",
        cancel,
        Box::new(move |progress| {
            if progress.imported == 1 {
                watch.cancel();
            }
        }),
    );
    importer().run(&input(&[path]), &mut ctx, &sink).unwrap();
    assert_eq!(timeline.lock().unwrap().len(), 1);
    assert_eq!(ctx.summary().imported, 1);
}

#[test]
fn reading_takes_steps_linear_in_the_export() {
    let dir = tempfile::tempdir().unwrap();
    let n = 50_000;
    let header = COLUMNS.join(",");
    // A data line with `cells` at their column indexes.
    let line = |cells: &[(usize, String)]| {
        let mut line = vec![String::new(); 21];
        for (at, cell) in cells {
            line[*at].clone_from(cell);
        }
        line.join(",") + "\n"
    };
    let lines = |f: &dyn Fn(usize) -> String| (0..n).map(f).collect::<String>();
    let inputs = [
        format!("Folder Name\n{}", "\"".repeat(4 * n)),
        format!("Folder Name,{}\n,x", "Title,".repeat(n)),
        format!("{header}\n{}", lines(&|i| line(&[(1, format!("L{i}"))]))),
        format!(
            "{header}\n{}",
            lines(&|_| line(&[(1, "L".into()), (15, "9".into())]))
        ),
        format!(
            "{header}\n{}",
            lines(&|i| line(&[(1, "L".into()), (19, format!("C{i}")), (20, i.to_string())]))
        ),
    ];
    for (at, text) in inputs.iter().enumerate() {
        let path = write(dir.path(), &format!("steps{at}.csv"), text);
        assert_steps_at_most(&format!("input {at}"), steps, 3 * text.len(), || {
            run_with(&importer(), &[path], |_| {}, CancellationToken::new());
        });
    }
}

proptest! {
    #![proptest_config(proptest_config(64))]

    #[test]
    fn quoted_titles_read_back_as_written(title in "[^\r]{1,40}", crlf in any::<bool>()) {
        let mut text = backup(&[row(&[("Title", &title)])]);
        if crlf {
            text = text.replace('\n', "\r\n");
        }
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "p.csv", &text);
        let run = run_with(&importer(), &[path], |_| {}, CancellationToken::new());
        let want = if crlf { title.replace('\n', "\r\n") } else { title };
        prop_assert_eq!(&run.ops("createTask")[0]["title"], &json!(want));
    }
}
