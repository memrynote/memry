//! The desktop-parity task write surface (spec 004 TP020), part two:
//! complete / uncomplete (with the repeating-task roll of D3), undo, and the
//! bulk actions. Against real SQLite, seeded through the real apply path.
//!
//! | Test                                                   | Desktop reference                  |
//! | ------------------------------------------------------ | ---------------------------------- |
//! | complete moves to done and closes open subtasks        | `completeTaskWithUndo`             |
//! | uncomplete reopens into todo; undo restores the status | `uncompleteTaskWithUndo`           |
//! | a repeating completion closes it and creates the next  | `completeTaskWithUndo` repeat arm  |
//! | a series at its end creates no next occurrence         | `shouldCreateNextOccurrence`       |
//! | repeat-from-completion anchors on the completion day   | `completeRepeatingTask`            |
//! | a foreign repeatConfig completes as a plain task       | `dbRepeatConfigToUiRepeatConfig`   |
//! | undo reverts a repeating completion                    | the registered undo                |
//! | the subtask bulk menu                                  | `subtask-bulk-utils.ts`            |
//! | the multi-select bulk bar                              | `use-bulk-actions.ts`              |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::calendar::LocalDateTime;
use memry_core::domain::tasks::{self, NewTask, TaskDetails};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
/// `NOW + 1_000` as the instant `completedAt` carries.
const AT: &str = "2025-10-09T08:53:21.000Z";
const DEVICE: &str = "device-a";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-domain-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn local(text: &str) -> LocalDateTime {
    LocalDateTime::parse(text).expect("a local instant")
}

fn apply(conn: &Connection, item_type: &str, item_id: &str, payload: Value) {
    let outcome = sync_items::apply_remote(
        conn,
        &InboundRecord {
            item_type: item_type.to_owned(),
            item_id: item_id.to_owned(),
            payload_json: serde_json::to_string(&payload).expect("serialise"),
            server_cursor: None,
            signer_device_id: None,
            updated_at: NOW,
            deleted_at: None,
        },
        NOW,
    )
    .expect("apply");
    assert_eq!(outcome, sync_items::ApplyOutcome::Applied, "{item_id}");
}

/// A project with desktop's three default statuses.
fn seed_project(conn: &Connection, id: &str) {
    apply(
        conn,
        "project",
        id,
        json!({
            "name": id,
            "color": "#0ea5e9",
            "statuses": [
                {"id": format!("{id}-todo"), "name": "To Do", "color": "#6b7280", "position": 0, "isDefault": true},
                {"id": format!("{id}-doing"), "name": "In Progress", "color": "#F59E0B", "position": 1},
                {"id": format!("{id}-done"), "name": "Done", "color": "#22c55e", "position": 2, "isDone": true}
            ],
            "clock": {"device-b": 1}
        }),
    );
}

