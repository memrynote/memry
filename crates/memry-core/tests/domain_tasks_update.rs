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
//! | undo reverts an update, `fields` with new stamps  | the registered undo, §6.11.3          |
//! | undo of `fields` leaves later local/peer entries | the registered undo, §6.11.3          |
//! | undo of an undo restores plain `fields` values    | the registered undo, §6.11.3          |
//! | `repeatConfig` holds to the schema                | `RepeatConfigSchema`                  |
//! | tags trimmed and folded; link ids deduped         | `setTaskTags`                         |
//! | no deeper nesting with `nestedSubtasks` off       | `checkParent` (`tree.ts`)             |
//! | the status a project change lands in              | `getEquivalentStatus`                 |

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
    seed_statuses(
        conn,
        id,
        json!([
            {"id": format!("{id}-todo"), "name": "To Do", "color": "#6b7280", "position": 0, "isDefault": true},
            {"id": format!("{id}-doing"), "name": "In Progress", "color": "#F59E0B", "position": 1},
            {"id": format!("{id}-done"), "name": "Done", "color": "#22c55e", "position": 2, "isDone": true}
        ]),
    );
}

fn seed_statuses(conn: &Connection, id: &str, statuses: Value) {
    apply(
        conn,
        "project",
        id,
        json!({
            "name": id,
            "color": "#0ea5e9",
            "statuses": statuses,
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
    Ok(update_nesting(conn, id, patch, true)?.expect("an accepted update"))
}

/// `allow_nested` is desktop's `tasks.nestedSubtasks` setting (default on).
fn update_nesting(
    conn: &Connection,
    id: &str,
    patch: &TaskPatch,
    allow_nested: bool,
) -> Result<Result<TaskUpdate, UpdateRefusal>, StorageError> {
    tasks::update::apply(
        conn,
        id,
        patch,
        local("2026-04-16T12:00:00"),
        allow_nested,
        DEVICE,
        NOW + 1_000,
    )
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
            update_nesting(conn, id, &patch, true)
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
            let error = update_nesting(conn, "t1", &case, true);
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

fn fields_patch(pairs: &[(&str, Value)]) -> Option<Map<String, Value>> {
    Some(
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), value.clone()))
            .collect(),
    )
}

#[test]
fn domain_tasks_update_undo_restores_fields_with_fresh_stamps() {
    let db = open("tu-undo-fields");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", "pa", None);
        update(
            conn,
            "t1",
            &TaskPatch {
                fields: fields_patch(&[("B", json!("x"))]),
                ..TaskPatch::default()
            },
        )?;
        let edit = update(
            conn,
            "t1",
            &TaskPatch {
                title: Some("Renamed".into()),
                fields: fields_patch(&[("A", json!(1)), ("B", Value::Null)]),
                ..TaskPatch::default()
            },
        )?;
        let edited = payload_of(conn, "t1");
        let stamp = |task: &Value, name: &str| task["fields"][name]["t"].as_u64().expect("a stamp");
        let edit_stamp = stamp(&edited, "A");
        clear_outbox(conn);

        let undone = tasks::undo(conn, &edit.write, DEVICE, NOW + 2_000)?;
        let task = payload_of(conn, "t1");
        assert_eq!(task["title"], json!("Water the plants"));
        assert_eq!(
            Value::Object(memry_core::sync::versioned::plain(task.get("fields"))),
            json!({"B": "x"})
        );
        // A peer that saw the update must lose to the undo (§6.11.3): every
        // restored entry carries a stamp newer than the update's, never the
        // old one.
        assert_eq!(task["fields"]["A"]["v"], Value::Null);
        assert!(stamp(&task, "A") > edit_stamp);
        assert!(stamp(&task, "B") > edit_stamp);
        assert_eq!(undone.changed_ids(), ["t1"]);
        assert_eq!(outbox_rows(conn), [("t1".into(), "upsert".into())]);
        Ok(())
    })
    .expect("the undo");
}

