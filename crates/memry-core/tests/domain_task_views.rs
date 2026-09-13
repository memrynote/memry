//! The four task views of FR-057, against real SQLite (T129).
//!
//! Every fixture is seeded through the **real** apply path, so the rows these
//! predicates read are the rows a pull would have written.
//!
//! | Test                                            | Rule                           |
//! | ----------------------------------------------- | ------------------------------ |
//! | today carries overdue and started tasks         | `getFilteredTasks` case today  |
//! | today drops done, archived and undated tasks    | same                           |
//! | upcoming is tomorrow through today+7            | case upcoming, `weekFromNow`   |
//! | by-project keeps completed tasks and subtasks   | the project arm                |
//! | completed keys on the status, not `completedAt` | `isComplete`                   |
//! | a subtask rides along with a matching parent    | `includeSubtasksForMatching…`  |
//! | a task whose status will not resolve is open    | `status?.type !== 'done'`      |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::task_views::{self, UPCOMING_WINDOW_DAYS};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const TODAY: &str = "2026-04-16";

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

/// One project with a todo status and a done status.
fn seed_project(conn: &Connection) {
    apply(
        conn,
        "project",
        "proj-1",
        json!({
            "name": "Native iOS",
            "color": "#0ea5e9",
            "statuses": [
                {"id": "todo", "name": "Todo", "color": "#888", "position": 0, "isDefault": true},
                {"id": "done", "name": "Done", "color": "#0a0", "position": 1, "isDone": true}
            ],
            "clock": {"device-b": 1}
        }),
    );
}

fn seed_task(conn: &Connection, id: &str, position: i64, extra: Value) {
    let mut payload = json!({
        "title": id,
        "projectId": "proj-1",
        "statusId": "todo",
        "position": position,
        "clock": {"device-b": 1}
    });
    for (key, value) in extra.as_object().expect("an object") {
        payload
            .as_object_mut()
            .expect("an object")
            .insert(key.clone(), value.clone());
    }
    apply(conn, "task", id, payload);
}

fn ids(rows: Vec<task_views::TaskRow>) -> Vec<String> {
    rows.into_iter().map(|row| row.id).collect()
}

#[test]
fn today_carries_overdue_and_started_tasks_and_drops_done_archived_and_undated_ones() {
    let db = open("views-today");
    db.call_blocking(|conn| {
        seed_project(conn);
        seed_task(conn, "due-today", 1, json!({"dueDate": TODAY}));
        seed_task(conn, "overdue", 2, json!({"dueDate": "2026-04-01"}));
        seed_task(
            conn,
            "started-far-due",
            3,
            json!({
                "startDate": "2026-04-10", "dueDate": "2026-12-01"
            }),
        );
        seed_task(conn, "future", 4, json!({"dueDate": "2026-04-18"}));
        seed_task(conn, "undated", 5, json!({}));
        seed_task(
            conn,
            "done-today",
            6,
            json!({"dueDate": TODAY, "statusId": "done"}),
        );
        seed_task(
            conn,
            "archived-today",
            7,
            json!({
                "dueDate": TODAY, "archivedAt": "2026-04-15T00:00:00.000Z"
            }),
        );

        assert_eq!(
            ids(task_views::today(conn, TODAY)?),
            vec![
                "due-today".to_owned(),
                "overdue".to_owned(),
                "started-far-due".to_owned()
            ]
        );
        Ok(())
    })
    .expect("the today view");
}

#[test]
fn upcoming_starts_the_day_after_today_and_ends_seven_days_out() {
    let db = open("views-upcoming");
    db.call_blocking(|conn| {
        seed_project(conn);
        seed_task(conn, "overdue", 1, json!({"dueDate": "2026-04-01"}));
        seed_task(conn, "due-today", 2, json!({"dueDate": TODAY}));
        seed_task(conn, "tomorrow", 3, json!({"dueDate": "2026-04-17"}));
        seed_task(conn, "last-day", 4, json!({"dueDate": "2026-04-23"}));
        seed_task(conn, "past-the-window", 5, json!({"dueDate": "2026-04-24"}));
        // A start date does not put an undated task into upcoming.
        seed_task(
            conn,
            "started-undated",
            6,
            json!({"startDate": "2026-04-10"}),
        );

        assert_eq!(
            ids(task_views::upcoming(conn, TODAY, UPCOMING_WINDOW_DAYS)?),
            vec!["tomorrow".to_owned(), "last-day".to_owned()]
        );
        Ok(())
    })
    .expect("the upcoming view");
}