fn create(
    conn: &Connection,
    id: &str,
    parent_id: Option<&str>,
    due_date: Option<&str>,
    repeat: Option<&Value>,
) {
    tasks::create_detailed(
        conn,
        &NewTask {
            id,
            title: "Water the plants",
            project_id: "pa",
            due_date,
            due_time: Some("08:00"),
            priority: 2,
            repeat_config: repeat,
            tags: &[],
        },
        &TaskDetails {
            parent_id,
            source_note_id: Some("note-src"),
            ..TaskDetails::default()
        },
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

fn outbox_ops(conn: &Connection, item_id: &str) -> Vec<String> {
    let mut statement = conn
        .prepare("SELECT op FROM outbox WHERE item_id = ?1 ORDER BY id")
        .expect("prepare");
    statement
        .query_map(params![item_id], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

fn deleted(conn: &Connection, task_id: &str) -> bool {
    conn.query_row(
        "SELECT deleted_at IS NOT NULL FROM tasks WHERE id = ?1",
        params![task_id],
        |row| row.get(0),
    )
    .expect("the projection row")
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|id| (*id).to_owned()).collect()
}

fn daily(extra: Value) -> Value {
    let mut config = json!({"frequency": "daily", "interval": 1, "endType": "never",
                            "endDate": null, "completedCount": 0,
                            "createdAt": "2026-04-01T09:00:00.000Z"});
    if let (Some(config), Some(extra)) = (config.as_object_mut(), extra.as_object()) {
        config.extend(extra.clone());
    }
    config
}

#[test]
fn complete_moves_to_the_done_status_and_closes_open_subtasks() {
    let db = open("tl-complete");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", None, None, None);
        create(conn, "s1", Some("t1"), None, None);
        create(conn, "s2", Some("t1"), None, None);
        tasks::set_completed(conn, "s2", true, DEVICE, NOW)?;

        let done = tasks::complete(
            conn,
            "t1",
            local("2026-04-16T12:00:00"),
            DEVICE,
            NOW + 1_000,
        )?;
        assert!(!done.repeating && done.next_occurrence.is_none());
        assert_eq!(
            done.write.changed_ids(),
            ["t1", "s1"],
            "s2 was already closed"
        );
        assert_eq!(
            done.write.changed[0].fields,
            vec![
                ("statusId".to_owned(), json!("pa-todo")),
                ("completedAt".to_owned(), Value::Null)
            ]
        );
        for id in ["t1", "s1"] {
            let task = payload_of(conn, id);
            assert_eq!(task["statusId"], json!("pa-done"), "{id}");
            assert_eq!(task["completedAt"], json!(AT), "{id}");
            assert_eq!(task["fieldClocks"]["statusId"], json!({"device-a": 2}));
            assert_eq!(task["fieldClocks"]["completedAt"], json!({"device-a": 2}));
            assert_eq!(outbox_ops(conn, id), ["upsert"]);
        }

        let again = tasks::complete(
            conn,
            "t1",
            local("2026-04-16T12:00:00"),
            DEVICE,
            NOW + 2_000,
        )?;
        assert!(again.write.is_empty(), "a done task is left alone");
        assert_eq!(payload_of(conn, "t1")["clock"], json!({"device-a": 2}));
        Ok(())
    })
    .expect("the completion");
}

#[test]
fn uncomplete_reopens_into_todo_and_undo_restores_the_prior_status() {
    let db = open("tl-uncomplete");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", None, None, None);
        tasks::set_status(conn, "t1", "pa-doing", DEVICE, NOW)?;
        let done = tasks::complete(
            conn,
            "t1",
            local("2026-04-16T12:00:00"),
            DEVICE,
            NOW + 1_000,
        )?;

        let reopened = tasks::uncomplete(conn, "t1", DEVICE, NOW + 2_000)?;
        let t1 = payload_of(conn, "t1");
        assert_eq!(t1["statusId"], json!("pa-todo"));
        assert_eq!(t1["completedAt"], Value::Null, "an explicit clear (§13.4)");

        // Undo the reopen, then undo the completion: back to "In Progress".
        tasks::undo(conn, &reopened, DEVICE, NOW + 3_000)?;
        assert_eq!(payload_of(conn, "t1")["statusId"], json!("pa-done"));
        tasks::undo(conn, &done.write, DEVICE, NOW + 4_000)?;
        let t1 = payload_of(conn, "t1");
        assert_eq!(t1["statusId"], json!("pa-doing"));
        assert_eq!(t1["completedAt"], Value::Null);
        // Every undo is a new local write: the clocks keep ticking.
        assert_eq!(t1["fieldClocks"]["statusId"], json!({"device-a": 6}));
        Ok(())
    })
    .expect("the reopen");
}

