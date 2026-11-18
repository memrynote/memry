//! `record_superseded` (Step 21d, #3538) against Electron's
//! `activity-log.ts` `recordTaskSuperseded` and `taskSupersededActivityId`.

use memry_core::api::errors::StorageError;
use memry_core::domain::task_activity::superseded::{LostField, record_superseded, superseded_id};
use memry_core::domain::tasks::{self, NewTask};
use memry_core::storage::{Db, open_data};
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

/// The id Electron mints for the same conflict, computed with Node's
/// `createHash('sha256')` over `task-1 title {"device-a":2,"device-b":1}`.
#[test]
fn the_id_is_electrons_for_the_same_conflict_whatever_the_key_order() {
    let id = "tac_db9a5bc0d711e21d0841";
    assert_eq!(
        superseded_id(TASK, "title", &json!({"device-a": 2, "device-b": 1})),
        id
    );
    assert_eq!(
        superseded_id(TASK, "title", &json!({"device-b": 1, "device-a": 2})),
        id
    );
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
