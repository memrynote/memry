//! `record_superseded` (Step 21d, #3538) against Electron's
//! `activity-log.ts` `recordTaskSuperseded` and `taskSupersededActivityId`.

use memry_core::api::errors::StorageError;
use memry_core::domain::task_activity::superseded::{LostField, record_superseded, superseded_id};
use memry_core::domain::tasks::{self, NewTask};
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use rusqlite::Connection;
use serde_json::{Value, json};

const TASK: &str = "task-1";
const NOW: i64 = 1_776_297_600_000;

fn vault_with_task() -> Db {
    let dir = tempfile::Builder::new()
        .prefix("memry-superseded-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    let db = open_data(&dir.join("data.db")).expect("open data.db");
    db.call_blocking(|conn| {
        let task = NewTask {
            id: TASK,
            title: "Ship",
            project_id: "proj-1",
            due_date: None,
            due_time: None,
            priority: 1,
            repeat_config: None,
            tags: &[],
        };
        tasks::create(conn, &task, "device-a", NOW)?;
        conn.execute("DELETE FROM outbox", [])
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })?;
        Ok(())
    })
    .expect("a task");
    db
}

fn lose(
    conn: &Connection,
    field: &str,
    losing: &Value,
    winning: &Value,
) -> Result<Option<String>, StorageError> {
    let lost = LostField {
        task_id: TASK,
        field,
        losing,
        winning,
        merged_clock: &json!({"device-b": 1, "device-a": 2}),
    };
    record_superseded(conn, &lost, "device-a", NOW)
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).expect("a count")
}

/// The id Electron's `taskSupersededActivityId` returns for the same conflict
/// (run in Node): sha256 over `task-1\0title\0{"device-a":2,"device-b":1}`.
#[test]
fn the_id_is_electrons_for_the_same_conflict_whatever_the_key_order() {
    let id = "tac_5131b69ebe87f304cb43";
    assert_eq!(
        superseded_id(TASK, "title", &json!({"device-a": 2, "device-b": 1})),
        id
    );
    assert_eq!(
        superseded_id(TASK, "title", &json!({"device-b": 1, "device-a": 2})),
        id
    );
}

/// `packages/contracts/test-vectors/task-superseded-id.json`, which Electron's
/// `taskSupersededActivityId` writes (`apps/desktop/scripts/task-superseded-oracle/`).
#[test]
fn every_id_vector_matches_electron() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/contracts/test-vectors/task-superseded-id.json"
    );
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("the vector file"))
            .expect("json");
    let cases = file["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 10);
    for case in cases {
        let id = superseded_id(
            case["taskId"].as_str().expect("taskId"),
            case["field"].as_str().expect("field"),
            &case["mergedClock"],
        );
        assert_eq!(
            id,
            case["expected"].as_str().expect("expected"),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn a_lost_field_is_one_row_with_its_outbox_row_and_a_second_write_is_a_no_op() {
    let db = vault_with_task();
    db.call_blocking(|conn| {
        let first = lose(conn, "title", &json!("Mine"), &json!("Theirs"))?;
        let id = superseded_id(TASK, "title", &json!({"device-a": 2, "device-b": 1}));
        assert_eq!(first.as_deref(), Some(id.as_str()));
        assert_eq!(lose(conn, "title", &json!("Mine"), &json!("Theirs"))?, None);

        let row: (String, String, String, String, String, String) = conn
            .query_row(
                "SELECT task_id, action, field, old_value, new_value, actor FROM task_activity",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .expect("one row");
        assert_eq!(
            row,
            (
                TASK.to_owned(),
                "superseded".to_owned(),
                "title".to_owned(),
                r#""Mine""#.to_owned(),
                r#""Theirs""#.to_owned(),
                "sync".to_owned(),
            )
        );
        assert_eq!(count(conn, "SELECT COUNT(*) FROM task_activity"), 1);
        assert_eq!(
            count(
                conn,
                "SELECT COUNT(*) FROM outbox WHERE item_type = 'task_activity'"
            ),
            1
        );
        Ok(())
    })
    .expect("the rows");
}

#[test]
fn a_description_is_a_length_delta_and_the_noise_fields_write_nothing() {
    let db = vault_with_task();
    db.call_blocking(|conn| {
        let body = lose(conn, "description", &json!("abcdef"), &json!("a😀"))?;
        assert!(body.is_some());
        let (old, new): (Option<String>, String) = conn
            .query_row(
                "SELECT old_value, new_value FROM task_activity WHERE field = 'description'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the row");
        assert_eq!((old, new.as_str()), (None, r#"{"delta":-3}"#));

        assert_eq!(lose(conn, "position", &json!(1), &json!(2))?, None);
        assert_eq!(lose(conn, "modifiedAt", &json!("x"), &json!("y"))?, None);
        assert_eq!(count(conn, "SELECT COUNT(*) FROM task_activity"), 1);
        Ok(())
    })
    .expect("the rows");
}

#[test]
fn a_task_deleted_here_gets_no_row() {
    let db = vault_with_task();
    db.call_blocking(|conn| {
        tasks::delete(conn, TASK, "device-a", NOW + 1)?;
        assert_eq!(lose(conn, "title", &json!("Mine"), &json!("Theirs"))?, None);
        assert_eq!(count(conn, "SELECT COUNT(*) FROM task_activity"), 0);
        Ok(())
    })
    .expect("the rows");
}

/// The mirrored conflict's other row arrives under the same id with a
/// concurrent clock. Desktop inserts only an absent id
/// (`task-activity-handler.ts:55-56`): the held row stays and nothing is
/// queued, where a merge would re-queue a row this device did not author.
#[test]
fn a_peers_copy_of_a_held_row_is_skipped_and_not_requeued() {
    let db = vault_with_task();
    db.call_blocking(|conn| {
        let id = lose(conn, "title", &json!("Mine"), &json!("Theirs"))?.expect("a row");
        conn.execute("DELETE FROM outbox", [])
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })?;
        let held = sync_items::load(conn, "task_activity", &id)?
            .and_then(|row| row.payload)
            .expect("the held payload");
        let mut peer: Value = serde_json::from_str(&held).expect("json");
        peer["clock"] = json!({"device-b": 1});
        peer["deviceId"] = json!("device-b");
        peer["oldValue"] = json!(r#""Theirs""#);
        peer["newValue"] = json!(r#""Mine""#);
        let record = InboundRecord {
            item_type: "task_activity".to_owned(),
            item_id: id.clone(),
            payload_json: peer.to_string(),
            server_cursor: Some(1),
            signer_device_id: Some("device-b".to_owned()),
            updated_at: NOW + 1,
            deleted_at: None,
        };

        assert_eq!(
            apply_inbound(conn, &record, NOW + 1)?,
            ApplyOutcome::Skipped
        );
        let kept = sync_items::load(conn, "task_activity", &id)?.and_then(|row| row.payload);
        assert_eq!(kept.as_deref(), Some(held.as_str()));
        assert_eq!(count(conn, "SELECT COUNT(*) FROM outbox"), 0);
        Ok(())
    })
    .expect("the rows");
}
