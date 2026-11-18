//! Data migration 0037, `task_links`: the backfill, the triggers that keep it
//! current for any writer of `tasks` (a build older than the migration
//! included), and the index a lookup seeks.

use super::*;
use crate::storage::Db;

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: err.to_string(),
    }
}

/// `(task, type, target)` rows, sorted.
fn links(conn: &rusqlite::Connection) -> Result<Vec<(String, String, String)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT task_id, target_type, target_id FROM task_links
              ORDER BY task_id, target_type, target_id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    Ok(rows)
}

fn row(task: &str, kind: &str, target: &str) -> (String, String, String) {
    (task.to_owned(), kind.to_owned(), target.to_owned())
}

/// A task's projection row and its payload, written the way a projector of
/// any build writes them: payload first, then the `tasks` upsert.
fn write_task(conn: &rusqlite::Connection, id: &str, note_ids: &str, payload: &str) {
    conn.execute(
        "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
         VALUES ('task', ?1, ?2, 'full', 1)
         ON CONFLICT(item_type, item_id) DO UPDATE SET payload = excluded.payload",
        rusqlite::params![id, payload],
    )
    .expect("the payload");
    conn.execute(
        "INSERT INTO tasks (id, title, project_id, linked_note_ids) VALUES (?1, 't', 'p', ?2)
         ON CONFLICT(id) DO UPDATE SET linked_note_ids = excluded.linked_note_ids",
        rusqlite::params![id, note_ids],
    )
    .expect("the projection");
}

#[test]
fn the_migration_backfills_every_live_tasks_links_and_skips_what_will_not_read() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..33]))
        .expect("a database as the last build left it");
    db.call_blocking(|conn| {
        write_task(
            conn,
            "t1",
            r#"["n1","n2","n1"]"#,
            r#"{"linkedCanvasIds":["c1","c1"]}"#,
        );
        // Not JSON, not an array, not strings, empty: none is a link, none
        // fails the migration.
        write_task(conn, "t2", "not json", "not json either");
        write_task(conn, "t3", r#""n1""#, r#"{"linkedCanvasIds":"c1"}"#);
        write_task(
            conn,
            "t4",
            r#"[1,null,"",{"a":1}]"#,
            r#"{"linkedCanvasIds":[2]}"#,
        );
        // A tombstoned task links nothing.
        write_task(conn, "t5", r#"["n9"]"#, r#"{"linkedCanvasIds":["c9"]}"#);
        conn.execute("UPDATE tasks SET deleted_at = 5 WHERE id = 't5'", [])
            .map_err(failed)?;
        Ok(())
    })
    .expect("rows to keep");

    let version = db
        .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("step forward");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));
    let expected = vec![
        row("t1", "canvas", "c1"),
        row("t1", "note", "n1"),
        row("t1", "note", "n2"),
    ];
    assert_eq!(
        db.call_blocking(|conn| links(conn)).expect("links"),
        expected
    );

    // The re-run after a crash before the `user_version` write (§A.0).
    let migration = DATA_MIGRATIONS
        .iter()
        .find(|m| m.name == "task_links")
        .expect("the migration");
    db.call_blocking(|conn| conn.execute_batch(migration.sql).map_err(failed))
        .expect("idempotent");
    assert_eq!(
        db.call_blocking(|conn| links(conn)).expect("links"),
        expected
    );
}