#[test]
fn domain_tasks_update_undo_of_an_undo_restores_plain_fields() {
    let db = open("tu-undo-undo");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", "pa", None);
        let edit = update(
            conn,
            "t1",
            &TaskPatch {
                fields: fields_patch(&[("A", json!(1))]),
                ..TaskPatch::default()
            },
        )?;
        let fields_prior = |write: &tasks::TaskWrite| -> Vec<(String, Value)> {
            write
                .changed
                .iter()
                .flat_map(|prior| prior.fields.iter().cloned())
                .filter(|(field, _)| field == "fields")
                .collect()
        };
        assert_eq!(
            fields_prior(&edit.write),
            [("fields".to_owned(), json!({"A": null}))]
        );

        let undone = tasks::undo(conn, &edit.write, DEVICE, NOW + 2_000)?;
        let after_undo = payload_of(conn, "t1");
        assert_eq!(after_undo["fields"]["A"]["v"], Value::Null);
        // The undo's own record is the same plain cut an update writes, so it
        // is valid undo input in turn.
        assert_eq!(
            fields_prior(&undone),
            [("fields".to_owned(), json!({"A": 1}))]
        );

        tasks::undo(conn, &undone, DEVICE, NOW + 3_000)?;
        let task = payload_of(conn, "t1");
        let entry = task["fields"]["A"].as_object().expect("an entry");
        assert_eq!(
            entry.get("v"),
            Some(&json!(1)),
            "plain value, no nested entry"
        );
        assert!(
            entry["t"].as_u64().expect("a stamp")
                > after_undo["fields"]["A"]["t"].as_u64().expect("a stamp")
        );
        assert_eq!(
            Value::Object(memry_core::sync::versioned::plain(task.get("fields"))),
            json!({"A": 1})
        );
        Ok(())
    })
    .expect("the undo of the undo");
}

#[test]
fn domain_tasks_update_undo_keeps_a_later_local_field() {
    let db = open("tu-undo-later-local");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", "pa", None);
        let first = update(
            conn,
            "t1",
            &TaskPatch {
                fields: fields_patch(&[("A", json!(1))]),
                ..TaskPatch::default()
            },
        )?;
        update(
            conn,
            "t1",
            &TaskPatch {
                fields: fields_patch(&[("C", json!(5))]),
                ..TaskPatch::default()
            },
        )?;
        let c_stamp = payload_of(conn, "t1")["fields"]["C"].clone();

        tasks::undo(conn, &first.write, DEVICE, NOW + 2_000)?;
        let task = payload_of(conn, "t1");
        assert_eq!(
            Value::Object(memry_core::sync::versioned::plain(task.get("fields"))),
            json!({"C": 5})
        );
        assert_eq!(task["fields"]["C"], c_stamp, "C is not the undo's to stamp");
        Ok(())
    })
    .expect("the undo");
}

#[test]
fn domain_tasks_update_undo_keeps_a_peer_field() {
    let db = open("tu-undo-peer");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", "pa", None);
        let edit = update(
            conn,
            "t1",
            &TaskPatch {
                fields: fields_patch(&[("A", json!(1))]),
                ..TaskPatch::default()
            },
        )?;
        let mut remote = payload_of(conn, "t1");
        remote["fields"]["C"] = json!({"v": "peer", "t": 50});
        remote["clock"]["device-b"] = json!(1);
        apply(conn, "task", "t1", remote);
        assert_eq!(
            payload_of(conn, "t1")["fields"]["C"],
            json!({"v": "peer", "t": 50})
        );

        tasks::undo(conn, &edit.write, DEVICE, NOW + 2_000)?;
        let task = payload_of(conn, "t1");
        assert_eq!(task["fields"]["C"], json!({"v": "peer", "t": 50}));
        assert_eq!(
            Value::Object(memry_core::sync::versioned::plain(task.get("fields"))),
            json!({"C": "peer"})
        );
        Ok(())
    })
    .expect("the undo");
}

#[test]
fn domain_tasks_update_holds_repeat_config_to_the_schema() {
    let db = open("tu-repeat");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", "pa", None);
        let config = |key: &str, value: Option<Value>| {
            let mut config = weekly();
            let object = config.as_object_mut().expect("an object");
            match value {
                Some(value) => object.insert(key.to_owned(), value),
                None => object.remove(key),
            };
            config
        };
        let rejected = [
            config("frequency", Some(json!("hourly"))),
            config("interval", Some(json!(0))),
            config("interval", Some(json!(1.5))),
            config("interval", Some(Value::Null)),
            config("daysOfWeek", Some(json!([7]))),
            config("monthlyType", Some(json!("lastDay"))),
            config("dayOfMonth", Some(json!(32))),
            config("weekOfMonth", Some(json!(6))),
            config("dayOfWeekForMonth", Some(json!(-1))),
            config("endType", Some(json!("forever"))),
            config("endDate", Some(json!(5))),
            config("endCount", Some(json!(0))),
            config("completedCount", Some(json!(-1))),
            config("createdAt", None),
        ];
        let before = payload_of(conn, "t1");
        for repeat in rejected {
            let error = update_nesting(
                conn,
                "t1",
                &TaskPatch {
                    repeat_config: Patch::Set(repeat.clone()),
                    ..TaskPatch::default()
                },
                true,
            );
            assert!(
                matches!(error, Err(StorageError::Invalid { .. })),
                "{repeat} gave {error:?}"
            );
        }
        assert_eq!(payload_of(conn, "t1"), before);

        // A key the schema does not name is a newer build's and stays (D7).
        let newer = config("skipHolidays", Some(json!(true)));
        let mut counted = config("endType", Some(json!("count")));
        counted["endCount"] = json!(3);
        counted["endDate"] = Value::Null;
        for repeat in [newer, counted] {
            update(
                conn,
                "t1",
                &TaskPatch {
                    repeat_config: Patch::Set(repeat.clone()),
                    ..TaskPatch::default()
                },
            )?;
            assert_eq!(payload_of(conn, "t1")["repeatConfig"], repeat);
        }
        Ok(())
    })
    .expect("the repeat configs");
}

