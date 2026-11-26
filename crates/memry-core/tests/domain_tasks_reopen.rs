//! The open status a reopen and a repeating roll pick, as Electron's
//! `openStatusIdOnReopen` (`packages/domain-tasks/src/completion.ts:39-49`) and
//! `defaultOpenStatusId` (`repeat-completion.ts:47-53`) pick it: the open status
//! flagged default, else the first open one by position. A reopen changes the
//! status only when the task sits in a done status.

use memry_core::domain::calendar::LocalDateTime;
use memry_core::domain::tasks::{self, NewTask, TaskDetails};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-domain-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

/// Desktop's three default statuses after the user dragged In Progress to the
/// front: To Do keeps its default flag at position 1.
fn seed_reordered_project(conn: &Connection) {
    seed_project(conn, 0, 1);
}

/// Desktop's three default statuses, To Do at `todo` and In Progress at `doing`.
fn seed_project(conn: &Connection, doing: i64, todo: i64) {
    let outcome = sync_items::apply_remote(
        conn,
        &InboundRecord {
            item_type: "project".to_owned(),
            item_id: "pa".to_owned(),
            payload_json: json!({
                "name": "pa",
                "color": "#0ea5e9",
                "statuses": [
                    {"id": "pa-doing", "name": "In Progress", "color": "#F59E0B", "position": doing},
                    {"id": "pa-todo", "name": "To Do", "color": "#6b7280", "position": todo, "isDefault": true},
                    {"id": "pa-done", "name": "Done", "color": "#22c55e", "position": 2, "isDone": true}
                ],
                "clock": {"device-b": 1}
            })
            .to_string(),
            server_cursor: None,
            signer_device_id: None,
            updated_at: NOW,
            deleted_at: None,
        },
        NOW,
    )
    .expect("apply");
    assert_eq!(outcome, sync_items::ApplyOutcome::Applied);
}

fn create(conn: &Connection, id: &str, due_date: Option<&str>, repeat: Option<&Value>) {
    tasks::create_detailed(
        conn,
        &NewTask {
            id,
            title: "Water the plants",
            project_id: "pa",
            due_date,
            due_time: None,
            priority: 0,
            repeat_config: repeat,
            tags: &[],
        },
        &TaskDetails::default(),
        DEVICE,
        NOW,
    )
    .expect("create");
}

fn payload_of(conn: &Connection, task_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, "task", task_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn noon() -> LocalDateTime {
    LocalDateTime::parse("2026-04-16T12:00:00").expect("a local instant")
}

#[test]
fn uncomplete_after_a_status_reorder_reopens_into_the_default_open_status() {
    let db = open("reopen-reordered");
    db.call_blocking(|conn| {
        seed_reordered_project(conn);
        create(conn, "t1", None, None);
        tasks::complete(conn, "t1", noon(), DEVICE, NOW + 1_000)?;
        assert_eq!(payload_of(conn, "t1")["statusId"], json!("pa-done"));

        tasks::uncomplete(conn, "t1", DEVICE, NOW + 2_000)?;
        let t1 = payload_of(conn, "t1");
        assert_eq!(t1["statusId"], json!("pa-todo"), "out of the Done column");
        assert_eq!(t1["completedAt"], Value::Null);
        Ok(())
    })
    .expect("the reopen");
}

#[test]
fn uncomplete_leaves_a_task_that_is_not_in_a_done_status_where_it_is() {
    let db = open("reopen-open");
    db.call_blocking(|conn| {
        seed_project(conn, 1, 0);
        create(conn, "t1", None, None);
        tasks::set_status(conn, "t1", "pa-doing", DEVICE, NOW)?;

        tasks::uncomplete(conn, "t1", DEVICE, NOW + 1_000)?;
        let t1 = payload_of(conn, "t1");
        assert_eq!(t1["statusId"], json!("pa-doing"));
        assert_eq!(t1["completedAt"], Value::Null);
        Ok(())
    })
    .expect("the reopen");
}

#[test]
fn a_repeating_completion_puts_the_next_occurrence_in_the_default_open_status() {
    let db = open("reopen-roll");
    db.call_blocking(|conn| {
        seed_reordered_project(conn);
        let daily = json!({"frequency": "daily", "interval": 1, "endType": "never",
                           "endDate": null, "completedCount": 0,
                           "createdAt": "2026-04-01T09:00:00.000Z"});
        create(conn, "t1", Some("2026-04-16"), Some(&daily));
        tasks::set_status(conn, "t1", "pa-doing", DEVICE, NOW)?;

        let done = tasks::complete(conn, "t1", noon(), DEVICE, NOW + 1_000)?;
        let next = done.next_occurrence.expect("a next occurrence");
        assert_eq!(payload_of(conn, &next.id)["statusId"], json!("pa-todo"));
        Ok(())
    })
    .expect("the roll");
}