/// What an older build does to `tasks` after this migration ran: it knows no
/// `task_links`, and its writes still keep the table exact.
#[test]
fn every_write_to_tasks_keeps_the_links_exact_whoever_writes_it() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, DATA_MIGRATIONS).map(drop))
        .expect("migrate");
    let after = db
        .call_blocking(|conn| {
            write_task(conn, "t1", r#"["n1"]"#, r#"{"linkedCanvasIds":["c1"]}"#);
            write_task(conn, "t2", r#"["n1","n2"]"#, "{}");
            // An edit replaces the task's targets.
            write_task(conn, "t1", r#"["n3"]"#, r#"{"linkedCanvasIds":[]}"#);
            // A tombstone clears them, an un-delete brings them back.
            conn.execute("UPDATE tasks SET deleted_at = 9 WHERE id = 't2'", [])
                .map_err(failed)?;
            let tombstoned = links(conn)?;
            conn.execute("UPDATE tasks SET deleted_at = NULL WHERE id = 't2'", [])
                .map_err(failed)?;
            // A writer's own conflict clause cannot make a trigger fail.
            conn.execute(
                "INSERT OR REPLACE INTO tasks (id, title, project_id, linked_note_ids)
                 VALUES ('t3', 't', 'p', '[\"n4\",\"n4\"]')",
                [],
            )
            .map_err(failed)?;
            conn.execute(
                "INSERT OR REPLACE INTO tasks (id, title, project_id, linked_note_ids)
                 VALUES ('t3', 't', 'p', '[\"n5\"]')",
                [],
            )
            .map_err(failed)?;
            conn.execute(
                "UPDATE OR ROLLBACK tasks SET linked_note_ids = '[\"n6\",\"n6\"]' WHERE id = 't3'",
                [],
            )
            .map_err(failed)?;
            conn.execute("DELETE FROM tasks WHERE id = 't1'", [])
                .map_err(failed)?;
            Ok((tombstoned, links(conn)?))
        })
        .expect("writes");
    assert_eq!(after.0, vec![row("t1", "note", "n3")]);
    assert_eq!(
        after.1,
        vec![
            row("t2", "note", "n1"),
            row("t2", "note", "n2"),
            row("t3", "note", "n6"),
        ]
    );
}

#[test]
fn a_lookup_by_target_seeks_the_index() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, DATA_MIGRATIONS).map(drop))
        .expect("migrate");
    let plan: Vec<String> = db
        .call_blocking(|conn| {
            let mut statement = conn
                .prepare(&format!(
                    "EXPLAIN QUERY PLAN {}",
                    crate::domain::task_links::TASKS_LINKED_TO
                ))
                .map_err(failed)?;
            let plan = statement
                .query_map(["note", "n1"], |row| row.get::<_, String>(3))
                .map_err(failed)?
                .collect::<Result<_, _>>()
                .map_err(failed)?;
            Ok(plan)
        })
        .expect("the plan");
    assert!(
        plan.iter()
            .any(|step| step.starts_with("SEARCH l USING COVERING INDEX idx_task_links_target")),
        "{plan:?}"
    );
}

/// The triggers skip what will not read on every write, so no task write
/// fails on a stored value, in this build or an older one.
#[test]
fn a_task_write_with_values_that_will_not_read_adds_no_link_and_never_fails() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, DATA_MIGRATIONS).map(drop))
        .expect("migrate");
    let rows = db
        .call_blocking(|conn| {
            for (id, note_ids, payload) in [
                ("t1", "not json", "not json either"),
                ("t2", r#""n1""#, r#"{"linkedCanvasIds":"c1"}"#),
                ("t3", r#"[1,null,""]"#, r#"{"linkedCanvasIds":[1,null,""]}"#),
                ("t4", "[", "{"),
            ] {
                // Insert, then the projector's upsert update.
                write_task(conn, id, note_ids, payload);
                write_task(conn, id, note_ids, payload);
                conn.execute(
                    "INSERT OR REPLACE INTO tasks (id, title, project_id, linked_note_ids)
                     VALUES (?1, 't', 'p', ?2)",
                    rusqlite::params![id, note_ids],
                )
                .map_err(failed)?;
                conn.execute(
                    "UPDATE tasks SET title = 'u', deleted_at = NULL WHERE id = ?1",
                    [id],
                )
                .map_err(failed)?;
            }
            let rows = links(conn)?;
            conn.execute("DELETE FROM tasks", []).map_err(failed)?;
            Ok(rows)
        })
        .expect("every write");
    assert!(rows.is_empty(), "{rows:?}");
}
