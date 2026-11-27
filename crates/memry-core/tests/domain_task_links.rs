//! The tasks linked to a note or a canvas (`tasks:get-linked-tasks`,
//! `getTasksLinkedToNote`), against real SQLite through every task write path:
//! local create, update and delete, a remote apply and a remote tombstone.

use memry_core::domain::calendar::LocalDateTime;
use memry_core::domain::task_links::{self, TaskLinkTarget};
use memry_core::domain::tasks::{self, NewTask, TaskDetails, TaskPatch};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-task-links-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn record(
    item_type: &str,
    item_id: &str,
    payload: Value,
    deleted_at: Option<i64>,
) -> InboundRecord {
    InboundRecord {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        payload_json: serde_json::to_string(&payload).expect("serialise"),
        server_cursor: Some(3),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at,
    }
}

fn seed_project(conn: &Connection) {
    sync_items::apply_remote(
        conn,
        &record(
            "project",
            "p1",
            json!({"name": "P", "color": "#0ea5e9", "statuses": [
                {"id": "p1-todo", "name": "To Do", "color": "#6b7280", "position": 0, "isDefault": true}
            ], "clock": {"device-b": 1}}),
            None,
        ),
        NOW,
    )
    .expect("the project");
}

fn new_task(id: &str) -> NewTask<'_> {
    NewTask {
        id,
        title: "Linked",
        project_id: "p1",
        due_date: None,
        due_time: None,
        priority: 0,
        repeat_config: None,
        tags: &[],
    }
}

fn ids(conn: &Connection, target: TaskLinkTarget, id: &str) -> Vec<String> {
    task_links::linked_task_ids(conn, target, id).expect("the lookup")
}

fn note_tasks(conn: &Connection, note_id: &str) -> Vec<String> {
    task_links::linked_tasks(conn, note_id)
        .expect("the linked tasks")
        .into_iter()
        .map(|task| task.id)
        .collect()
}

#[test]
fn a_local_task_links_its_notes_and_canvases_and_follows_every_edit() {
    let db = open("local");
    db.call_blocking(|conn| {
        seed_project(conn);
        let notes = ["n1".to_owned(), "n2".to_owned()];
        let canvases = ["c1".to_owned()];
        tasks::create_detailed(
            conn,
            &new_task("t1"),
            &TaskDetails {
                linked_note_ids: &notes,
                linked_canvas_ids: &canvases,
                // The note a task was written in is not a link.
                source_note_id: Some("n-source"),
                ..TaskDetails::default()
            },
            DEVICE,
            NOW,
        )?
        .acknowledge();
        tasks::create_detailed(
            conn,
            &new_task("t0"),
            &TaskDetails {
                linked_note_ids: &notes[..1],
                ..TaskDetails::default()
            },
            DEVICE,
            NOW,
        )?
        .acknowledge();

        assert_eq!(note_tasks(conn, "n1"), ["t0", "t1"]);
        assert_eq!(note_tasks(conn, "n2"), ["t1"]);
        assert_eq!(ids(conn, TaskLinkTarget::Canvas, "c1"), ["t1"]);
        assert!(note_tasks(conn, "n-source").is_empty());
        // A note id is not a canvas id.
        assert!(ids(conn, TaskLinkTarget::Canvas, "n1").is_empty());

        let local = LocalDateTime::parse("2025-10-09T10:00:00").expect("a local instant");
        let patch = TaskPatch {
            linked_note_ids: Some(vec!["n3".to_owned()]),
            linked_canvas_ids: Some(Vec::new()),
            ..TaskPatch::default()
        };
        tasks::update::apply(conn, "t1", &patch, local, false, DEVICE, NOW + 1)?
            .expect("the update");
        assert_eq!(note_tasks(conn, "n1"), ["t0"]);
        assert!(note_tasks(conn, "n2").is_empty());
        assert_eq!(note_tasks(conn, "n3"), ["t1"]);
        assert!(ids(conn, TaskLinkTarget::Canvas, "c1").is_empty());

        tasks::delete(conn, "t0", DEVICE, NOW + 2)?.acknowledge();
        assert!(note_tasks(conn, "n1").is_empty());
        Ok(())
    })
    .expect("the scenario");
}

#[test]
fn a_remote_task_links_on_apply_and_unlinks_on_its_tombstone() {
    let db = open("remote");
    db.call_blocking(|conn| {
        seed_project(conn);
        let payload = json!({
            "title": "From the phone", "projectId": "p1", "statusId": "p1-todo",
            "linkedNoteIds": ["n1"], "linkedCanvasIds": ["c1"],
            "clock": {"device-b": 1}, "fieldClocks": {}
        });
        tasks::apply_remote(conn, &record("task", "t9", payload, None), NOW, None)?;
        assert_eq!(note_tasks(conn, "n1"), ["t9"]);
        assert_eq!(ids(conn, TaskLinkTarget::Canvas, "c1"), ["t9"]);

        sync_items::apply_remote(
            conn,
            &record("task", "t9", json!({}), Some(NOW + 5)),
            NOW + 5,
        )?;
        assert!(note_tasks(conn, "n1").is_empty());
        assert!(ids(conn, TaskLinkTarget::Canvas, "c1").is_empty());
        Ok(())
    })
    .expect("the scenario");
}
