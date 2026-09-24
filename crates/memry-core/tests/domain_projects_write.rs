//! Project writes (spec 004 D2), against real SQLite: payload JSON, clocks and
//! outbox rows. Desktop is the reference for every expectation.
//!
//! | Test                                                   | Desktop reference            |
//! | ------------------------------------------------------ | ---------------------------- |
//! | a create carries desktop's default statuses            | `createDefaultStatuses`      |
//! | a custom list mints `${projectId}-${order}` ids        | `createCustomStatuses`       |
//! | an invalid create writes nothing                       | `ProjectCreateSchema`        |
//! | an edit ticks the document and each field clock        | chapter 06 §6.6              |
//! | a status reconcile keeps, drops, adds and retypes      | `reconcileProjectStatuses`   |
//! | archive and unarchive; the Inbox refuses               | `archiveProject`             |
//! | a reorder writes one outbox row per project            | `reorderProjects`            |
//! | the home note is set and cleared with an explicit null | `setProjectHomeNote`         |
//! | a delete tombstones every task with its own row        | `deleteProject`              |
//! | a delete can move the tasks to the Inbox               | `getEquivalentStatus`        |
//! | a summary counts open, done and overdue tasks          | `getProjectsWithStats`       |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::projects::{
    self, NewProject, ProjectEdit, StatusInput, StatusType, TaskDisposition,
};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const NOW_ISO: &str = "2025-10-09T08:53:20.000Z";
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

fn seed(conn: &Connection, item_type: &str, item_id: &str, payload: Value) {
    let record = InboundRecord {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        payload_json: serde_json::to_string(&payload).expect("serialise"),
        server_cursor: Some(7),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    };
    sync_items::apply_remote(conn, &record, NOW).expect("apply");
}

/// Desktop's inbox, statuses and all (`apps/desktop/src/main/database/defaults.ts`).
fn seed_inbox(conn: &Connection) {
    seed(
        conn,
        "project",
        "inbox",
        json!({
            "name": "Inbox", "color": "#6b7280", "position": 0, "isInbox": true,
            "statuses": [
                {"id": "inbox-todo", "name": "To Do", "color": "#6b7280", "position": 0,
                 "isDefault": true, "isDone": false},
                {"id": "inbox-in-progress", "name": "In Progress", "color": "#F59E0B",
                 "position": 1, "isDefault": false, "isDone": false},
                {"id": "inbox-done", "name": "Done", "color": "#22c55e", "position": 2,
                 "isDefault": false, "isDone": true}
            ],
            "clock": {"device-b": 1}
        }),
    );
}

fn seed_task(conn: &Connection, id: &str, project_id: &str, extra: Value) {
    let mut payload = json!({
        "title": format!("[agent] {id}"), "projectId": project_id, "priority": 0,
        "position": 0, "clock": {"device-b": 1}
    });
    if let (Some(payload), Some(extra)) = (payload.as_object_mut(), extra.as_object()) {
        payload.extend(extra.clone());
    }
    seed(conn, "task", id, payload);
}

fn payload_of(conn: &Connection, item_type: &str, item_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, item_type, item_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

/// `(item_type, op)` for every outbox row of one item.
fn outbox_of(conn: &Connection, item_id: &str) -> Vec<(String, String)> {
    let mut statement = conn
        .prepare("SELECT item_type, op FROM outbox WHERE item_id = ?1 ORDER BY id")
        .expect("prepare");
    statement
        .query_map(params![item_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query")
        .map(|row| row.expect("row"))
        .collect()
}

fn outbox_total(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
        .expect("count the queue")
}

fn new_project<'a>(id: &'a str, statuses: Option<&'a [StatusInput<'a>]>) -> NewProject<'a> {
    NewProject {
        id: Some(id),
        name: "Agent Test Alpha",
        description: None,
        color: None,
        icon: Some("Folder"),
        statuses,
    }
}

fn status<'a>(id: Option<&'a str>, name: &'a str, kind: StatusType, order: i64) -> StatusInput<'a> {
    StatusInput {
        id,
        name,
        color: "#0ea5e9",
        status_type: kind,
        order,
    }
}