#[test]
fn a_repeating_completion_closes_this_one_and_creates_the_next_occurrence() {
    let db = open("tl-repeat");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        let repeat = daily(json!({"futureKey": {"kept": true}}));
        create(conn, "t1", None, Some("2026-04-16"), Some(&repeat));
        create(conn, "s1", Some("t1"), None, None);
        tasks::set_status(conn, "t1", "pa-doing", DEVICE, NOW)?;

        let done = tasks::complete(
            conn,
            "t1",
            local("2026-04-16T12:00:00"),
            DEVICE,
            NOW + 1_000,
        )?;
        assert!(done.repeating);
        let next = done.next_occurrence.clone().expect("a next occurrence");
        assert_eq!(next.due_date, "2026-04-17");
        assert_eq!(next.id.len(), tasks::TASK_ID_LEN);
        assert_eq!(done.write.created, std::slice::from_ref(&next.id));

        let closed = payload_of(conn, "t1");
        assert_eq!(closed["repeatConfig"], Value::Null);
        assert_eq!(closed["statusId"], json!("pa-done"));
        assert_eq!(closed["completedAt"], json!(AT));
        assert_eq!(
            closed["fieldClocks"]["repeatConfig"],
            json!({"device-a": 2})
        );
        assert_eq!(payload_of(conn, "s1")["completedAt"], json!(AT));

        let occurrence = payload_of(conn, &next.id);
        assert_eq!(occurrence["title"], json!("Water the plants"));
        assert_eq!(occurrence["dueDate"], json!("2026-04-17"));
        assert_eq!(occurrence["dueTime"], json!("08:00"));
        assert_eq!(occurrence["priority"], json!(2));
        assert_eq!(occurrence["statusId"], json!("pa-todo"));
        assert!(occurrence.get("completedAt").is_none());
        assert!(occurrence.get("sourceNoteId").is_none());
        assert_eq!(occurrence["createdAt"], json!(AT));
        assert_eq!(occurrence["repeatConfig"]["completedCount"], json!(1));
        assert_eq!(
            occurrence["repeatConfig"]["futureKey"],
            json!({"kept": true}),
            "D7"
        );
        assert_eq!(occurrence["repeatConfig"]["createdAt"], repeat["createdAt"]);
        assert_eq!(occurrence["clock"], json!({"device-a": 1}));
        assert_eq!(outbox_ops(conn, &next.id), ["upsert"]);
        // No subtasks ride along to the next occurrence.
        let children: i64 = conn
            .query_row(
                "SELECT count(*) FROM tasks WHERE parent_id = ?1",
                params![next.id],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(children, 0);
        Ok(())
    })
    .expect("the repeating completion");
}

#[test]
fn a_series_at_its_end_creates_no_next_occurrence() {
    let db = open("tl-repeat-end");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        let by_count = daily(json!({"endType": "count", "endCount": 2, "completedCount": 1}));
        create(conn, "t1", None, Some("2026-04-16"), Some(&by_count));
        let by_date = daily(json!({"endType": "date", "endDate": "2026-04-10"}));
        create(conn, "t2", None, Some("2026-04-16"), Some(&by_date));

        for id in ["t1", "t2"] {
            let done =
                tasks::complete(conn, id, local("2026-04-16T12:00:00"), DEVICE, NOW + 1_000)?;
            assert!(done.repeating, "{id}");
            assert!(done.next_occurrence.is_none(), "{id}: the final occurrence");
            assert!(done.write.created.is_empty());
            assert_eq!(payload_of(conn, id)["repeatConfig"], Value::Null);
        }
        Ok(())
    })
    .expect("the series end");
}

#[test]
fn repeat_from_completion_anchors_on_the_completion_day() {
    let db = open("tl-repeat-completion");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        let weekly = daily(json!({"frequency": "weekly"}));
        create(conn, "t1", None, Some("2026-04-01"), Some(&weekly));
        tasks::set_repeat(conn, "t1", Some(&weekly), Some("completion"), DEVICE, NOW)?;

        let done = tasks::complete(
            conn,
            "t1",
            local("2026-04-16T21:00:00"),
            DEVICE,
            NOW + 1_000,
        )?;
        let next = done.next_occurrence.expect("a next occurrence");
        assert_eq!(next.due_date, "2026-04-23");
        assert_eq!(
            payload_of(conn, &next.id)["repeatFrom"],
            json!("completion")
        );
        Ok(())
    })
    .expect("the completion anchor");
}

