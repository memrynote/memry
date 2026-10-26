//! `durationMinutes` on a task (chapter 13 §13.7.3): a pulled duration
//! survives a local edit and a duplicate, against real SQLite.

use memry_core::domain::tasks;
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
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
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

fn payload_of(conn: &Connection, task_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, "task", task_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

#[test]
fn a_pulled_duration_survives_an_edit_and_a_duplicate() {
    let db = open("task-duration");
    db.call_blocking(|conn| {
        apply(
            conn,
            "project",
            "pa",
            json!({
                "name": "pa",
                "color": "#0ea5e9",
                "statuses": [
                    {"id": "pa-todo", "name": "To Do", "color": "#6b7280", "position": 0, "isDefault": true}
                ],
                "clock": {"device-b": 1}
            }),
        );
        apply(
            conn,
            "task",
            "t1",
            json!({
                "title": "Focus",
                "projectId": "pa",
                "statusId": "pa-todo",
                "dueDate": "2026-04-20",
                "dueTime": "09:00",
                "durationMinutes": 45,
                "clock": {"device-b": 1}
            }),
        );

        tasks::set_title(conn, "t1", "Deep focus", DEVICE, NOW)?;
        let edited = payload_of(conn, "t1");
        assert_eq!(edited["title"], json!("Deep focus"));
        assert_eq!(edited["durationMinutes"], json!(45));

        let write = tasks::duplicate(conn, "t1", false, DEVICE, NOW + 1_000)?;
        let copy = payload_of(conn, &write.created[0]);
        assert_eq!(copy["dueTime"], json!("09:00"));
        assert_eq!(copy["durationMinutes"], json!(45));
        assert_eq!(copy["fieldClocks"]["durationMinutes"], json!({"device-a": 1}));
        Ok(())
    })
    .expect("the duration round trip");
}