#[test]
fn a_create_carries_desktops_default_statuses_and_seeds_all_nine_field_clocks() {
    let db = open("projects-create");
    db.call_blocking(|conn| {
        seed(
            conn,
            "project",
            "older",
            json!({"name": "Older", "color": "#888888", "position": 4, "clock": {"device-b": 1}}),
        );

        let id = projects::create(conn, &new_project("proj-a", None), DEVICE, NOW)?.acknowledge();
        assert_eq!(id, "proj-a");

        let payload = payload_of(conn, "project", "proj-a");
        assert_eq!(payload["name"], json!("Agent Test Alpha"));
        assert_eq!(
            payload["color"],
            json!("#6366f1"),
            "ProjectCreateSchema's default"
        );
        assert_eq!(payload["icon"], json!("Folder"));
        assert!(
            payload.get("description").is_none(),
            "absent, not null (§13.4)"
        );
        assert_eq!(payload["position"], json!(5), "next after every project");
        assert_eq!(payload["isInbox"], json!(false));
        assert_eq!(payload["links"], json!([]));
        assert_eq!(payload["createdAt"], json!(NOW_ISO));
        assert_eq!(payload["clock"], json!({"device-a": 1}));
        let clocks = payload["fieldClocks"].as_object().expect("field clocks");
        assert_eq!(clocks.len(), 9, "PROJECT_SYNCABLE_FIELDS (§6.7)");
        assert!(
            clocks
                .values()
                .all(|clock| *clock == json!({"device-a": 1}))
        );

        assert_eq!(
            payload["statuses"],
            json!([
                {"id": "proj-a-todo", "projectId": "proj-a", "name": "To Do",
                 "color": "#6b7280", "position": 0, "isDefault": true, "isDone": false,
                 "createdAt": NOW_ISO},
                {"id": "proj-a-in-progress", "projectId": "proj-a", "name": "In Progress",
                 "color": "#F59E0B", "position": 1, "isDefault": false, "isDone": false,
                 "createdAt": NOW_ISO},
                {"id": "proj-a-done", "projectId": "proj-a", "name": "Done",
                 "color": "#22c55e", "position": 2, "isDefault": false, "isDone": true,
                 "createdAt": NOW_ISO}
            ])
        );

        let types: Vec<StatusType> = projects::statuses(conn, "proj-a")?
            .iter()
            .map(|status| status.status_type())
            .collect();
        assert_eq!(
            types,
            vec![StatusType::Todo, StatusType::InProgress, StatusType::Done]
        );
        assert_eq!(
            projects::get(conn, "proj-a")?.map(|project| project.position),
            Some(5)
        );
        assert_eq!(
            outbox_of(conn, "proj-a"),
            vec![("project".to_owned(), "upsert".to_owned())]
        );

        // No id given: a nanoid is minted.
        let minted = projects::create(
            conn,
            &NewProject {
                id: None,
                ..new_project("unused", None)
            },
            DEVICE,
            NOW,
        )?
        .acknowledge();
        assert_eq!(minted.len(), 21);
        assert!(
            minted
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        );
        assert!(projects::get(conn, &minted)?.is_some());
        Ok(())
    })
    .expect("the create");
}