#[test]
fn domain_tasks_update_trims_and_folds_tags_and_dedupes_links() {
    let db = open("tu-tags");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        create(conn, "t1", "pa", None);
        update(
            conn,
            "t1",
            &TaskPatch {
                tags: Some(strings(&[" home ", "", "   ", "HOME", "pets "])),
                linked_note_ids: Some(strings(&["n1", "n2", "n1"])),
                linked_canvas_ids: Some(strings(&["c1", "c1"])),
                ..TaskPatch::default()
            },
        )?;
        let task = payload_of(conn, "t1");
        assert_eq!(task["tags"], json!(["home", "pets"]));
        assert_eq!(task["linkedNoteIds"], json!(["n1", "n2"]));
        assert_eq!(task["linkedCanvasIds"], json!(["c1"]));
        Ok(())
    })
    .expect("the tags");
}

#[test]
fn domain_tasks_update_refuses_deeper_nesting_with_nested_subtasks_off() {
    let db = open("tu-nesting");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        for id in ["t1", "t2", "t3", "t4"] {
            create(conn, id, "pa", None);
        }
        let under = |parent: &str| TaskPatch {
            parent_id: Patch::Set(parent.into()),
            ..TaskPatch::default()
        };
        update_nesting(conn, "t2", &under("t1"), false)?.expect("one level is allowed");
        clear_outbox(conn);
        let before = [payload_of(conn, "t1"), payload_of(conn, "t3")];

        // Under a subtask, and a task with subtasks under another task.
        for (task, parent) in [("t3", "t2"), ("t1", "t4")] {
            let refusal = update_nesting(conn, task, &under(parent), false)?;
            assert_eq!(refusal.err(), Some(UpdateRefusal::InvalidParent), "{task}");
        }
        assert_eq!([payload_of(conn, "t1"), payload_of(conn, "t3")], before);
        assert!(outbox_rows(conn).is_empty());

        update_nesting(conn, "t3", &under("t2"), true)?.expect("nesting on");
        assert_eq!(payload_of(conn, "t3")["parentId"], json!("t2"));
        Ok(())
    })
    .expect("the nesting");
}

#[test]
fn domain_tasks_update_maps_the_status_as_get_equivalent_status() {
    let db = open("tu-equivalent");
    db.call_blocking(|conn| {
        seed_project(conn, "pa");
        // The default status is not the first column.
        seed_statuses(
            conn,
            "pc",
            json!([
                {"id": "pc-backlog", "name": "Backlog", "color": "#6b7280", "position": 0},
                {"id": "pc-todo", "name": "To Do", "color": "#6b7280", "position": 1, "isDefault": true},
                {"id": "pc-done", "name": "Done", "color": "#22c55e", "position": 2, "isDone": true}
            ]),
        );
        create(conn, "t1", "pa", None);
        create(conn, "t2", "pc", None);
        create(conn, "t3", "pc", None);
        let status = |id: &str| TaskPatch {
            status_id: Patch::Set(id.into()),
            ..TaskPatch::default()
        };
        update(conn, "t2", &status("pc-todo"))?;
        update(conn, "t3", &status("pc-backlog"))?;
        let to = |project: &str| TaskPatch {
            project_id: Some(project.into()),
            ..TaskPatch::default()
        };

        // A default status lands in the target's default, whatever its column.
        update(conn, "t1", &to("pc"))?;
        assert_eq!(payload_of(conn, "t1")["statusId"], json!("pc-todo"));
        update(conn, "t2", &to("pa"))?;
        assert_eq!(payload_of(conn, "t2")["statusId"], json!("pa-todo"));
        // Neither default nor done lands in the first such status.
        update(conn, "t3", &to("pa"))?;
        assert_eq!(payload_of(conn, "t3")["statusId"], json!("pa-doing"));
        Ok(())
    })
    .expect("the status mapping");
}
