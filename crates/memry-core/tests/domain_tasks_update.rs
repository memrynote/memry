//! Desktop's `updateTask` (`packages/domain-tasks/src/commands.ts`) as one
//! core write: every `TaskPatch` field against a real SQLite file, seeded
//! through the real apply path.
//!
//! | Test                                              | Desktop reference                     |
//! | ------------------------------------------------- | ------------------------------------- |
//! | every field lands in one outbox row               | `updateTask` + `TaskUpdateSchema`     |
//! | a cleared due time clears the duration            | `updates.dueTime === null`            |
//! | a cleared due date keeps the due time             | `updateTask` (no rule)                |
//! | a project change re-maps the status               | `getEquivalentStatus`                 |
//! | a done status completes and rolls the series      | `completedAtOnStatus`, `rollRepeatingSeries` |
//! | an open status reopens; an unknown one is null    | `completedAtOnStatus`, `resolveStatusId` |
//! | refusals write nothing                            | `PROJECT_MISSING_ERROR`, `INVALID_PARENT_ERROR` |
//! | `fields` patches by name; limits refuse           | `patchTaskFields`, `TASK_FIELD_LIMITS` |
//! | undo reverts an update                            | the registered undo                   |

use memry_core::api::errors::StorageError;
use memry_core::domain::calendar::LocalDateTime;
use memry_core::domain::tasks::{
    self, NewTask, Patch, TaskDetails, TaskPatch, TaskUpdate, UpdateRefusal,
};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use serde_json::{Map, Value, json};

const NOW: i64 = 1_760_000_000_000;
/// `NOW + 1_000` as the instant `completedAt` carries.
const AT: &str = "2025-10-09T08:53:21.000Z";
const DEVICE: &str = "device-a";

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-domain-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
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

fn create(conn: &Connection, id: &str, project_id: &str, repeat: Option<&Value>) {
    tasks::create_detailed(
        conn,
        &NewTask {
            id,
            title: "Water the plants",
            project_id,
            due_date: Some("2026-04-16"),
            due_time: Some("08:00"),
            priority: 2,
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

fn outbox_rows(conn: &Connection) -> Vec<(String, String)> {
    let mut statement = conn
        .prepare("SELECT item_id, op FROM outbox ORDER BY id")
        .expect("prepare");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

fn clear_outbox(conn: &Connection) {
    conn.execute("DELETE FROM outbox", []).expect("clear");
}

fn update(conn: &Connection, id: &str, patch: &TaskPatch) -> Result<TaskUpdate, StorageError> {
    Ok(tasks::update::apply(
        conn,
        id,
        patch,
        local("2026-04-16T12:00:00"),
        DEVICE,
        NOW + 1_000,
    )?
    .expect("an accepted update"))
}

fn weekly() -> Value {
    json!({
        "frequency": "weekly",
        "interval": 1,
        "daysOfWeek": [4],
        "endType": "never",
        "completedCount": 0,
        "createdAt": "2026-04-01T00:00:00.000Z"
    })
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn domain_tasks_update_writes_every_field_in_one_outbox_row() {
    let db = open("tu-all");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", "pa", None);
        clear_outbox(conn);

        let fields = Map::from_iter([("Effort".to_owned(), json!("high"))]);
        let done = update(
            conn,
            "t1",
            &TaskPatch {
                title: Some("Feed the cat".into()),
                description: Patch::Set("**now**".into()),
                priority: Some(4),
                due_date: Patch::Set("2026-05-01".into()),
                due_time: Patch::Set("09:30".into()),
                duration_minutes: Patch::Set(45),
                start_date: Patch::Set("2026-04-28".into()),
                repeat_config: Patch::Set(weekly()),
                repeat_from: Patch::Set("completion".into()),
                tags: Some(strings(&["home", "Home", "pets"])),
                linked_note_ids: Some(strings(&["n1"])),
                linked_canvas_ids: Some(strings(&["c1"])),
                fields: Some(fields),
                ..TaskPatch::default()
            },
        )?;

        let task = payload_of(conn, "t1");
        assert_eq!(task["title"], json!("Feed the cat"));
        assert_eq!(task["description"], json!("**now**"));
        assert_eq!(task["priority"], json!(4));
        assert_eq!(task["dueDate"], json!("2026-05-01"));
        assert_eq!(task["dueTime"], json!("09:30"));
        assert_eq!(task["durationMinutes"], json!(45));
        assert_eq!(task["startDate"], json!("2026-04-28"));
        assert_eq!(task["repeatConfig"], weekly());
        assert_eq!(task["repeatFrom"], json!("completion"));
        assert_eq!(task["tags"], json!(["home", "pets"]));
        assert_eq!(task["linkedNoteIds"], json!(["n1"]));
        assert_eq!(task["linkedCanvasIds"], json!(["c1"]));
        assert_eq!(
            Value::Object(memry_core::sync::versioned::plain(task.get("fields"))),
            json!({"Effort": "high"})
        );
        assert_eq!(task["fieldClocks"]["title"], json!({"device-a": 2}));
        assert_eq!(outbox_rows(conn), [("t1".into(), "upsert".into())]);
        assert_eq!(done.changed_fields.len(), 13, "{:?}", done.changed_fields);
        assert!(done.next_occurrence.is_none());

        // The same patch again changes nothing and queues nothing.
        clear_outbox(conn);
        let again = update(
            conn,
            "t1",
            &TaskPatch {
                title: Some("Feed the cat".into()),
                ..TaskPatch::default()
            },
        )?;
        assert!(again.write.is_empty());
        assert!(outbox_rows(conn).is_empty());
        Ok(())
    })
    .expect("the update");
}

#[test]
fn domain_tasks_update_clears_the_duration_with_the_due_time_only() {
    let db = open("tu-clear");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", "pa", None);
        update(
            conn,
            "t1",
            &TaskPatch {
                duration_minutes: Patch::Set(30),
                ..TaskPatch::default()
            },
        )?;

        update(
            conn,
            "t1",
            &TaskPatch {
                due_date: Patch::Clear,
                ..TaskPatch::default()
            },
        )?;
        let task = payload_of(conn, "t1");
        assert_eq!(task["dueDate"], Value::Null);
        assert_eq!(task["dueTime"], json!("08:00"), "desktop keeps the time");
        assert_eq!(task["durationMinutes"], json!(30));

        // A duration in the same patch loses to the cleared time.
        update(
            conn,
            "t1",
            &TaskPatch {
                due_time: Patch::Clear,
                duration_minutes: Patch::Set(60),
                description: Patch::Clear,
                ..TaskPatch::default()
            },
        )?;
        let task = payload_of(conn, "t1");
        assert_eq!(task["dueTime"], Value::Null);
        assert_eq!(task["durationMinutes"], Value::Null);
        Ok(())
    })
    .expect("the clears");
}

#[test]
fn domain_tasks_update_remaps_the_status_on_a_project_change() {
    let db = open("tu-project");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        seed_project(conn, "pb");
        create(conn, "t1", "pa", None);
        update(
            conn,
            "t1",
            &TaskPatch {
                status_id: Patch::Set("pa-doing".into()),
                ..TaskPatch::default()
            },
        )?;

        // The patch's own status loses to the equivalent one, as on desktop.
        let moved = update(
            conn,
            "t1",
            &TaskPatch {
                project_id: Some("pb".into()),
                status_id: Patch::Set("pb-todo".into()),
                ..TaskPatch::default()
            },
        )?;
        let task = payload_of(conn, "t1");
        assert_eq!(task["projectId"], json!("pb"));
        assert_eq!(task["statusId"], json!("pb-doing"));
        assert_eq!(moved.changed_fields, ["projectId", "statusId"]);
        Ok(())
    })
    .expect("the move");
}

