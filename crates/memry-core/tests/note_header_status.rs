//! A note's header status, derived from the tasks in its body (#3176).
//!
//! Real SQLite, a real CRDT body, and task and project rows landed the way a
//! pull lands them. The property table the shell reads is `note_meta::metadata`.
//!
//! | Test                                                  | Rule                                  |
//! | ----------------------------------------------------- | ------------------------------------- |
//! | all to-do reads Not started, all done reads Done      | `note-status.ts` `deriveStatusCategory` |
//! | a task in progress, or done beside open, is progress  | same                                  |
//! | a note without tasks keeps its stored status          | the stored value stands               |
//! | a task row that has not arrived is skipped            | no row is not to-do                   |
//! | a status declared as another type is left alone       | only a status property is derived     |
//! | the payload keeps the stored value                    | sync and older builds read it         |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::crdt::update_log;
use memry_core::domain::note_meta;
use memry_core::domain::notes::{self, NewNote};
use memry_core::domain::properties;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Map, Value, json};
use yrs::{Any, Doc, ReadTxn as _, Transact as _, Xml as _, XmlElementPrelim, XmlFragment as _};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";
const NOTE: &str = "note-1";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-header-status-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn apply_remote(conn: &Connection, item_type: &str, item_id: &str, payload: Value) {
    sync_items::apply_remote(
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
}

/// `(task id, state)` -> a task row in project `p1`: `todo`, `doing`, `done`
/// (a done status), or `completed` (completed on a to-do status).
fn add_task(conn: &Connection, id: &str, state: &str) {
    let status = match state {
        "todo" | "completed" => "s-todo",
        "doing" => "s-doing",
        _ => "s-done",
    };
    let mut payload = json!({
        "title": id, "projectId": "p1", "statusId": status, "clock": {"device-b": 1}
    });
    if state == "completed" {
        payload["completedAt"] = json!("2026-01-02T00:00:00.000Z");
    }
    apply_remote(conn, "task", id, payload);
}

/// A note with `stored` as its status, a body of one `taskBlock` per id, and
/// the property declared as `type_name`.
fn seed(db: &Db, stored: Option<&str>, type_name: &str, task_ids: &[&str]) {
    db.call_blocking(|conn: &mut Connection| {
        apply_remote(
            conn,
            "project",
            "p1",
            json!({"name": "P", "color": "#111111", "statuses": [
                {"id": "s-todo", "name": "To do", "color": "#6b7280", "position": 0, "isDefault": true},
                {"id": "s-doing", "name": "Doing", "color": "#f59e0b", "position": 1},
                {"id": "s-done", "name": "Done", "color": "#22c55e", "position": 2, "isDone": true}
            ], "clock": {"device-b": 1}}),
        );
        let mut properties = Map::new();
        if let Some(stored) = stored {
            properties.insert("status".to_owned(), json!(stored));
        }
        notes::create(
            conn,
            &NewNote {
                id: NOTE,
                title: "Plan",
                folder_path: None,
                content: "",
                tags: &[],
                properties: Some(&properties),
                emoji: None,
            },
            DEVICE,
            NOW,
        )?;
        conn.execute(
            "INSERT INTO property_definitions (name, type, options, default_value, color) \
             VALUES ('status', ?1, NULL, NULL, NULL)",
            [type_name],
        )
        .expect("the definition");

        let doc = Doc::new();
        let fragment = doc.get_or_insert_xml_fragment("prosemirror");
        let mut txn = doc.transact_mut();
        let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
        for (index, task_id) in task_ids.iter().enumerate() {
            let container =
                group.insert(&mut txn, index as u32, XmlElementPrelim::empty("blockContainer"));
            container.insert_attribute(&mut txn, "id", format!("b{index}"));
            let block = container.insert(&mut txn, 0, XmlElementPrelim::empty("taskBlock"));
            block.insert_attribute(&mut txn, "checked", Any::Bool(false));
            block.insert_attribute(&mut txn, "parentTaskId", Any::String("".into()));
            block.insert_attribute(&mut txn, "taskId", Any::String((*task_id).into()));
            block.insert_attribute(&mut txn, "title", Any::String((*task_id).into()));
        }
        let update = txn.encode_state_as_update_v1(&yrs::StateVector::default());
        drop(txn);
        update_log::append_server_update(conn, NOTE, 1, &update, NOW).expect("seed the body");
        Ok(())
    })
    .expect("the seed");
}

fn tasks(db: &Db, rows: &[(&str, &str)]) {
    db.call_blocking(|conn: &mut Connection| {
        for (id, state) in rows {
            add_task(conn, id, state);
        }
        Ok(())
    })
    .expect("the tasks");
}

fn status_shown(db: &Db) -> Option<String> {
    let metadata = db
        .call_blocking(|conn: &mut Connection| note_meta::metadata(conn, NOTE))
        .expect("the read")
        .expect("the note");
    metadata
        .properties
        .into_iter()
        .find(|property| property.name == "status")
        .map(|property| serde_json::from_str::<String>(&property.value_json).expect("a string"))
}

#[test]
fn all_todo_reads_not_started_and_all_done_reads_done() {
    let db = open("all");
    seed(&db, Some("Done"), "status", &["a", "b"]);
    tasks(&db, &[("a", "todo"), ("b", "todo")]);
    assert_eq!(status_shown(&db).as_deref(), Some("Not started"));

    tasks(&db, &[("a", "done"), ("b", "completed")]);
    assert_eq!(status_shown(&db).as_deref(), Some("Done"));
}

#[test]
fn a_task_in_progress_or_done_beside_open_is_in_progress() {
    let db = open("progress");
    seed(&db, Some("Not started"), "status", &["a", "b"]);
    tasks(&db, &[("a", "todo"), ("b", "doing")]);
    assert_eq!(status_shown(&db).as_deref(), Some("In Progress"));

    tasks(&db, &[("b", "completed")]);
    assert_eq!(status_shown(&db).as_deref(), Some("In Progress"));
}

#[test]
fn a_note_without_tasks_keeps_its_stored_status() {
    let db = open("none");
    seed(&db, Some("Abandoned"), "status", &[]);
    assert_eq!(status_shown(&db).as_deref(), Some("Abandoned"));
}

#[test]
fn a_task_row_that_has_not_arrived_is_skipped_not_read_as_todo() {
    let db = open("missing");
    seed(&db, Some("Not started"), "status", &["a", "missing"]);
    tasks(&db, &[("a", "done")]);
    assert_eq!(status_shown(&db).as_deref(), Some("Done"));

    let only_missing = open("only-missing");
    seed(&only_missing, Some("Abandoned"), "status", &["missing"]);
    assert_eq!(status_shown(&only_missing).as_deref(), Some("Abandoned"));
}

#[test]
fn a_status_declared_as_another_type_is_left_alone() {
    let db = open("select");
    seed(&db, Some("Open"), "select", &["a"]);
    tasks(&db, &[("a", "done")]);
    assert_eq!(status_shown(&db).as_deref(), Some("Open"));
}

#[test]
fn the_payload_keeps_the_stored_value() {
    let db = open("payload");
    seed(&db, Some("Not started"), "status", &["a"]);
    tasks(&db, &[("a", "done")]);
    assert_eq!(status_shown(&db).as_deref(), Some("Done"));
    let stored = db
        .call_blocking(|conn: &mut Connection| properties::values(conn, notes::ITEM_TYPE, NOTE))
        .expect("the payload");
    assert_eq!(stored.get("status"), Some(&json!("Not started")));
}
