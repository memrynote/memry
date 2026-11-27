//! The next occurrence's id (#3538, chapter 13 §13.7.3) against real SQLite:
//! random, as desktop's, so a completion on one device never shares an id with
//! another device's.
//!
//! | Test                                                            | Rule                     |
//! | --------------------------------------------------------------- | ------------------------ |
//! | two devices complete one occurrence and both occurrences survive | no loss on merge         |
//! | undo, then complete again, spawns a live occurrence              | tasks are not recreatable |

use memry_core::domain::calendar::LocalDateTime;
use memry_core::domain::tasks::{self, NewTask, TASK_ID_LEN, TaskDetails};
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE_A: &str = "device-a";
const DEVICE_B: &str = "device-b";

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-spawn-id-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn apply_payload(conn: &Connection, item_type: &str, item_id: &str, payload: &str) -> ApplyOutcome {
    let record = InboundRecord {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        payload_json: payload.to_owned(),
        server_cursor: None,
        signer_device_id: None,
        updated_at: NOW,
        deleted_at: None,
    };
    sync_items::apply_remote(conn, &record, NOW).expect("apply")
}

fn apply(conn: &Connection, item_type: &str, item_id: &str, payload: Value) {
    let outcome = apply_payload(conn, item_type, item_id, &payload.to_string());
    assert_eq!(outcome, ApplyOutcome::Applied, "{item_id}");
}

/// What a peer receives for `task_id`: this device's push payload.
fn pushed(conn: &Connection, task_id: &str) -> String {
    sync_items::push_payload(conn, "task", task_id)
        .expect("read the payload")
        .expect("a payload")
}

fn seed_project(conn: &Connection) {
    apply(
        conn,
        "project",
        "pa",
        json!({"name": "pa", "color": "#0ea5e9", "clock": {"device-c": 1}, "statuses": [
            {"id": "pa-todo", "name": "To Do", "color": "#6b7280", "position": 0, "isDefault": true},
            {"id": "pa-done", "name": "Done", "color": "#22c55e", "position": 1, "isDone": true}
        ]}),
    );
}

/// Project `pa` with desktop's statuses and an open daily task `t1` due
/// 2026-04-16, created on device A.
fn seed(conn: &Connection) {
    seed_project(conn);
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
        DEVICE_A,
        NOW,
    )
    .expect("create t1");
}

fn complete(conn: &Connection, device_id: &str, at: i64) -> tasks::Completion {
    let local = LocalDateTime::parse("2026-04-16T12:00:00").expect("an instant");
    tasks::complete(conn, "t1", local, device_id, at).expect("complete t1")
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
fn two_devices_complete_one_occurrence_and_both_occurrences_survive() {
    let a = open("device-a");
    let b = open("device-b");
    let t1 = a
        .call_blocking(|conn| {
            seed(conn);
            Ok(pushed(conn, "t1"))
        })
        .expect("seed device A");

    // Both devices complete t1 before either syncs.
    let on_b = b
        .call_blocking(|conn| {
            seed_project(conn);
            assert_eq!(
                apply_payload(conn, "task", "t1", &t1),
                ApplyOutcome::Applied
            );
            let done = complete(conn, DEVICE_B, NOW + 1_000);
            let next = done.next_occurrence.expect("B's next occurrence");
            Ok((next.id.clone(), pushed(conn, &next.id)))
        })
        .expect("complete on device B");
    let (b_next, b_payload) = on_b;

    a.call_blocking(|conn| {
        let done = complete(conn, DEVICE_A, NOW + 1_000);
        let a_next = done.next_occurrence.clone().expect("A's next occurrence");
        assert_eq!(a_next.id.len(), TASK_ID_LEN);
        assert_ne!(a_next.id, b_next, "each device creates its own occurrence");

        // B's occurrence syncs in beside A's: nothing is lost.
        assert_eq!(
            apply_payload(conn, "task", &b_next, &b_payload),
            ApplyOutcome::Applied
        );
        assert!(live(conn, &a_next.id) && live(conn, &b_next));

        // Undo on A tombstones only the occurrence A created.
        let undone = tasks::undo(conn, &done.write, DEVICE_A, NOW + 2_000)?;
        assert_eq!(undone.deleted, vec![a_next.id.clone()]);
        assert!(!live(conn, &a_next.id), "A's occurrence is undone");
        assert!(live(conn, &b_next), "B's occurrence survives A's undo");
        Ok(())
    })
    .expect("merge and undo on device A");
}

#[test]
fn undo_then_complete_again_spawns_a_live_occurrence() {
    let db = open("undo");
    db.call_blocking(|conn| {
        seed(conn);
        let done = complete(conn, DEVICE_A, NOW + 1_000);
        let first = done.next_occurrence.clone().expect("a next occurrence");
        tasks::undo(conn, &done.write, DEVICE_A, NOW + 2_000)?;
        assert!(
            !live(conn, &first.id),
            "undo tombstones the spawned occurrence"
        );

        let again = complete(conn, DEVICE_A, NOW + 3_000);
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
