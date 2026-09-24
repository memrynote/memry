//! The desktop-parity task write surface (spec 004 TP020), part one: create,
//! duplicate, project/status/parent changes, reorder, delete with subtasks
//! and the single-field setters. Against real SQLite, seeded through the real
//! apply path.
//!
//! | Test                                                   | Desktop reference                  |
//! | ------------------------------------------------------ | ---------------------------------- |
//! | create resolves the default status and next position   | `createTask`, `getNextTaskPosition`|
//! | create writes every detail field                       | `TaskCreateInput`                  |
//! | create refuses a bad parent                            | `validateSubtaskRelationship`      |
//! | a project move resolves the equivalent status          | `bulkMoveToProject`, drag handlers |
//! | set_parent enforces one level and one project          | `demoteToSubtask`, `promoteToTask` |
//! | set_status stamps and clears completedAt               | `bulkChangeStatus`                 |
//! | duplicate names the copy and keeps subtask titles      | `duplicateTask`, `duplicateSubtask`|
//! | reorder writes positions in one transaction            | `reorderTasks`                     |
//! | delete cascades or promotes subtasks                   | `deleteParentWithSubtasks`         |
//! | the setters tick only syncable field clocks            | §6.7                               |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::tasks::{self, NewTask, SubtaskDisposal, TaskDetails};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
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

/// A project with desktop's three default statuses: `<p>-todo` (default, 0),
/// `<p>-doing` (1) and `<p>-done` (2, done).
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

fn new_task<'a>(id: &'a str, project_id: &'a str) -> NewTask<'a> {
    NewTask {
        id,
        title: "Ship the spec",
        project_id,
        due_date: None,
        due_time: None,
        priority: 0,
        repeat_config: None,
        tags: &[],
    }
}

fn create(conn: &Connection, id: &str, project_id: &str, details: TaskDetails<'_>) {
    tasks::create_detailed(conn, &new_task(id, project_id), &details, DEVICE, NOW).expect("create");
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

#[test]
fn create_resolves_the_default_status_and_the_next_position_per_scope() {
    let db = open("tw-create-default");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", "pa", TaskDetails::default());
        create(conn, "t2", "pa", TaskDetails::default());
        create(
            conn,
            "s1",
            "pa",
            TaskDetails {
                parent_id: Some("t1"),
                ..TaskDetails::default()
            },
        );
        // Plain `create` is the same path with no details.
        tasks::create(conn, &new_task("t3", "pa"), DEVICE, NOW)?;

        let t1 = payload_of(conn, "t1");
        assert_eq!(t1["statusId"], json!("pa-todo"));
        assert_eq!(t1["position"], json!(0));
        assert_eq!(payload_of(conn, "t2")["position"], json!(1));
        assert_eq!(payload_of(conn, "t3")["position"], json!(2));
        // Subtasks count positions under their own parent.
        let s1 = payload_of(conn, "s1");
        assert_eq!(s1["position"], json!(0));
        assert_eq!(s1["parentId"], json!("t1"));
        // Absent rather than null: a create has nothing to clear (§13.4).
        assert!(t1.get("parentId").is_none());
        assert!(t1.get("description").is_none());
        assert_eq!(outbox_ops(conn, "t1"), ["upsert"]);
        Ok(())
    })
    .expect("the creates");
}

