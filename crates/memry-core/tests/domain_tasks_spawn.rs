//! The next occurrence's id (#3538, chapter 13 §13.7.3) against real SQLite:
//! derived from the series so two devices create one task, never laid over a
//! tombstone, and never created twice.
//!
//! | Test                                                       | Rule                     |
//! | ---------------------------------------------------------- | ------------------------ |
//! | the next occurrence takes the derived id                   | §13.7.3                  |
//! | a peer's synced occurrence is the next one, not a copy      | one task after merge     |
//! | undo, then complete again, spawns a live occurrence         | tasks are not recreatable |
//! | a tombstone known only from sync also takes a fresh id      | §5.12.3                  |

use memry_core::domain::calendar::LocalDateTime;
use memry_core::domain::tasks::{self, NewTask, TASK_ID_LEN, TaskDetails};
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-spawn-id-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn inbound(
    item_type: &str,
    item_id: &str,
    payload: Value,
    deleted_at: Option<i64>,
) -> InboundRecord {
    InboundRecord {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: None,
        signer_device_id: None,
        updated_at: NOW,
        deleted_at,
    }
}

fn apply(conn: &Connection, item_type: &str, item_id: &str, payload: Value) {
    let outcome = sync_items::apply_remote(conn, &inbound(item_type, item_id, payload, None), NOW)
        .expect("apply");
    assert_eq!(outcome, ApplyOutcome::Applied, "{item_id}");
}

/// Project `pa` with desktop's statuses and an open daily task `t1` due
/// 2026-04-16.
fn seed(conn: &Connection) {
    apply(
        conn,
        "project",
        "pa",
        json!({"name": "pa", "color": "#0ea5e9", "clock": {"device-b": 1}, "statuses": [
            {"id": "pa-todo", "name": "To Do", "color": "#6b7280", "position": 0, "isDefault": true},
            {"id": "pa-done", "name": "Done", "color": "#22c55e", "position": 1, "isDone": true}
        ]}),
    );
    let repeat = json!({"frequency": "daily", "interval": 1, "endType": "never",
                        "completedCount": 0, "createdAt": "2026-04-01T09:00:00.000Z"});
    tasks::create_detailed(
        conn,
        &NewTask {
            id: "t1",
            title: "Water the plants",
            project_id: "pa",
            due_date: Some("2026-04-16"),
            due_time: None,
            priority: 0,
            repeat_config: Some(&repeat),
            tags: &[],
        },
        &TaskDetails::default(),
        DEVICE,
        NOW,
    )
    .expect("create t1");
}

fn complete(conn: &Connection, at: i64) -> tasks::Completion {
    let local = LocalDateTime::parse("2026-04-16T12:00:00").expect("an instant");
    tasks::complete(conn, "t1", local, DEVICE, at).expect("complete t1")
}

/// §13.7.3, written out from the chapter's sentence.
fn derived(task_id: &str, completed_count: i64) -> String {
    let digest = Sha256::digest(format!("{task_id} spawn {completed_count}").as_bytes());
    hex::encode(digest)[..TASK_ID_LEN].to_owned()
}

fn live(conn: &Connection, task_id: &str) -> bool {
    conn.query_row(
        "SELECT count(*) FROM tasks WHERE id = ?1 AND deleted_at IS NULL",
        params![task_id],
        |row| row.get::<_, i64>(0),
    )
    .expect("count")
        == 1
}

#[test]
fn the_next_occurrence_takes_the_derived_id() {
    let db = open("derived");
    db.call_blocking(|conn| {
        seed(conn);
        let done = complete(conn, NOW + 1_000);
        let next = done.next_occurrence.expect("a next occurrence");
        assert_eq!(next.id, derived("t1", 1));
        assert_eq!(done.write.created, std::slice::from_ref(&next.id));
        assert!(live(conn, &next.id));
        Ok(())
    })
    .expect("the completion");
}

#[test]
fn a_peer_s_synced_occurrence_is_the_next_one_not_a_copy() {
    let db = open("peer");
    db.call_blocking(|conn| {
        seed(conn);
        // Device B completed t1 first; its next occurrence synced in before
        // the edit that closes t1.
        let id = derived("t1", 1);
        apply(
            conn,
            "task",
            &id,
            json!({"title": "Water the plants", "projectId": "pa", "statusId": "pa-todo",
                   "dueDate": "2026-04-17", "position": 1, "clock": {"device-b": 1}}),
        );
        let before = sync_items::push_payload(conn, "task", &id)?;

        let done = complete(conn, NOW + 1_000);
        let next = done.next_occurrence.expect("the peer's occurrence");
        assert_eq!(
            (next.id.as_str(), next.due_date.as_str()),
            (id.as_str(), "2026-04-17")
        );
        assert!(
            done.write.created.is_empty(),
            "nothing created, so undo deletes nothing"
        );
        assert_eq!(
            sync_items::push_payload(conn, "task", &id)?,
            before,
            "left as synced"
        );
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM tasks WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count, 2, "t1 and one next occurrence");
        Ok(())
    })
    .expect("the completion");
}

#[test]
fn undo_then_complete_again_spawns_a_live_occurrence() {
    let db = open("undo");
    db.call_blocking(|conn| {
        seed(conn);
        let done = complete(conn, NOW + 1_000);
        let first = done.next_occurrence.clone().expect("a next occurrence");
        tasks::undo(conn, &done.write, DEVICE, NOW + 2_000)?;
        assert!(
            !live(conn, &first.id),
            "undo tombstones the spawned occurrence"
        );

        let again = complete(conn, NOW + 3_000);
        let second = again.next_occurrence.expect("a next occurrence again");
        assert_ne!(
            second.id, first.id,
            "a task id is never laid over its tombstone"
        );
        assert_eq!(second.id.len(), TASK_ID_LEN);
        assert_eq!(second.due_date, "2026-04-17");
        assert_eq!(again.write.created, std::slice::from_ref(&second.id));
        assert!(live(conn, &second.id));
        assert!(!live(conn, &first.id));
        Ok(())
    })
    .expect("undo and complete again");
}

#[test]
fn a_tombstone_known_only_from_sync_also_takes_a_fresh_id() {
    let db = open("remote-tombstone");
    db.call_blocking(|conn| {
        seed(conn);
        // A peer spawned and deleted the occurrence; this device only ever
        // saw the delete.
        let id = derived("t1", 1);
        let deleted = inbound(
            "task",
            &id,
            json!({"title": "x", "projectId": "pa", "clock": {"device-b": 2},
                   "deletedAt": "2025-10-09T08:53:20.000Z"}),
            Some(NOW),
        );
        sync_items::apply_remote(conn, &deleted, NOW)?;

        let done = complete(conn, NOW + 1_000);
        let next = done.next_occurrence.expect("a next occurrence");
        assert_ne!(next.id, id);
        assert!(live(conn, &next.id));
        Ok(())
    })
    .expect("the completion");
}
