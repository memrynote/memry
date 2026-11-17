//! The `task-completion-spawn` committed vectors (#3538, spec 004 D3): what
//! completing an open repeating task writes, through `tasks::complete` on a
//! real `data.db`.
//!
//! Rule 2 of `packages/contracts/test-vectors/README.md`: the committed JSON is
//! the only input. Each row's project and task are applied through the sync
//! apply path as a peer would deliver them, the task is completed at the row's
//! local instant, and the closed task and the next occurrence are read back
//! from storage: the derived id (chapter 13 §13.7.3), the due date, the status,
//! `repeatConfig` with its incremented count, and every copied field.
//!
//! Its own test target: the `tzSensitive` rows also run in child processes of
//! this binary under `TZ=America/Los_Angeles` and `TZ=Pacific/Auckland`, where
//! desktop ends a date-bounded series one occurrence early or late. The core
//! reads no process time zone, so the end day stays inclusive in both.

mod support;

use std::process::Command;

use memry_core::domain::calendar::LocalDateTime;
use memry_core::domain::tasks;
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::versioned;
use rusqlite::Connection;
use serde_json::{Map, Value as Json, json};
use support::vector_file;

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";
/// The child run's zone; the parent sets it together with `TZ`.
const CHILD_ZONE: &str = "MEMRY_SPAWN_VECTOR_ZONE";

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-spawn-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn apply(conn: &Connection, item_type: &str, item_id: &str, payload: Json) {
    let outcome = sync_items::apply_remote(
        conn,
        &InboundRecord {
            item_type: item_type.to_owned(),
            item_id: item_id.to_owned(),
            payload_json: payload.to_string(),
            server_cursor: None,
            signer_device_id: None,
            updated_at: NOW,
            deleted_at: None,
        },
        NOW,
    )
    .expect("apply");
    assert_eq!(outcome, ApplyOutcome::Applied, "{item_type}/{item_id}");
}

fn payload_of(conn: &Connection, task_id: &str) -> Json {
    let raw = sync_items::push_payload(conn, "task", task_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

/// Desktop's plain `Task.fields`, as the wire carries it (§13.7.3.1).
fn versioned_fields(plain: &Json) -> Json {
    let entries: Map<String, Json> = plain
        .as_object()
        .into_iter()
        .flatten()
        .map(|(key, value)| (key.clone(), json!({"v": value, "t": 1})))
        .collect();
    Json::Object(entries)
}

/// Seeds the row's project and task, completes it, and lists every way the
/// result differs from the recorded one.
fn run_case(vectors: &Json, case: &Json) -> Vec<String> {
    let name = case["name"].as_str().expect("a name");
    let task = &case["task"];
    let task_id = task["id"].as_str().expect("a task id");
    let db = open(name);
    let result = db.call_blocking(|conn| {
        apply(
            conn,
            "project",
            "p1",
            json!({"name": "p1", "color": "#0ea5e9", "statuses": vectors["statuses"],
                   "clock": {"device-b": 1}}),
        );
        if let Some(parent) = task["parentId"].as_str() {
            apply(
                conn,
                "task",
                parent,
                json!({"title": "Parent", "projectId": "p1", "statusId": "p1-todo",
                       "position": 0, "clock": {"device-b": 1}}),
            );
        }
        let mut seeded = task.clone();
        seeded["fields"] = versioned_fields(&task["fields"]);
        seeded["clock"] = json!({"device-b": 1});
        apply(conn, "task", task_id, seeded);

        let at = case["completedAt"].as_str().expect("an instant");
        let local = LocalDateTime::parse(at).expect("a local instant");
        let done = tasks::complete(conn, task_id, local, DEVICE, NOW + 1_000)?;
        let closed = payload_of(conn, task_id);
        let next = done
            .next_occurrence
            .as_ref()
            .map(|next| (next.clone(), payload_of(conn, &next.id)));
        Ok((done, closed, next))
    });
    let (done, closed, next) = match result {
        Ok(result) => result,
        Err(error) => return vec![format!("{name}: complete failed: {error}")],
    };

    let mut failures = Vec::new();
    let mut check = |what: &str, actual: &Json, expected: &Json| {
        if actual != expected {
            failures.push(format!("{name}: {what} {actual} != {expected}"));
        }
    };
    let expected = &case["expected"];
    check(
        "closed repeatConfig",
        &closed["repeatConfig"],
        &expected["closedRepeatConfig"],
    );
    check("closed status", &closed["statusId"], &json!("p1-done"));
    let Some((occurrence, payload)) = next else {
        check("next occurrence", &Json::Null, &expected["next"]);
        return failures;
    };
    let want = &expected["next"];
    check("next id", &json!(occurrence.id), &want["id"]);
    check("next due", &json!(occurrence.due_date), &want["dueDate"]);
    check("stored due", &payload["dueDate"], &want["dueDate"]);
    check("created", &json!(done.write.created), &json!([want["id"]]));
    check("status", &payload["statusId"], &want["statusId"]);
    check(
        "repeatConfig",
        &payload["repeatConfig"],
        &want["repeatConfig"],
    );
    check(
        "sourceNoteId",
        payload.get("sourceNoteId").unwrap_or(&Json::Null),
        &want["sourceNoteId"],
    );
    for field in vectors["copiedFields"].as_array().expect("copiedFields") {
        let field = field.as_str().expect("a field name");
        let actual = match field {
            "fields" => Json::Object(versioned::plain(payload.get("fields"))),
            _ => payload.get(field).cloned().unwrap_or(Json::Null),
        };
        check(field, &actual, &want["copied"][field]);
    }
    failures
}

fn run_rows(only_tz_sensitive: bool) -> usize {
    let vectors = vector_file("task-completion-spawn");
    let cases: Vec<&Json> = vectors["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .filter(|case| !only_tz_sensitive || case["tzSensitive"] == json!(true))
        .collect();
    assert!(!cases.is_empty(), "the file has rows to run");
    let failures: Vec<String> = cases
        .iter()
        .flat_map(|case| run_case(&vectors, case))
        .collect();
    assert!(
        failures.is_empty(),
        "{} differences over {} rows:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
    cases.len()
}

#[test]
fn every_row_spawns_what_desktop_spawns() {
    let vectors = vector_file("task-completion-spawn");
    assert_eq!(
        json!(run_rows(false)),
        vectors["meta"]["caseCount"],
        "every recorded row ran"
    );
}

#[test]
fn the_end_day_is_inclusive_in_every_time_zone() {
    for zone in ["America/Los_Angeles", "Pacific/Auckland"] {
        let output = Command::new(std::env::current_exe().expect("this test binary"))
            .args([
                "--exact",
                "tz_sensitive_rows_in_the_child_zone",
                "--ignored",
                "--test-threads",
                "1",
            ])
            .env("TZ", zone)
            .env(CHILD_ZONE, zone)
            .output()
            .expect("run the child");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "TZ={zone}:\n{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

/// Runs only as the child of [`the_end_day_is_inclusive_in_every_time_zone`].
#[test]
#[ignore = "a child process of the_end_day_is_inclusive_in_every_time_zone"]
fn tz_sensitive_rows_in_the_child_zone() {
    let zone = std::env::var(CHILD_ZONE).expect("started by the parent test");
    assert_eq!(std::env::var("TZ").ok().as_deref(), Some(zone.as_str()));
    assert_eq!(run_rows(true), 2, "the two end-date rows");
}