#[test]
fn create_writes_every_detail_field_and_seeds_all_fifteen_field_clocks() {
    let db = open("tw-create-full");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        let repeat = json!({"frequency": "daily", "interval": 1, "endType": "never",
                            "endDate": null, "completedCount": 0,
                            "createdAt": "2026-04-16T09:00:00.000Z"});
        let tags = vec!["work".to_owned(), "Work".to_owned()];
        let notes = vec!["note-1".to_owned()];
        let canvases = vec!["canvas-1".to_owned()];
        let task = NewTask {
            due_date: Some("2026-04-20"),
            due_time: Some("09:30"),
            priority: 3,
            repeat_config: Some(&repeat),
            tags: &tags,
            ..new_task("t1", "pa")
        };
        tasks::create_detailed(
            conn,
            &task,
            &TaskDetails {
                description: Some("# Notes"),
                status_id: Some("pa-doing"),
                start_date: Some("2026-04-18"),
                repeat_from: Some("completion"),
                linked_note_ids: &notes,
                linked_canvas_ids: &canvases,
                source_note_id: Some("note-src"),
                position: Some(7),
                ..TaskDetails::default()
            },
            DEVICE,
            NOW,
        )?;

        let t1 = payload_of(conn, "t1");
        assert_eq!(t1["description"], json!("# Notes"));
        assert_eq!(t1["statusId"], json!("pa-doing"));
        assert_eq!(t1["startDate"], json!("2026-04-18"));
        assert_eq!(t1["dueDate"], json!("2026-04-20"));
        assert_eq!(t1["dueTime"], json!("09:30"));
        assert_eq!(t1["priority"], json!(3));
        assert_eq!(t1["repeatConfig"], repeat);
        assert_eq!(t1["repeatFrom"], json!("completion"));
        assert_eq!(t1["tags"], json!(["work"]));
        assert_eq!(t1["linkedNoteIds"], json!(["note-1"]));
        assert_eq!(t1["linkedCanvasIds"], json!(["canvas-1"]));
        assert_eq!(t1["sourceNoteId"], json!("note-src"));
        assert_eq!(t1["position"], json!(7));
        assert_eq!(t1["clock"], json!({"device-a": 1}));
        let clocks = t1["fieldClocks"].as_object().expect("field clocks");
        assert_eq!(clocks.len(), 15);
        assert!(
            clocks
                .values()
                .all(|clock| *clock == json!({"device-a": 1}))
        );

        // An unknown status id resolves to the default, not to a dangling id.
        create(
            conn,
            "t2",
            "pa",
            TaskDetails {
                status_id: Some("gone"),
                ..TaskDetails::default()
            },
        );
        assert_eq!(payload_of(conn, "t2")["statusId"], json!("pa-todo"));
        Ok(())
    })
    .expect("the create");
}

#[test]
fn create_refuses_a_parent_that_breaks_the_subtask_rules() {
    let db = open("tw-create-parent");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        seed_project(conn, "pb");
        create(conn, "t1", "pa", TaskDetails::default());
        create(
            conn,
            "s1",
            "pa",
            TaskDetails {
                parent_id: Some("t1"),
                ..TaskDetails::default()
            },
        );
        let with_parent = |parent| TaskDetails {
            parent_id: Some(parent),
            ..TaskDetails::default()
        };
        let attempt = |id, project, parent| {
            tasks::create_detailed(
                conn,
                &new_task(id, project),
                &with_parent(parent),
                DEVICE,
                NOW,
            )
        };
        assert!(attempt("x1", "pa", "x1").is_err(), "its own parent");
        assert!(attempt("x2", "pa", "s1").is_err(), "a subtask's subtask");
        assert!(attempt("x3", "pb", "t1").is_err(), "another project");
        assert!(attempt("x4", "pa", "missing").is_err(), "no such parent");
        for id in ["x1", "x2", "x3", "x4"] {
            assert!(outbox_ops(conn, id).is_empty(), "{id} wrote nothing");
        }
        Ok(())
    })
    .expect("the refusals");
}

