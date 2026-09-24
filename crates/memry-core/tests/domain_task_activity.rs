//! Task activity (spec 004 TP025), against real SQLite.
//!
//! Desktop's `tasks/activity-log.ts` (write) and
//! `database/queries/task-activity.ts` (read) are the reference.
//!
//! | Test                                                   | Rule                            |
//! | ------------------------------------------------------ | ------------------------------- |
//! | a created row is its own sync item with its own outbox | §13.7.5, FR-030                 |
//! | an update logs completion first, drops noise fields    | `recordTaskUpdated`             |
//! | description is logged as a length delta                | `lengthOnlyRow`                 |
//! | completion rows key on truthiness                      | `completionRow`                 |
//! | archive is an updated row on archivedAt                | `archiveTask` publisher         |
//! | a move logs the fields that changed                    | `recordTaskMoved`               |
//! | a delete logs the title                                | `recordTaskDeleted`             |
//! | the feed pages newest first and filters by action      | `listTaskActivity`              |
//! | reference fields read back as names                    | `resolveReferencedNames`        |
//! | retention hides and prunes rows past 90 days           | §13.12                          |
//! | a record joins the caller's open transaction           | one commit with the task write  |
//! | an inbound desktop row reads with unknown keys kept    | §13.2                           |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::task_activity::{
    self, ACTION_COMPLETED, ACTION_CREATED, ACTION_UPDATED, ActivityQuery, FieldChange,
};
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const NOW_ISO: &str = "2025-10-09T08:53:20.000Z";
const DAY: i64 = 86_400_000;
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

