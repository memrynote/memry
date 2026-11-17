//! Data migration 0033, `canvases` (Step 30d, #3547), through the real open of
//! a `data.db` file: canvases a build before it synced are filled in by the
//! projector replay, not by SQL, and survive a crash at any step.

use rusqlite::Connection;

use super::*;
use crate::domain::canvas;
use crate::storage::{open_data, test_support::temp_dir};

const BEFORE: usize = 32;

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: err.to_string(),
    }
}

fn payload(id: &str, title: &str, folder: &str) -> String {
    format!(
        r#"{{"id":"{id}","vaultId":"vault-1","title":"{title}","scene":"{{\"elements\":[]}}","folder":"{folder}","icon":"🎨","ownerNoteId":null,"clock":{{"A":1}},"deletedAt":null}}"#
    )
}

/// A `data.db` as the build before 0033 leaves it, holding three synced
/// canvases (one deleted) and a note.
fn older_file(path: &std::path::Path) {
    let mut conn = Connection::open(path).expect("open");
    let version = run(&mut conn, &DATA_MIGRATIONS[..BEFORE]).expect("older migrations");
    assert_eq!(version, 32);
    let rows = [
        ("old", payload("old", "Old", "Work/"), 1_000, None),
        ("new", payload("new", "New", "Work//Q3"), 3_000, None),
        ("gone", payload("gone", "Gone", ""), 2_000, Some(2_500)),
    ];
    for (id, body, updated_at, deleted_at) in rows {
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at, deleted_at)
             VALUES ('canvas', ?1, ?2, 'full', ?3, ?4)",
            rusqlite::params![id, body, updated_at, deleted_at],
        )
        .expect("a canvas the older build synced");
    }
    conn.execute(
        "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
         VALUES ('note', 'n1', '{\"title\":\"Plan\"}', 'full', 1)",
        [],
    )
    .expect("a note");
}

type Row = (
    String,
    String,
    Option<String>,
    Option<String>,
    i64,
    i64,
    Option<i64>,
);

fn rows(conn: &Connection) -> Result<Vec<Row>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id, vault_id, title, folder, created_at, updated_at, deleted_at
             FROM canvases ORDER BY id",
        )
        .map_err(failed)?;
    statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

fn pending(conn: &Connection) -> Result<i64, StorageError> {
    conn.query_row("SELECT COUNT(*) FROM pending_reprojections", [], |row| {
        row.get(0)
    })
    .map_err(failed)
}

fn expected() -> Vec<Row> {
    let row = |id: &str, title: &str, folder: Option<&str>, at: i64, deleted: Option<i64>| {
        (
            id.to_owned(),
            "vault-1".to_owned(),
            Some(title.to_owned()),
            folder.map(str::to_owned),
            at,
            at,
            deleted,
        )
    };
    vec![
        row("gone", "Gone", None, 2_000, Some(2_500)),
        row("new", "New", Some("Work/Q3"), 3_000, None),
        row("old", "Old", Some("Work"), 1_000, None),
    ]
}

#[test]
fn opening_an_older_file_projects_the_canvases_it_already_holds() {
    let dir = temp_dir("canvases-migration");
    let path = dir.path().join("data.db");
    older_file(&path);

    let db = open_data(&path).expect("open steps forward");
    db.call_blocking(|conn| {
        assert_eq!(user_version(conn)?, latest_version(DATA_MIGRATIONS));
        assert_eq!(rows(conn)?, expected());
        assert_eq!(pending(conn)?, 0, "the replay clears its marker");
        // The list keeps the order the canvases had, and reads no scene.
        let listed: Vec<String> = canvas::list(conn, "vault-1")?
            .into_iter()
            .map(|canvas| canvas.id)
            .collect();
        assert_eq!(listed, ["new", "old"]);
        assert_eq!(
            canvas::get(conn, "old")?.expect("live").scene,
            r#"{"elements":[]}"#
        );
        Ok(())
    })
    .expect("projected");
}

/// A crash after 0033 commits and before its `user_version` write re-runs the
/// migration; a crash before the replay commits leaves the marker. Either
/// way the next open ends with the same rows, and a later local edit is not
/// undone by a replay.
#[test]
fn a_crash_at_any_step_converges_on_the_next_open() {
    let dir = temp_dir("canvases-migration-crash");
    let path = dir.path().join("data.db");
    older_file(&path);
    {
        let mut conn = Connection::open(&path).expect("open");
        let tx = conn.transaction().expect("tx");
        tx.execute_batch(DATA_MIGRATIONS[BEFORE].sql)
            .expect("0033 commits");
        tx.commit().expect("commit");
        // Crash: `user_version` still says 32 and nothing is projected.
        assert_eq!(user_version(&conn).expect("version"), 32);
    }
    let db = open_data(&path).expect("the re-run is a no-op that then replays");
    db.call_blocking(|conn| {
        assert_eq!(rows(conn)?, expected());
        // A crash before the replay committed: the marker is back, and a
        // second replay changes nothing.
        conn.execute("INSERT INTO pending_reprojections VALUES ('canvas')", [])
            .map_err(failed)?;
        Ok(())
    })
    .expect("first open");
    drop(db);
    let db = open_data(&path).expect("reopen");
    db.call_blocking(|conn| {
        assert_eq!(rows(conn)?, expected());
        assert_eq!(pending(conn)?, 0);
        Ok(())
    })
    .expect("converged");
}

/// A file a newer build wrote keeps its markers: they may name a type this
/// build has no projector for.
#[test]
fn a_newer_files_markers_are_left_for_the_newer_build() {
    let db = crate::storage::Db::open_in_memory().expect("open");
    db.call_blocking(|conn| {
        run(conn, DATA_MIGRATIONS)?;
        conn.execute_batch(
            "INSERT INTO pending_reprojections VALUES ('hologram');
             INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
               VALUES ('hologram', 'h1', '{}', 'full', 1);",
        )
        .map_err(failed)?;
        conn.execute_batch(&format!(
            "PRAGMA user_version = {}",
            latest_version(DATA_MIGRATIONS) + 1
        ))
        .map_err(failed)?;
        assert_eq!(sync_items::reproject_pending(conn)?, 0);
        assert_eq!(pending(conn)?, 1);
        let corrupt: Option<String> = conn
            .query_row(
                "SELECT corrupt_reason FROM sync_items WHERE item_id = 'h1'",
                [],
                |row| row.get(0),
            )
            .map_err(failed)?;
        assert_eq!(corrupt, None);
        Ok(())
    })
    .expect("left alone");
}