#[test]
fn a_project_move_resolves_the_equivalent_status_and_brings_the_subtasks() {
    let db = open("tw-move");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        seed_project(conn, "pb");
        // A project with no in-progress column: in-progress falls back to todo.
        apply(
            conn,
            "project",
            "pc",
            json!({"name": "pc", "color": "#000", "clock": {"device-b": 1}, "statuses": [
                {"id": "pc-open", "name": "Open", "color": "#000", "position": 0, "isDefault": true},
                {"id": "pc-closed", "name": "Closed", "color": "#000", "position": 1, "isDone": true}
            ]}),
        );
        create(
            conn,
            "t1",
            "pa",
            TaskDetails {
                status_id: Some("pa-doing"),
                ..TaskDetails::default()
            },
        );
        create(
            conn,
            "s1",
            "pa",
            TaskDetails {
                parent_id: Some("t1"),
                ..TaskDetails::default()
            },
        );

        let write = tasks::set_project(conn, "t1", "pb", DEVICE, NOW + 1_000)?;
        assert_eq!(write.changed_ids(), ["t1", "s1"]);
        let t1 = payload_of(conn, "t1");
        assert_eq!(t1["projectId"], json!("pb"));
        assert_eq!(t1["statusId"], json!("pb-doing"));
        assert_eq!(t1["clock"], json!({"device-a": 2}));
        assert_eq!(t1["fieldClocks"]["projectId"], json!({"device-a": 2}));
        assert_eq!(t1["fieldClocks"]["statusId"], json!({"device-a": 2}));
        assert_eq!(t1["fieldClocks"]["title"], json!({"device-a": 1}));
        let s1 = payload_of(conn, "s1");
        assert_eq!(s1["projectId"], json!("pb"));
        assert_eq!(s1["statusId"], json!("pb-todo"));
        assert_eq!(
            write.changed[0].fields,
            vec![
                ("projectId".to_owned(), json!("pa")),
                ("statusId".to_owned(), json!("pa-doing"))
            ]
        );
        assert_eq!(outbox_ops(conn, "s1"), ["upsert"], "collapsed to one row");

        tasks::set_project(conn, "t1", "pc", DEVICE, NOW + 2_000)?;
        assert_eq!(payload_of(conn, "t1")["statusId"], json!("pc-open"));

        assert!(tasks::set_project(conn, "t1", "missing", DEVICE, NOW).is_err());
        Ok(())
    })
    .expect("the move");
}

#[test]
fn set_parent_enforces_one_level_and_one_project_and_none_promotes() {
    let db = open("tw-parent");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        seed_project(conn, "pb");
        for id in ["t1", "t2", "t3"] {
            create(conn, id, "pa", TaskDetails::default());
        }
        create(conn, "other", "pb", TaskDetails::default());

        tasks::set_parent(conn, "t2", Some("t1"), DEVICE, NOW + 1_000)?;
        let t2 = payload_of(conn, "t2");
        assert_eq!(t2["parentId"], json!("t1"));
        assert_eq!(t2["fieldClocks"]["parentId"], json!({"device-a": 2}));

        assert!(tasks::set_parent(conn, "t1", Some("t1"), DEVICE, NOW).is_err());
        assert!(tasks::set_parent(conn, "t3", Some("t2"), DEVICE, NOW).is_err());
        assert!(tasks::set_parent(conn, "t1", Some("t3"), DEVICE, NOW).is_err());
        assert!(tasks::set_parent(conn, "t3", Some("other"), DEVICE, NOW).is_err());

        tasks::set_parent(conn, "t2", None, DEVICE, NOW + 2_000)?;
        assert_eq!(payload_of(conn, "t2")["parentId"], Value::Null);
        Ok(())
    })
    .expect("the parent rules");
}

#[test]
fn set_status_stamps_completed_at_on_done_and_clears_it_off_done() {
    let db = open("tw-status");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", "pa", TaskDetails::default());

        tasks::set_status(conn, "t1", "pa-done", DEVICE, NOW + 1_000)?;
        let t1 = payload_of(conn, "t1");
        assert_eq!(t1["statusId"], json!("pa-done"));
        assert_eq!(t1["completedAt"], json!("2025-10-09T08:53:21.000Z"));
        assert_eq!(t1["fieldClocks"]["completedAt"], json!({"device-a": 2}));

        let write = tasks::set_status(conn, "t1", "pa-doing", DEVICE, NOW + 2_000)?;
        let t1 = payload_of(conn, "t1");
        assert_eq!(t1["statusId"], json!("pa-doing"));
        assert_eq!(t1["completedAt"], Value::Null);
        assert_eq!(
            write.changed[0].fields,
            vec![
                ("statusId".to_owned(), json!("pa-done")),
                ("completedAt".to_owned(), json!("2025-10-09T08:53:21.000Z"))
            ]
        );
        assert!(tasks::set_status(conn, "t1", "missing", DEVICE, NOW).is_err());
        Ok(())
    })
    .expect("the status changes");
}