#[test]
fn a_foreign_repeat_config_completes_as_a_plain_task_and_is_kept() {
    let db = open("tl-repeat-foreign");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        let foreign = json!({"freq": "daily", "until": "2026-09-25"});
        create(conn, "t1", None, Some("2026-04-16"), Some(&foreign));

        let done = tasks::complete(
            conn,
            "t1",
            local("2026-04-16T12:00:00"),
            DEVICE,
            NOW + 1_000,
        )?;
        assert!(!done.repeating && done.next_occurrence.is_none());
        let t1 = payload_of(conn, "t1");
        assert_eq!(t1["repeatConfig"], foreign);
        assert_eq!(t1["statusId"], json!("pa-done"));
        Ok(())
    })
    .expect("the foreign config");
}

#[test]
fn undo_reverts_a_repeating_completion_and_deletes_the_next_occurrence() {
    let db = open("tl-repeat-undo");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        let repeat = daily(json!({}));
        create(conn, "t1", None, Some("2026-04-16"), Some(&repeat));
        let done = tasks::complete(
            conn,
            "t1",
            local("2026-04-16T12:00:00"),
            DEVICE,
            NOW + 1_000,
        )?;
        let next = done.next_occurrence.clone().expect("a next occurrence");

        let reverted = tasks::undo(conn, &done.write, DEVICE, NOW + 2_000)?;
        assert_eq!(reverted.deleted, std::slice::from_ref(&next.id));
        assert!(deleted(conn, &next.id));
        assert_eq!(outbox_ops(conn, &next.id), ["delete"]);
        let t1 = payload_of(conn, "t1");
        assert_eq!(t1["repeatConfig"], repeat);
        assert_eq!(t1["statusId"], json!("pa-todo"));
        assert_eq!(t1["completedAt"], Value::Null);
        Ok(())
    })
    .expect("the undo");
}

#[test]
fn the_subtask_bulk_menu_writes_desktop_s_fields() {
    let db = open("tl-subtask-bulk");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", None, None, None);
        for id in ["s1", "s2", "s3"] {
            create(conn, id, Some("t1"), None, None);
        }
        tasks::set_completed(conn, "s3", true, DEVICE, NOW)?;

        let completed = tasks::complete_all_subtasks(conn, "t1", DEVICE, NOW + 1_000)?;
        assert_eq!(completed.changed_ids(), ["s1", "s2"]);
        assert_eq!(payload_of(conn, "s1")["statusId"], json!("pa-done"));
        assert_eq!(
            payload_of(conn, "t1")["completedAt"],
            Value::Null,
            "parent untouched"
        );

        tasks::set_completed(conn, "s1", false, DEVICE, NOW + 1_000)?;
        let due = tasks::set_due_date_for_all_subtasks(
            conn,
            "t1",
            Some("2026-05-01"),
            false,
            DEVICE,
            NOW + 2_000,
        )?;
        assert_eq!(due.changed_ids(), ["s1"], "open subtasks only");
        let due = tasks::set_due_date_for_all_subtasks(
            conn,
            "t1",
            Some("2026-05-02"),
            true,
            DEVICE,
            NOW + 2_000,
        )?;
        assert_eq!(due.changed_ids(), ["s1", "s2", "s3"]);
        assert_eq!(payload_of(conn, "s3")["dueDate"], json!("2026-05-02"));

        let priority =
            tasks::set_priority_for_all_subtasks(conn, "t1", 4, false, DEVICE, NOW + 3_000)?;
        assert_eq!(priority.changed_ids(), ["s1"]);
        assert_eq!(
            payload_of(conn, "s1")["fieldClocks"]["priority"],
            json!({"device-a": 2})
        );

        let reopened = tasks::mark_all_subtasks_incomplete(conn, "t1", DEVICE, NOW + 4_000)?;
        assert_eq!(reopened.changed_ids(), ["s2", "s3"]);
        assert_eq!(payload_of(conn, "s2")["statusId"], json!("pa-todo"));
        assert_eq!(payload_of(conn, "s3")["completedAt"], Value::Null);

        let removed = tasks::delete_all_subtasks(conn, "t1", DEVICE, NOW + 5_000)?;
        assert_eq!(removed.deleted, ["s1", "s2", "s3"]);
        assert!(!deleted(conn, "t1"));
        assert!(tasks::complete_all_subtasks(conn, "missing", DEVICE, NOW).is_err());
        Ok(())
    })
    .expect("the subtask bulk menu");
}