#[test]
fn domain_tasks_update_to_a_done_status_completes_and_rolls_the_series() {
    let db = open("tu-roll");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", "pa", Some(&weekly()));
        clear_outbox(conn);

        let done = update(
            conn,
            "t1",
            &TaskPatch {
                status_id: Patch::Set("pa-done".into()),
                ..TaskPatch::default()
            },
        )?;
        let closed = payload_of(conn, "t1");
        assert_eq!(closed["statusId"], json!("pa-done"));
        assert_eq!(closed["completedAt"], json!(AT));
        assert_eq!(closed["repeatConfig"], Value::Null);

        let next = done.next_occurrence.clone().expect("a next occurrence");
        assert_eq!(next.due_date, "2026-04-23");
        assert_eq!(done.write.created, std::slice::from_ref(&next.id));
        let occurrence = payload_of(conn, &next.id);
        assert_eq!(occurrence["statusId"], json!("pa-todo"));
        assert_eq!(occurrence["repeatConfig"]["completedCount"], json!(1));
        assert_eq!(
            outbox_rows(conn),
            [
                ("t1".into(), "upsert".into()),
                (next.id.clone(), "upsert".into())
            ]
        );

        // Undo brings the occurrence back open and removes the next one.
        tasks::undo(conn, &done.write, DEVICE, NOW + 2_000)?;
        let reopened = payload_of(conn, "t1");
        assert_eq!(reopened["statusId"], json!("pa-todo"));
        assert_eq!(reopened["completedAt"], Value::Null);
        assert_eq!(reopened["repeatConfig"], weekly());
        let gone: bool = conn
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM tasks WHERE id = ?1",
                params![next.id],
                |row| row.get(0),
            )
            .expect("the projection row");
        assert!(gone);
        Ok(())
    })
    .expect("the roll");
}