#[test]
fn duplicate_names_the_copy_like_desktop_and_optionally_copies_subtasks() {
    let db = open("tw-duplicate");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        let tags = vec!["work".to_owned()];
        tasks::create_detailed(
            conn,
            &NewTask {
                tags: &tags,
                due_date: Some("2026-04-20"),
                ..new_task("t1", "pa")
            },
            &TaskDetails {
                source_note_id: Some("note-src"),
                position: Some(4),
                ..TaskDetails::default()
            },
            DEVICE,
            NOW,
        )?;
        for id in ["s1", "s2"] {
            create(
                conn,
                id,
                "pa",
                TaskDetails {
                    parent_id: Some("t1"),
                    ..TaskDetails::default()
                },
            );
        }
        tasks::set_title(conn, "s2", "Second", DEVICE, NOW)?;
        tasks::set_status(conn, "t1", "pa-done", DEVICE, NOW)?;

        let write = tasks::duplicate(conn, "t1", true, DEVICE, NOW + 1_000)?;
        assert_eq!(write.created.len(), 3);
        let copy_id = &write.created[0];
        assert_eq!(copy_id.len(), tasks::TASK_ID_LEN);
        let copy = payload_of(conn, copy_id);
        assert_eq!(copy["title"], json!("Copy of Ship the spec"));
        assert_eq!(copy["position"], json!(5));
        assert_eq!(copy["tags"], json!(["work"]));
        assert_eq!(copy["dueDate"], json!("2026-04-20"));
        assert_eq!(
            copy["statusId"],
            json!("pa-done"),
            "duplicateTask copies the status"
        );
        assert!(copy.get("completedAt").is_none());
        assert!(copy.get("sourceNoteId").is_none());
        assert_eq!(copy["clock"], json!({"device-a": 1}));
        let second = payload_of(conn, &write.created[2]);
        assert_eq!(second["title"], json!("Second"));
        assert_eq!(second["parentId"], json!(copy_id));
        assert_eq!(outbox_ops(conn, copy_id), ["upsert"]);

        let alone = tasks::duplicate(conn, "t1", false, DEVICE, NOW + 2_000)?;
        assert_eq!(alone.created.len(), 1);
        Ok(())
    })
    .expect("the duplicate");
}

#[test]
fn reorder_writes_every_position_in_one_transaction() {
    let db = open("tw-reorder");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        for id in ["t1", "t2", "t3"] {
            create(conn, id, "pa", TaskDetails::default());
        }
        let ids = vec!["t3".to_owned(), "t1".to_owned(), "t2".to_owned()];
        let write = tasks::reorder(conn, &ids, &[0, 1, 2], DEVICE, NOW + 1_000)?;
        assert_eq!(write.changed_ids(), ["t3", "t1", "t2"]);
        assert_eq!(payload_of(conn, "t3")["position"], json!(0));
        assert_eq!(payload_of(conn, "t1")["position"], json!(1));
        assert_eq!(
            payload_of(conn, "t1")["fieldClocks"]["position"],
            json!({"device-a": 2})
        );
        assert!(tasks::reorder(conn, &ids, &[0], DEVICE, NOW).is_err());
        // A failing entry rolls back the whole reorder.
        let with_missing = vec!["t1".to_owned(), "missing".to_owned()];
        assert!(tasks::reorder(conn, &with_missing, &[9, 9], DEVICE, NOW).is_err());
        assert_eq!(payload_of(conn, "t1")["position"], json!(1));
        Ok(())
    })
    .expect("the reorder");
}