#[test]
fn by_project_keeps_completed_tasks_and_subtasks_and_drops_archived_ones() {
    let db = open("views-project");
    db.call_blocking(|conn| {
        seed_project(conn);
        seed_task(conn, "open", 1, json!({}));
        seed_task(conn, "finished", 2, json!({"statusId": "done"}));
        seed_task(conn, "child", 3, json!({"parentId": "open"}));
        seed_task(
            conn,
            "archived",
            4,
            json!({"archivedAt": "2026-04-15T00:00:00.000Z"}),
        );
        seed_task(conn, "elsewhere", 5, json!({"projectId": "proj-2"}));

        assert_eq!(
            ids(task_views::by_project(conn, "proj-1")?),
            vec!["open".to_owned(), "finished".to_owned(), "child".to_owned()]
        );
        Ok(())
    })
    .expect("the project view");
}

#[test]
fn completed_keys_on_the_status_and_not_on_completed_at() {
    let db = open("views-completed");
    db.call_blocking(|conn| {
        seed_project(conn);
        seed_task(conn, "status-done", 1, json!({"statusId": "done"}));
        // `completedAt` set but the status is still open: desktop's sidebar
        // Completed view keys on the status, so this one stays out.
        seed_task(
            conn,
            "stamped-only",
            2,
            json!({
                "completedAt": "2026-04-15T09:00:00.000Z"
            }),
        );
        seed_task(conn, "open", 3, json!({}));

        assert_eq!(
            ids(task_views::completed(conn)?),
            vec!["status-done".to_owned()]
        );
        Ok(())
    })
    .expect("the completed view");
}

#[test]
fn a_subtask_rides_along_with_its_matching_parent_and_never_on_its_own() {
    let db = open("views-subtasks");
    db.call_blocking(|conn| {
        seed_project(conn);
        seed_task(conn, "parent", 1, json!({"dueDate": TODAY}));
        // Neither dated nor started, and even done: it is in because its
        // parent matched.
        seed_task(
            conn,
            "child",
            2,
            json!({"parentId": "parent", "statusId": "done"}),
        );
        seed_task(conn, "other-parent", 3, json!({}));
        seed_task(conn, "other-child", 4, json!({"parentId": "other-parent"}));

        assert_eq!(
            ids(task_views::today(conn, TODAY)?),
            vec!["parent".to_owned(), "child".to_owned()]
        );
        Ok(())
    })
    .expect("the subtask ride-along");
}

#[test]
fn a_task_whose_status_will_not_resolve_reads_as_open() {
    let db = open("views-unresolved");
    db.call_blocking(|conn| {
        seed_project(conn);
        // A status id from another project, and a project that has not been
        // pulled at all. Desktop's `status?.type !== 'done'` is true for both,
        // so both stay in the open views rather than vanishing from every one.
        seed_task(
            conn,
            "foreign-status",
            1,
            json!({
                "dueDate": TODAY, "statusId": "status-from-elsewhere"
            }),
        );
        seed_task(
            conn,
            "unpulled-project",
            2,
            json!({
                "dueDate": TODAY, "projectId": "proj-unknown", "statusId": "done"
            }),
        );

        assert_eq!(
            ids(task_views::today(conn, TODAY)?),
            vec!["foreign-status".to_owned(), "unpulled-project".to_owned()]
        );
        assert!(task_views::completed(conn)?.is_empty());
        Ok(())
    })
    .expect("the unresolved status");
}

#[test]
fn a_malformed_today_is_refused_rather_than_compared() {
    let db = open("views-bad-date");
    db.call_blocking(|conn| {
        seed_project(conn);
        assert!(task_views::today(conn, "16/04/2026").is_err());
        assert!(task_views::upcoming(conn, "", UPCOMING_WINDOW_DAYS).is_err());
        Ok(())
    })
    .expect("the refusal");
}