#[test]
fn a_custom_list_mints_project_order_ids_and_derives_the_two_flags_from_the_type() {
    let db = open("projects-custom");
    db.call_blocking(|conn| {
        let custom = [
            status(None, "Backlog", StatusType::Todo, 0),
            status(None, "Later", StatusType::Todo, 1),
            status(None, "Doing", StatusType::InProgress, 2),
            status(None, "Shipped", StatusType::Done, 3),
        ];
        projects::create(conn, &new_project("proj-c", Some(&custom)), DEVICE, NOW)?;

        let statuses = payload_of(conn, "project", "proj-c")["statuses"].clone();
        let summary: Vec<(String, bool, bool)> = statuses
            .as_array()
            .expect("statuses")
            .iter()
            .map(|status| {
                (
                    status["id"].as_str().unwrap_or_default().to_owned(),
                    status["isDefault"].as_bool().unwrap_or_default(),
                    status["isDone"].as_bool().unwrap_or_default(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("proj-c-0".to_owned(), true, false),
                ("proj-c-1".to_owned(), false, false),
                ("proj-c-2".to_owned(), false, false),
                ("proj-c-3".to_owned(), false, true),
            ]
        );
        assert!(
            statuses
                .as_array()
                .is_some_and(|all| all.iter().all(|status| status.get("type").is_none())),
            "StatusSyncSchema carries no type"
        );
        Ok(())
    })
    .expect("the custom create");
}

#[test]
fn an_invalid_create_writes_nothing() {
    let db = open("projects-invalid");
    db.call_blocking(|conn| {
        let one = [status(None, "Only", StatusType::Todo, 0)];
        assert!(projects::create(conn, &new_project("p1", Some(&one)), DEVICE, NOW).is_err());
        let blank = NewProject {
            name: "  ",
            ..new_project("p2", None)
        };
        assert!(projects::create(conn, &blank, DEVICE, NOW).is_err());
        let bad_color = NewProject {
            color: Some("#888"),
            ..new_project("p3", None)
        };
        assert!(projects::create(conn, &bad_color, DEVICE, NOW).is_err());

        assert_eq!(outbox_total(conn), 0);
        assert!(projects::list(conn, true)?.is_empty());
        Ok(())
    })
    .expect("the refusals");
}

#[test]
fn an_edit_ticks_the_document_clock_and_each_changed_field_and_keeps_unknown_keys() {
    let db = open("projects-edit");
    db.call_blocking(|conn| {
        seed(
            conn,
            "project",
            "proj-e",
            json!({
                "name": "Agent Test Old", "description": "Before", "color": "#0ea5e9",
                "position": 1, "futureKey": {"kept": true},
                "clock": {"device-b": 3},
                "fieldClocks": {"name": {"device-b": 1}, "color": {"device-b": 2}}
            }),
        );

        let edit = ProjectEdit {
            name: Some("Agent Test New"),
            description: Some(None),
            ..ProjectEdit::default()
        };
        projects::update(conn, "proj-e", &edit, DEVICE, NOW)?;

        let payload = payload_of(conn, "project", "proj-e");
        assert_eq!(payload["name"], json!("Agent Test New"));
        assert_eq!(
            payload["description"],
            Value::Null,
            "a clear is an explicit null"
        );
        assert_eq!(payload["futureKey"], json!({"kept": true}), "§13.2 rule 3");
        assert_eq!(payload["clock"], json!({"device-b": 3, "device-a": 1}));
        let clocks = &payload["fieldClocks"];
        assert_eq!(clocks["name"], json!({"device-b": 1, "device-a": 1}));
        assert_eq!(clocks["description"], json!({"device-a": 1}));
        assert_eq!(clocks["modifiedAt"], json!({"device-a": 1}));
        assert_eq!(clocks["color"], json!({"device-b": 2}), "untouched");
        assert_eq!(outbox_of(conn, "proj-e").len(), 1);

        let project = projects::get(conn, "proj-e")?.expect("the project");
        assert_eq!(
            (project.name.as_str(), project.description),
            ("Agent Test New", None)
        );
        Ok(())
    })
    .expect("the edit");
}

#[test]
fn an_edit_resending_an_unchanged_field_leaves_its_clock_alone() {
    // A phone form saves every field; only the changed one may win a merge,
    // or a rename would beat desktop's concurrent description edit.
    let db = open("projects-edit-unchanged");
    db.call_blocking(|conn| {
        seed(
            conn,
            "project",
            "proj-u",
            json!({
                "name": "Agent Test Old", "description": "Before", "color": "#0ea5e9",
                "icon": "📦", "position": 1, "archivedAt": "2025-01-01T00:00:00.000Z",
                "clock": {"device-b": 3},
                "fieldClocks": {"description": {"device-b": 2}, "icon": {"device-b": 2}}
            }),
        );
        let edit = ProjectEdit {
            name: Some("Agent Test Renamed"),
            description: Some(Some("Before")),
            color: Some("#0ea5e9"),
            icon: Some(Some("📦")),
            statuses: None,
        };
        projects::update(conn, "proj-u", &edit, DEVICE, NOW)?;
        projects::set_archived(conn, "proj-u", true, DEVICE, NOW)?;

        let payload = payload_of(conn, "project", "proj-u");
        let clocks = &payload["fieldClocks"];
        assert_eq!(clocks["name"], json!({"device-a": 1}));
        assert_eq!(clocks["description"], json!({"device-b": 2}), "unchanged");
        assert_eq!(clocks["icon"], json!({"device-b": 2}), "unchanged");
        assert!(
            clocks.get("color").is_none_or(Value::is_null),
            "unchanged: {clocks}"
        );
        assert_eq!(
            payload["archivedAt"],
            json!("2025-01-01T00:00:00.000Z"),
            "archiving an archived project keeps its first instant"
        );
        Ok(())
    })
    .expect("the edit");
}

#[test]
fn a_status_reconcile_keeps_drops_adds_and_retypes_and_leaves_tasks_alone() {
    let db = open("projects-reconcile");
    db.call_blocking(|conn| {
        seed(
            conn,
            "project",
            "proj-r",
            json!({
                "name": "Agent Test R", "color": "#0ea5e9", "clock": {"device-b": 1},
                "statuses": [
                    {"id": "proj-r-todo", "projectId": "proj-r", "name": "To Do",
                     "color": "#6b7280", "position": 0, "isDefault": true, "isDone": false,
                     "createdAt": "2026-01-01T00:00:00.000Z", "futureStatusKey": 7},
                    {"id": "proj-r-in-progress", "name": "In Progress", "color": "#F59E0B",
                     "position": 1, "isDefault": false, "isDone": false},
                    {"id": "proj-r-done", "name": "Done", "color": "#22c55e", "position": 2,
                     "isDefault": false, "isDone": true}
                ]
            }),
        );
        seed_task(
            conn,
            "task-on-dropped",
            "proj-r",
            json!({"statusId": "proj-r-done"}),
        );

        // Rename + recolour + move the todo to the end; retype in-progress into
        // the done column at the front; drop the old done; add a new todo.
        let inputs = [
            status(Some("proj-r-in-progress"), "Shipped", StatusType::Done, 1),
            status(None, "Inbox", StatusType::Todo, 0),
            status(Some("proj-r-todo"), "Queued", StatusType::Todo, 2),
        ];
        let edit = ProjectEdit {
            statuses: Some(&inputs),
            ..ProjectEdit::default()
        };
        projects::update(conn, "proj-r", &edit, DEVICE, NOW)?;

        let payload = payload_of(conn, "project", "proj-r");
        let statuses = payload["statuses"].as_array().expect("statuses");
        assert_eq!(statuses.len(), 3);
        assert_eq!(
            statuses[0],
            json!({"id": "proj-r-in-progress", "name": "Shipped", "color": "#0ea5e9",
                   "position": 1, "isDefault": false, "isDone": true})
        );
        let added = &statuses[1];
        assert_eq!(
            added["id"].as_str().map(str::len),
            Some(21),
            "a fresh nanoid"
        );
        assert_eq!(
            (&added["isDefault"], &added["isDone"], &added["createdAt"]),
            (&json!(true), &json!(false), &json!(NOW_ISO))
        );
        assert_eq!(
            statuses[2],
            json!({"id": "proj-r-todo", "projectId": "proj-r", "name": "Queued",
                   "color": "#0ea5e9", "position": 2, "isDefault": false, "isDone": false,
                   "createdAt": "2026-01-01T00:00:00.000Z", "futureStatusKey": 7}),
            "modelled keys rewritten, every other key kept"
        );
        assert!(
            payload["fieldClocks"].get("statuses").is_none(),
            "not a PROJECT_SYNCABLE_FIELDS entry"
        );

        // Desktop leaves a task on a dropped status alone; so does this.
        assert_eq!(
            payload_of(conn, "task", "task-on-dropped")["statusId"],
            json!("proj-r-done")
        );
        assert!(outbox_of(conn, "task-on-dropped").is_empty());

        let projected: Vec<String> = projects::statuses(conn, "proj-r")?
            .into_iter()
            .map(|status| status.name)
            .collect();
        assert_eq!(projected, vec!["Inbox", "Shipped", "Queued"]);
        Ok(())
    })
    .expect("the reconcile");
}

#[test]
fn archive_and_unarchive_write_the_instant_and_the_explicit_null_and_the_inbox_refuses() {
    let db = open("projects-archive");
    db.call_blocking(|conn| {
        seed_inbox(conn);
        projects::create(conn, &new_project("proj-a", None), DEVICE, NOW)?;

        projects::set_archived(conn, "proj-a", true, DEVICE, NOW + 1)?;
        let payload = payload_of(conn, "project", "proj-a");
        assert_eq!(payload["archivedAt"], json!("2025-10-09T08:53:20.001Z"));
        assert_eq!(payload["fieldClocks"]["archivedAt"], json!({"device-a": 2}));
        assert!(
            projects::list(conn, false)?
                .iter()
                .all(|p| p.id != "proj-a")
        );

        projects::set_archived(conn, "proj-a", false, DEVICE, NOW + 2)?;
        assert_eq!(
            payload_of(conn, "project", "proj-a")["archivedAt"],
            Value::Null
        );
        assert!(
            projects::list(conn, false)?
                .iter()
                .any(|p| p.id == "proj-a")
        );

        assert!(projects::set_archived(conn, "inbox", true, DEVICE, NOW).is_err());
        assert!(outbox_of(conn, "inbox").is_empty());
        Ok(())
    })
    .expect("the archive");
}

#[test]
fn a_reorder_writes_each_position_with_its_own_outbox_row_and_refuses_an_unknown_id() {
    let db = open("projects-reorder");
    db.call_blocking(|conn| {
        projects::create(conn, &new_project("proj-1", None), DEVICE, NOW)?;
        projects::create(conn, &new_project("proj-2", None), DEVICE, NOW)?;

        assert!(projects::reorder(conn, &[("proj-1", 9), ("ghost", 0)], DEVICE, NOW).is_err());
        assert_eq!(payload_of(conn, "project", "proj-1")["position"], json!(0));

        let written = projects::reorder(conn, &[("proj-2", 0), ("proj-1", 1)], DEVICE, NOW)?;
        assert_eq!(written.len(), 2);
        assert_eq!(
            projects::list(conn, false)?
                .into_iter()
                .map(|project| project.id)
                .collect::<Vec<_>>(),
            vec!["proj-2", "proj-1"]
        );
        assert_eq!(
            payload_of(conn, "project", "proj-1")["fieldClocks"]["position"],
            json!({"device-a": 2})
        );
        assert_eq!(outbox_of(conn, "proj-1").len(), 1, "collapsed per item");
        assert_eq!(outbox_of(conn, "proj-2").len(), 1);
        Ok(())
    })
    .expect("the reorder");
}

#[test]
fn the_home_note_is_set_and_then_cleared_with_an_explicit_null() {
    let db = open("projects-home");
    db.call_blocking(|conn| {
        projects::create(conn, &new_project("proj-h", None), DEVICE, NOW)?;
        projects::set_home_note(conn, "proj-h", Some("note-home"), DEVICE, NOW)?;
        assert_eq!(
            projects::get(conn, "proj-h")?.and_then(|p| p.home_note_id),
            Some("note-home".to_owned())
        );
        projects::set_home_note(conn, "proj-h", None, DEVICE, NOW)?;
        let payload = payload_of(conn, "project", "proj-h");
        assert_eq!(payload["homeNoteId"], Value::Null);
        assert_eq!(payload["fieldClocks"]["homeNoteId"], json!({"device-a": 3}));
        Ok(())
    })
    .expect("the home note");
}

#[test]
fn a_delete_tombstones_every_task_with_its_own_outbox_row_and_the_inbox_refuses() {
    let db = open("projects-delete");
    db.call_blocking(|conn| {
        seed_inbox(conn);
        projects::create(conn, &new_project("proj-d", None), DEVICE, NOW)?;
        seed_task(conn, "t-parent", "proj-d", json!({}));
        seed_task(conn, "t-sub", "proj-d", json!({"parentId": "t-parent"}));
        seed_task(
            conn,
            "t-done",
            "proj-d",
            json!({"completedAt": "2026-01-01T00:00:00.000Z", "archivedAt": "2026-01-02T00:00:00.000Z"}),
        );
        seed_task(conn, "t-elsewhere", "inbox", json!({}));

        assert!(projects::delete(conn, "inbox", TaskDisposition::Delete, DEVICE, NOW).is_err());

        projects::delete(conn, "proj-d", TaskDisposition::Delete, DEVICE, NOW)?.acknowledge();

        assert!(projects::get(conn, "proj-d")?.is_none());
        assert_eq!(
            outbox_of(conn, "proj-d"),
            vec![("project".to_owned(), "delete".to_owned())]
        );
        for task in ["t-parent", "t-sub", "t-done"] {
            assert_eq!(
                outbox_of(conn, task),
                vec![("task".to_owned(), "delete".to_owned())],
                "{task}"
            );
            let deleted: Option<i64> = conn
                .query_row(
                    "SELECT deleted_at FROM tasks WHERE id = ?1",
                    params![task],
                    |row| row.get(0),
                )
                .expect("the task row");
            assert!(deleted.is_some(), "{task}");
        }
        assert!(outbox_of(conn, "t-elsewhere").is_empty());
        Ok(())
    })
    .expect("the delete");
}

#[test]
fn a_delete_can_move_the_tasks_to_the_inbox_onto_the_equivalent_status() {
    let db = open("projects-delete-move");
    db.call_blocking(|conn| {
        seed_inbox(conn);
        projects::create(conn, &new_project("proj-m", None), DEVICE, NOW)?;
        seed_task(conn, "t-todo", "proj-m", json!({"statusId": "proj-m-todo"}));
        seed_task(
            conn,
            "t-doing",
            "proj-m",
            json!({"statusId": "proj-m-in-progress"}),
        );
        seed_task(conn, "t-done", "proj-m", json!({"statusId": "proj-m-done"}));
        seed_task(conn, "t-none", "proj-m", json!({}));
        seed_task(conn, "t-sub", "proj-m", json!({"parentId": "t-todo"}));

        projects::delete(conn, "proj-m", TaskDisposition::MoveToInbox, DEVICE, NOW)?;

        for (task, status) in [
            ("t-todo", "inbox-todo"),
            ("t-doing", "inbox-in-progress"),
            ("t-done", "inbox-done"),
            ("t-none", "inbox-todo"),
            ("t-sub", "inbox-todo"),
        ] {
            let payload = payload_of(conn, "task", task);
            assert_eq!(payload["projectId"], json!("inbox"), "{task}");
            assert_eq!(payload["statusId"], json!(status), "{task}");
            assert_eq!(
                payload["fieldClocks"]["projectId"],
                json!({"device-b": 1, "device-a": 1}),
                "{task}"
            );
            assert_eq!(
                outbox_of(conn, task),
                vec![("task".to_owned(), "upsert".to_owned())],
                "{task}"
            );
        }
        assert_eq!(
            payload_of(conn, "task", "t-sub")["parentId"],
            json!("t-todo")
        );
        assert!(projects::get(conn, "proj-m")?.is_none());
        Ok(())
    })
    .expect("the move");
}

#[test]
fn moving_tasks_with_no_inbox_writes_nothing() {
    let db = open("projects-delete-no-inbox");
    db.call_blocking(|conn| {
        projects::create(conn, &new_project("proj-n", None), DEVICE, NOW)?;
        seed_task(conn, "t-1", "proj-n", json!({}));
        let before = outbox_total(conn);
        assert!(
            projects::delete(conn, "proj-n", TaskDisposition::MoveToInbox, DEVICE, NOW).is_err()
        );
        assert_eq!(outbox_total(conn), before);
        assert!(projects::get(conn, "proj-n")?.is_some());
        Ok(())
    })
    .expect("the refusal");
}

#[test]
fn a_summary_counts_open_done_and_overdue_tasks_without_archived_ones() {
    let db = open("projects-summary");
    db.call_blocking(|conn| {
        seed_inbox(conn);
        projects::create(conn, &new_project("proj-s", None), DEVICE, NOW)?;
        seed_task(conn, "t-open", "proj-s", json!({}));
        seed_task(conn, "t-late", "proj-s", json!({"dueDate": "2026-04-01"}));
        seed_task(
            conn,
            "t-done-late",
            "proj-s",
            json!({"dueDate": "2026-04-01", "completedAt": "2026-04-02T00:00:00.000Z"}),
        );
        seed_task(
            conn,
            "t-archived",
            "proj-s",
            json!({"archivedAt": "2026-04-02T00:00:00.000Z"}),
        );

        let summaries = projects::summaries(conn, false, "2026-04-10")?;
        let counts: Vec<(String, i64, i64, i64)> = summaries
            .into_iter()
            .map(|s| {
                (
                    s.project_id,
                    s.task_count,
                    s.completed_count,
                    s.overdue_count,
                )
            })
            .collect();
        assert_eq!(
            counts,
            vec![
                ("inbox".to_owned(), 0, 0, 0),
                ("proj-s".to_owned(), 3, 1, 1),
            ]
        );
        Ok(())
    })
    .expect("the summary");
}