#[test]
fn delete_cascades_to_subtasks_or_promotes_them() {
    let db = open("tw-delete");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        for (parent, children) in [("t1", ["a1", "a2"]), ("t2", ["b1", "b2"])] {
            create(conn, parent, "pa", TaskDetails::default());
            for child in children {
                create(
                    conn,
                    child,
                    "pa",
                    TaskDetails {
                        parent_id: Some(parent),
                        ..TaskDetails::default()
                    },
                );
            }
        }

        let cascade =
            tasks::delete_with_subtasks(conn, "t1", SubtaskDisposal::Delete, DEVICE, NOW + 1_000)?;
        assert_eq!(cascade.deleted, ["a1", "a2", "t1"]);
        assert!(deleted(conn, "t1") && deleted(conn, "a1") && deleted(conn, "a2"));
        assert_eq!(outbox_ops(conn, "a1"), ["delete"]);

        let promote =
            tasks::delete_with_subtasks(conn, "t2", SubtaskDisposal::Promote, DEVICE, NOW + 1_000)?;
        assert_eq!(promote.deleted, ["t2"]);
        assert_eq!(promote.changed_ids(), ["b1", "b2"]);
        assert!(deleted(conn, "t2") && !deleted(conn, "b1"));
        assert_eq!(payload_of(conn, "b1")["parentId"], Value::Null);
        assert_eq!(outbox_ops(conn, "b1"), ["upsert"]);
        assert!(
            tasks::delete_with_subtasks(conn, "t2", SubtaskDisposal::Delete, DEVICE, NOW).is_err()
        );
        Ok(())
    })
    .expect("the deletes");
}

#[test]
fn the_setters_write_explicit_nulls_and_tick_only_syncable_field_clocks() {
    let db = open("tw-setters");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", "pa", TaskDetails::default());
        let repeat = json!({"frequency": "weekly", "endType": "never", "futureKey": 1});

        tasks::set_description(conn, "t1", Some("body"), DEVICE, NOW + 1_000)?;
        tasks::set_start_date(conn, "t1", Some("2026-04-18"), DEVICE, NOW + 1_000)?;
        tasks::set_repeat(conn, "t1", Some(&repeat), Some("due"), DEVICE, NOW + 1_000)?;
        let t1 = payload_of(conn, "t1");
        assert_eq!(t1["description"], json!("body"));
        assert_eq!(t1["startDate"], json!("2026-04-18"));
        assert_eq!(t1["repeatConfig"], repeat, "written verbatim (D7)");
        assert_eq!(t1["repeatFrom"], json!("due"));
        assert_eq!(t1["fieldClocks"]["description"], json!({"device-a": 2}));
        // A field clock ticks from its own value, not from the document clock.
        assert_eq!(t1["fieldClocks"]["repeatConfig"], json!({"device-a": 2}));
        assert_eq!(t1["clock"], json!({"device-a": 4}));

        let before = payload_of(conn, "t1")["fieldClocks"].clone();
        let notes = vec!["note-1".to_owned()];
        tasks::set_linked_note_ids(conn, "t1", &notes, DEVICE, NOW + 2_000)?;
        tasks::set_linked_canvas_ids(conn, "t1", &notes, DEVICE, NOW + 2_000)?;
        let t1 = payload_of(conn, "t1");
        assert_eq!(t1["linkedNoteIds"], json!(["note-1"]));
        assert_eq!(t1["linkedCanvasIds"], json!(["note-1"]));
        assert_eq!(
            t1["fieldClocks"], before,
            "not in TASK_SYNCABLE_FIELDS (§6.7)"
        );
        assert_eq!(t1["clock"], json!({"device-a": 6}));

        tasks::set_description(conn, "t1", None, DEVICE, NOW + 3_000)?;
        tasks::set_repeat(conn, "t1", None, None, DEVICE, NOW + 3_000)?;
        let t1 = payload_of(conn, "t1");
        assert_eq!(t1["description"], Value::Null);
        assert_eq!(t1["repeatConfig"], Value::Null);
        assert_eq!(t1["repeatFrom"], Value::Null);
        Ok(())
    })
    .expect("the setters");
}