#[test]
fn domain_tasks_update_reopens_on_an_open_status_and_nulls_an_unknown_one() {
    let db = open("tu-status");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", "pa", None);
        let done = update(
            conn,
            "t1",
            &TaskPatch {
                status_id: Patch::Set("pa-done".into()),
                ..TaskPatch::default()
            },
        )?;
        assert!(done.next_occurrence.is_none(), "not a repeating task");

        update(
            conn,
            "t1",
            &TaskPatch {
                status_id: Patch::Set("pa-doing".into()),
                ..TaskPatch::default()
            },
        )?;
        assert_eq!(payload_of(conn, "t1")["completedAt"], Value::Null);

        update(
            conn,
            "t1",
            &TaskPatch {
                status_id: Patch::Set("no-such-status".into()),
                ..TaskPatch::default()
            },
        )?;
        let task = payload_of(conn, "t1");
        assert_eq!(task["statusId"], Value::Null);
        assert_eq!(task["completedAt"], Value::Null);
        Ok(())
    })
    .expect("the status changes");
}

#[test]
fn domain_tasks_update_refusals_write_nothing() {
    let db = open("tu-refuse");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        seed_project(conn, "pb");
        create(conn, "t1", "pa", None);
        create(conn, "t2", "pb", None);
        clear_outbox(conn);
        let before = payload_of(conn, "t1");
        let refused = |id: &str, patch: TaskPatch| {
            tasks::update::apply(conn, id, &patch, local("2026-04-16T12:00:00"), DEVICE, NOW)
                .expect("no storage failure")
                .expect_err("a refusal")
        };

        let missing = refused(
            "t1",
            TaskPatch {
                title: Some("Renamed".into()),
                project_id: Some("nope".into()),
                ..TaskPatch::default()
            },
        );
        assert_eq!(missing, UpdateRefusal::ProjectMissing);
        assert_eq!(missing.error_key(), "errors:task.projectMissing");

        for parent in ["t1", "t2", "gone"] {
            let invalid = refused(
                "t1",
                TaskPatch {
                    title: Some("Renamed".into()),
                    parent_id: Patch::Set(parent.into()),
                    ..TaskPatch::default()
                },
            );
            assert_eq!(invalid, UpdateRefusal::InvalidParent, "{parent}");
            assert_eq!(invalid.error_key(), "errors:task.invalidParent");
        }
        assert_eq!(
            refused("gone", TaskPatch::default()),
            UpdateRefusal::NotFound
        );

        assert_eq!(payload_of(conn, "t1"), before);
        assert!(outbox_rows(conn).is_empty());
        Ok(())
    })
    .expect("the refusals");
}

#[test]
fn domain_tasks_update_patches_fields_by_name_and_holds_the_limits() {
    let db = open("tu-fields");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", "pa", None);
        let patch = |pairs: Vec<(&str, Value)>| TaskPatch {
            fields: Some(
                pairs
                    .into_iter()
                    .map(|(name, value)| (name.to_owned(), value))
                    .collect(),
            ),
            ..TaskPatch::default()
        };
        update(conn, "t1", &patch(vec![("A", json!(1)), ("B", json!("x"))]))?;
        update(
            conn,
            "t1",
            &patch(vec![("A", Value::Null), ("C", json!(true))]),
        )?;
        let fields = memry_core::sync::versioned::plain(payload_of(conn, "t1").get("fields"));
        assert_eq!(Value::Object(fields), json!({"B": "x", "C": true}));

        let too_many: Vec<(String, Value)> =
            (0..101).map(|i| (format!("f{i}"), json!(i))).collect();
        let long_text = "x".repeat(10_001);
        let long_list = vec![json!(1); 501];
        let wide_object: Map<String, Value> =
            (0..51).map(|i| (format!("k{i}"), json!(i))).collect();
        let cases = [
            TaskPatch {
                fields: Some(too_many.into_iter().collect()),
                ..TaskPatch::default()
            },
            patch(vec![("long", json!(long_text))]),
            patch(vec![("list", json!(long_list))]),
            patch(vec![("object", Value::Object(wide_object))]),
            patch(vec![("", json!(1))]),
            TaskPatch {
                title: Some(String::new()),
                ..TaskPatch::default()
            },
            TaskPatch {
                priority: Some(5),
                ..TaskPatch::default()
            },
            TaskPatch {
                due_date: Patch::Set("2026-02-30".into()),
                ..TaskPatch::default()
            },
            TaskPatch {
                due_time: Patch::Set("9:30".into()),
                ..TaskPatch::default()
            },
            TaskPatch {
                duration_minutes: Patch::Set(0),
                ..TaskPatch::default()
            },
            TaskPatch {
                tags: Some(vec!["t".repeat(51)]),
                ..TaskPatch::default()
            },
            TaskPatch {
                repeat_from: Patch::Set("start".into()),
                ..TaskPatch::default()
            },
            TaskPatch {
                repeat_config: Patch::Set(json!({"interval": 1})),
                ..TaskPatch::default()
            },
        ];
        let before = payload_of(conn, "t1");
        for case in cases {
            let error =
                tasks::update::apply(conn, "t1", &case, local("2026-04-16T12:00:00"), DEVICE, NOW);
            assert!(
                matches!(error, Err(StorageError::Invalid { .. })),
                "{case:?} gave {error:?}"
            );
        }
        assert_eq!(payload_of(conn, "t1"), before);
        Ok(())
    })
    .expect("the field patches");
}