#[test]
fn the_bulk_bar_acts_on_every_live_selected_task_in_one_write() {
    let db = open("tl-bulk");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        seed_project(conn, "pb");
        for id in ["t1", "t2", "t3"] {
            create(conn, id, None, Some("2026-04-16"), None);
        }
        create(conn, "s1", Some("t3"), None, None);
        let selection = ids(&["t1", "t2", "missing"]);

        let completed = tasks::bulk_complete(conn, &selection, DEVICE, NOW + 1_000)?;
        assert_eq!(
            completed.changed_ids(),
            ["t1", "t2"],
            "a missing id is skipped"
        );
        assert_eq!(payload_of(conn, "t2")["statusId"], json!("pa-done"));
        let reopened = tasks::bulk_uncomplete(conn, &selection, DEVICE, NOW + 2_000)?;
        assert_eq!(reopened.changed_ids(), ["t1", "t2"]);
        assert_eq!(payload_of(conn, "t1")["completedAt"], Value::Null);

        tasks::bulk_set_priority(conn, &selection, 1, DEVICE, NOW + 3_000)?;
        assert_eq!(payload_of(conn, "t2")["priority"], json!(1));

        tasks::bulk_set_due(
            conn,
            &selection,
            Some("2026-05-01"),
            Some("10:00"),
            DEVICE,
            NOW,
        )?;
        assert_eq!(payload_of(conn, "t1")["dueTime"], json!("10:00"));
        tasks::bulk_set_due(conn, &selection, None, Some("10:00"), DEVICE, NOW)?;
        let t1 = payload_of(conn, "t1");
        assert_eq!(
            (t1["dueDate"].clone(), t1["dueTime"].clone()),
            (Value::Null, Value::Null)
        );

        let status = tasks::bulk_set_status(conn, &selection, "pa-done", DEVICE, NOW + 1_000)?;
        assert_eq!(status.changed_ids(), ["t1", "t2"]);
        assert_eq!(payload_of(conn, "t1")["completedAt"], json!(AT));
        assert!(tasks::bulk_set_status(conn, &selection, "missing", DEVICE, NOW).is_err());

        let moved = tasks::bulk_move(conn, &ids(&["t3", "s1"]), "pb", DEVICE, NOW)?;
        assert_eq!(moved.changed_ids(), ["t3", "s1"]);
        assert_eq!(payload_of(conn, "s1")["projectId"], json!("pb"));
        assert_eq!(payload_of(conn, "s1")["statusId"], json!("pb-todo"));

        tasks::bulk_archive(conn, &selection, DEVICE, NOW + 1_000)?;
        assert_eq!(payload_of(conn, "t1")["archivedAt"], json!(AT));
        let unarchived = tasks::bulk_unarchive(conn, &selection, DEVICE, NOW)?;
        assert_eq!(unarchived.changed_ids(), ["t1", "t2"]);
        assert_eq!(payload_of(conn, "t2")["archivedAt"], Value::Null);

        let removed = tasks::bulk_delete(conn, &ids(&["t3", "s1", "t1"]), DEVICE, NOW)?;
        assert_eq!(
            removed.deleted,
            ["s1", "t3", "t1"],
            "subtasks go with their parent"
        );
        assert_eq!(outbox_ops(conn, "t3"), ["delete"]);
        assert!(!deleted(conn, "t2"));
        Ok(())
    })
    .expect("the bulk bar");
}