fn payload_of(conn: &Connection, item_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, "task_activity", item_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn outbox_rows(conn: &Connection, item_id: &str) -> Vec<(String, String, Option<Vec<u8>>)> {
    let mut statement = conn
        .prepare("SELECT item_type, op, payload FROM outbox WHERE item_id = ?1")
        .expect("prepare");
    statement
        .query_map(params![item_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

fn apply(conn: &Connection, item_type: &str, item_id: &str, payload: Value, now_ms: i64) {
    let outcome = sync_items::apply_remote(
        conn,
        &InboundRecord {
            item_type: item_type.to_owned(),
            item_id: item_id.to_owned(),
            payload_json: serde_json::to_string(&payload).expect("serialise"),
            server_cursor: None,
            signer_device_id: None,
            updated_at: now_ms,
            deleted_at: None,
        },
        now_ms,
    )
    .expect("apply");
    assert_eq!(outcome, ApplyOutcome::Applied, "{item_id}");
}

/// `(action, field, oldValue, newValue)`.
type StoredRow = (String, Option<String>, Option<String>, Option<String>);

/// Every stored row, in write order (rows of one call share `createdAt`, so
/// order by rowid).
fn stored_rows(conn: &Connection) -> Vec<StoredRow> {
    let mut statement = conn
        .prepare("SELECT action, field, old_value, new_value FROM task_activity ORDER BY rowid")
        .expect("prepare");
    statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

fn s(value: &str) -> Option<String> {
    Some(value.to_owned())
}

fn all(task_id: &str) -> ActivityQuery<'_> {
    ActivityQuery {
        task_id,
        actions: &[],
        limit: task_activity::DEFAULT_PAGE_LIMIT,
        offset: 0,
    }
}

#[test]
fn a_created_row_is_its_own_sync_item_with_its_own_outbox_row() {
    let db = open("activity-created");
    db.call_blocking(|conn| {
        let ids = task_activity::record_created(conn, "task1", "Ship it", DEVICE, NOW)?;
        assert_eq!(ids.len(), 1);
        let id = &ids[0];
        assert_eq!(id.len(), 21);
        assert!(
            id.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        );

        assert_eq!(
            payload_of(conn, id),
            json!({
                "taskId": "task1",
                "action": "created",
                "field": null,
                "oldValue": null,
                "newValue": "\"Ship it\"",
                "actor": "user",
                "deviceId": DEVICE,
                "clock": {"device-a": 1},
                "createdAt": NOW_ISO,
            })
        );
        let row = sync_items::load(conn, "task_activity", id)?.expect("the row");
        assert_eq!(row.field_clocks, None, "append-only: no fieldClocks");
        assert_eq!(
            outbox_rows(conn, id),
            vec![("task_activity".to_owned(), "upsert".to_owned(), None)]
        );

        let (task_id, created_at, device): (String, i64, String) = conn
            .query_row(
                "SELECT task_id, created_at, device_id FROM task_activity WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("the projection row");
        assert_eq!(
            (task_id.as_str(), created_at, device.as_str()),
            ("task1", NOW, DEVICE)
        );
        Ok(())
    })
    .expect("the create");
}

#[test]
fn an_update_logs_completion_first_and_drops_noise_and_unchanged_fields() {
    let db = open("activity-updated");
    db.call_blocking(|conn| {
        let done_at = json!("2025-10-09T08:53:20.000Z");
        let ids = task_activity::record_updated(
            conn,
            "task1",
            &[
                FieldChange {
                    field: "title",
                    old: &json!("Old"),
                    new: &json!("New"),
                },
                FieldChange {
                    field: "position",
                    old: &json!(1),
                    new: &json!(2),
                },
                FieldChange {
                    field: "modifiedAt",
                    old: &json!("a"),
                    new: &json!("b"),
                },
                FieldChange {
                    field: "priority",
                    old: &json!(2),
                    new: &json!(2),
                },
                FieldChange {
                    field: "dueDate",
                    old: &json!("2026-04-20"),
                    new: &Value::Null,
                },
                FieldChange {
                    field: "tags",
                    old: &json!([]),
                    new: &json!(["work"]),
                },
                FieldChange {
                    field: "completedAt",
                    old: &Value::Null,
                    new: &done_at,
                },
            ],
            DEVICE,
            NOW,
        )?;
        assert_eq!(ids.len(), 4);
        for id in &ids {
            assert_eq!(
                outbox_rows(conn, id).len(),
                1,
                "one outbox row per activity row"
            );
        }
        assert_eq!(
            stored_rows(conn),
            vec![
                (
                    ACTION_COMPLETED.to_owned(),
                    s("completedAt"),
                    None,
                    s("\"2025-10-09T08:53:20.000Z\"")
                ),
                (
                    ACTION_UPDATED.to_owned(),
                    s("title"),
                    s("\"Old\""),
                    s("\"New\"")
                ),
                (
                    ACTION_UPDATED.to_owned(),
                    s("dueDate"),
                    s("\"2026-04-20\""),
                    None
                ),
                (
                    ACTION_UPDATED.to_owned(),
                    s("tags"),
                    s("[]"),
                    s("[\"work\"]")
                ),
            ]
        );
        // An edit with nothing auditable writes nothing at all.
        let none = task_activity::record_updated(
            conn,
            "task1",
            &[FieldChange {
                field: "position",
                old: &json!(1),
                new: &json!(5),
            }],
            DEVICE,
            NOW,
        )?;
        assert!(none.is_empty());
        Ok(())
    })
    .expect("the update");
}

#[test]
fn description_is_logged_as_a_length_delta_and_never_as_the_body() {
    let db = open("activity-description");
    db.call_blocking(|conn| {
        let ids = task_activity::record_field_change(
            conn,
            "task1",
            "description",
            &json!("secret body"),
            &json!("secret"),
            DEVICE,
            NOW,
        )?;
        let payload = payload_of(conn, &ids[0]);
        assert_eq!(payload["oldValue"], Value::Null);
        assert_eq!(payload["newValue"], json!("{\"delta\":-5}"));
        assert!(!payload.to_string().contains("secret"));
        Ok(())
    })
    .expect("the description");
}

#[test]
fn completion_rows_key_on_truthiness() {
    let db = open("activity-completion");
    db.call_blocking(|conn| {
        let stamp = json!("2025-10-09T08:53:20.000Z");
        let reopened =
            task_activity::record_completion(conn, "task1", &stamp, &Value::Null, DEVICE, NOW)?;
        assert_eq!(reopened.len(), 1);
        let payload = payload_of(conn, &reopened[0]);
        assert_eq!(payload["action"], json!("uncompleted"));
        assert_eq!(payload["field"], json!("completedAt"));
        assert_eq!(payload["oldValue"], json!("\"2025-10-09T08:53:20.000Z\""));
        assert_eq!(payload["newValue"], Value::Null);

        // Already complete: no flip, no row.
        let again = task_activity::record_completion(conn, "task1", &stamp, &stamp, DEVICE, NOW)?;
        assert!(again.is_empty());
        Ok(())
    })
    .expect("the completion");
}

#[test]
fn archive_is_an_updated_row_on_archived_at() {
    let db = open("activity-archive");
    db.call_blocking(|conn| {
        let at = json!("2025-10-09T08:53:20.000Z");
        let ids = task_activity::record_field_change(
            conn,
            "task1",
            "archivedAt",
            &Value::Null,
            &at,
            DEVICE,
            NOW,
        )?;
        let payload = payload_of(conn, &ids[0]);
        assert_eq!(payload["action"], json!("updated"));
        assert_eq!(payload["field"], json!("archivedAt"));
        assert_eq!(payload["oldValue"], Value::Null);
        assert_eq!(payload["newValue"], json!("\"2025-10-09T08:53:20.000Z\""));
        Ok(())
    })
    .expect("the archive");
}

#[test]
fn a_move_logs_only_the_fields_that_changed() {
    let db = open("activity-moved");
    db.call_blocking(|conn| {
        task_activity::record_moved(
            conn,
            "task1",
            &[
                FieldChange {
                    field: "position",
                    old: &json!(0),
                    new: &json!(3),
                },
                FieldChange {
                    field: "projectId",
                    old: &json!("proj-a"),
                    new: &json!("proj-b"),
                },
                FieldChange {
                    field: "statusId",
                    old: &json!("todo"),
                    new: &json!("todo"),
                },
            ],
            DEVICE,
            NOW,
        )?;
        assert_eq!(
            stored_rows(conn),
            vec![(
                "moved".to_owned(),
                s("projectId"),
                s("\"proj-a\""),
                s("\"proj-b\"")
            )]
        );
        Ok(())
    })
    .expect("the move");
}

#[test]
fn a_delete_logs_the_title_as_the_old_value() {
    let db = open("activity-deleted");
    db.call_blocking(|conn| {
        task_activity::record_deleted(conn, "task1", Some("Gone"), DEVICE, NOW)?;
        task_activity::record_deleted(conn, "task2", None, DEVICE, NOW)?;
        assert_eq!(
            stored_rows(conn),
            vec![
                ("deleted".to_owned(), None, s("\"Gone\""), None),
                ("deleted".to_owned(), None, None, None),
            ]
        );
        Ok(())
    })
    .expect("the delete");
}

#[test]
fn the_feed_pages_newest_first_and_filters_by_action() {
    let db = open("activity-list");
    db.call_blocking(|conn| {
        task_activity::record_created(conn, "task1", "One", DEVICE, NOW)?;
        task_activity::record_field_change(
            conn,
            "task1",
            "title",
            &json!("One"),
            &json!("Two"),
            DEVICE,
            NOW + 1_000,
        )?;
        task_activity::record_completion(
            conn,
            "task1",
            &Value::Null,
            &json!("x"),
            DEVICE,
            NOW + 2_000,
        )?;
        task_activity::record_created(conn, "other", "Elsewhere", DEVICE, NOW)?;
        // A peer's row: listed, but not "this device".
        apply(
            conn,
            "task_activity",
            "peer-row",
            json!({"taskId": "task1", "action": "updated", "field": "priority",
                   "oldValue": "1", "newValue": "3", "actor": "user", "deviceId": "device-b",
                   "clock": {"device-b": 1}, "createdAt": "2025-10-09T08:53:23.000Z"}),
            NOW,
        );

        let page = task_activity::list(conn, &all("task1"), Some(DEVICE), NOW + 5_000)?;
        assert_eq!(page.total, 4);
        assert!(!page.has_more);
        let actions: Vec<&str> = page.entries.iter().map(|e| e.action.as_str()).collect();
        assert_eq!(actions, ["updated", "completed", "updated", "created"]);
        assert_eq!(page.entries[0].id, "peer-row");
        assert!(!page.entries[0].is_this_device);
        assert!(page.entries[1].is_this_device);
        assert_eq!(page.entries[3].created_at_ms, Some(NOW));
        assert_eq!(page.entries[3].actor, "user");

        let first = task_activity::list(
            conn,
            &ActivityQuery {
                limit: 3,
                ..all("task1")
            },
            Some(DEVICE),
            NOW + 5_000,
        )?;
        assert_eq!(first.entries.len(), 3);
        assert!(first.has_more);
        let second = task_activity::list(
            conn,
            &ActivityQuery {
                limit: 3,
                offset: 3,
                ..all("task1")
            },
            Some(DEVICE),
            NOW + 5_000,
        )?;
        assert_eq!(second.entries.len(), 1);
        assert_eq!(second.entries[0].action, ACTION_CREATED);
        assert!(!second.has_more);

        let actions = vec![ACTION_CREATED.to_owned(), ACTION_COMPLETED.to_owned()];
        let filtered = task_activity::list(
            conn,
            &ActivityQuery {
                actions: &actions,
                ..all("task1")
            },
            None,
            NOW + 5_000,
        )?;
        let got: Vec<&str> = filtered.entries.iter().map(|e| e.action.as_str()).collect();
        assert_eq!(got, ["completed", "created"]);
        assert!(filtered.entries.iter().all(|e| !e.is_this_device));
        assert_eq!(
            task_activity::count(conn, "task1", &actions, NOW + 5_000)?,
            2
        );
        assert_eq!(task_activity::count(conn, "task1", &[], NOW + 5_000)?, 4);
        Ok(())
    })
    .expect("the list");
}

#[test]
fn reference_fields_read_back_as_names_and_fall_back_to_the_id() {
    let db = open("activity-names");
    db.call_blocking(|conn| {
        apply(
            conn,
            "project",
            "proj-b",
            json!({"name": "Native iOS", "color": "#0ea5e9",
                   "statuses": [{"id": "st-doing", "name": "Doing", "color": "#888", "position": 1}],
                   "clock": {"device-b": 1}}),
            NOW,
        );
        apply(
            conn,
            "task",
            "parent-1",
            json!({"title": "Parent task", "projectId": "proj-b", "clock": {"device-b": 1}}),
            NOW,
        );
        task_activity::record_moved(
            conn,
            "task1",
            &[
                FieldChange { field: "projectId", old: &json!("proj-gone"), new: &json!("proj-b") },
                FieldChange { field: "statusId", old: &Value::Null, new: &json!("st-doing") },
                FieldChange { field: "parentId", old: &Value::Null, new: &json!("parent-1") },
            ],
            DEVICE,
            NOW,
        )?;
        let page = task_activity::list(conn, &all("task1"), Some(DEVICE), NOW)?;
        let mut by_field: Vec<(Option<String>, Option<String>, Option<String>)> = page
            .entries
            .into_iter()
            .map(|e| (e.field, e.old_value, e.new_value))
            .collect();
        by_field.sort();
        assert_eq!(
            by_field,
            vec![
                (s("parentId"), None, s("\"Parent task\"")),
                (s("projectId"), s("\"proj-gone\""), s("\"Native iOS\"")),
                (s("statusId"), None, s("\"Doing\"")),
            ]
        );
        // Stored values stay ids: names are a read-time lookup.
        assert!(stored_rows(conn).iter().any(|row| row.3 == s("\"proj-b\"")));
        Ok(())
    })
    .expect("the names");
}

#[test]
fn retention_hides_and_prunes_rows_past_ninety_days() {
    let db = open("activity-retention");
    db.call_blocking(|conn| {
        let old = task_activity::record_created(conn, "task1", "Old", DEVICE, NOW)?;
        // Queued and never pushed, so the prune must take its outbox row too.
        assert_eq!(outbox_rows(conn, &old[0]).len(), 1);

        let later = NOW + 91 * DAY;
        assert_eq!(task_activity::count(conn, "task1", &[], later)?, 0);
        assert!(
            task_activity::list(conn, &all("task1"), Some(DEVICE), later)?
                .entries
                .is_empty()
        );
        assert_eq!(task_activity::count(conn, "task1", &[], NOW + 89 * DAY)?, 1);

        // A write prunes locally, in the same transaction, without a push.
        let fresh = task_activity::record_created(conn, "task1", "New", DEVICE, later)?;
        assert!(sync_items::load(conn, "task_activity", &old[0])?.is_none());
        assert!(outbox_rows(conn, &old[0]).is_empty());
        assert_eq!(outbox_rows(conn, &fresh[0]).len(), 1);
        assert_eq!(stored_rows(conn).len(), 1);

        // The standalone sweep reports what it removed.
        assert_eq!(task_activity::prune_expired(conn, later + 91 * DAY)?, 1);
        assert_eq!(task_activity::prune_expired(conn, later + 91 * DAY)?, 0);
        Ok(())
    })
    .expect("the retention");
}

#[test]
fn a_record_joins_the_callers_open_transaction() {
    let db = open("activity-tx");
    db.call_blocking(|conn| {
        {
            let tx = conn.unchecked_transaction().expect("begin");
            task_activity::record_created(&tx, "task1", "Rolled back", DEVICE, NOW)?;
            // Dropped without commit: the row and its outbox row both go.
        }
        assert!(stored_rows(conn).is_empty());
        let queued: i64 = conn
            .query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
            .expect("count");
        assert_eq!(queued, 0);

        let tx = conn.unchecked_transaction().expect("begin");
        let ids = task_activity::record_created(&tx, "task1", "Kept", DEVICE, NOW)?;
        tx.commit().expect("commit");
        assert_eq!(outbox_rows(conn, &ids[0]).len(), 1);
        assert_eq!(stored_rows(conn).len(), 1);
        Ok(())
    })
    .expect("the transaction");
}

#[test]
fn an_inbound_desktop_row_reads_back_and_keeps_its_unknown_keys() {
    let db = open("activity-inbound");
    db.call_blocking(|conn| {
        // Desktop pushes `JSON.stringify(row)`, so `id` and `syncedAt` ride
        // along; an old desktop may omit `actor`.
        let desktop = json!({"id": "V1StGXR8_Z5jdHi6B-myT", "taskId": "task1",
                             "action": "superseded", "field": "title", "oldValue": "\"a\"",
                             "newValue": "\"b\"", "deviceId": "device-b",
                             "createdAt": "2025-10-09T08:53:20.000Z", "clock": {"device-b": 1},
                             "syncedAt": null});
        apply(
            conn,
            "task_activity",
            "V1StGXR8_Z5jdHi6B-myT",
            desktop.clone(),
            NOW,
        );
        let page = task_activity::list(conn, &all("task1"), Some(DEVICE), NOW)?;
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].action, "superseded");
        assert_eq!(page.entries[0].actor, "user");
        assert_eq!(payload_of(conn, "V1StGXR8_Z5jdHi6B-myT"), desktop);
        Ok(())
    })
    .expect("the inbound row");
}
