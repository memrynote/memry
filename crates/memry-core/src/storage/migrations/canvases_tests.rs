//! Data migration 0037, `canvases` (Step 30d, #3547), through the real open of
//! a `data.db` file: every open projects the canvas payloads that have no
//! current `canvases` row ([`sync_items::heal_projections`]), whoever wrote
//! them: a build before 0037, an older build opening this file, a recovery's
//! salvage, or a crash.

use rusqlite::Connection;

use super::*;
use crate::domain::canvas;
use crate::storage::{open_data, test_support::temp_dir};

/// How many migrations come before `canvases`: its number moves when another
/// lane's migration lands first.
fn before() -> usize {
    DATA_MIGRATIONS
        .iter()
        .position(|migration| migration.name == "canvases")
        .expect("the canvases migration")
}

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

/// A `data.db` as the build before 0037 leaves it, holding three synced
/// canvases (one deleted) and a note.
fn older_file(path: &std::path::Path) {
    let mut conn = Connection::open(path).expect("open");
    let version = run(&mut conn, &DATA_MIGRATIONS[..before()]).expect("older migrations");
    assert_eq!(version, DATA_MIGRATIONS[before() - 1].version);
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

/// A fresh `data.db` holds 0037's tables, and a fresh `index.db` 0012's.
#[test]
fn fresh_databases_hold_the_canvas_tables() {
    for (migrations, tables) in [
        (
            DATA_MIGRATIONS,
            &["canvases", "canvas_files", "canvas_assets"][..],
        ),
        (
            INDEX_MIGRATIONS,
            &["canvas_entity_refs", "canvas_entity_edges"][..],
        ),
    ] {
        let mut conn = Connection::open_in_memory().expect("open");
        run(&mut conn, migrations).expect("migrate");
        for table in tables {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("sqlite_master");
            assert_eq!(found, 1, "missing {table}");
        }
    }
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

/// A crash after 0037 commits and before its `user_version` write re-runs the
/// migration; a crash before the fill commits leaves no rows. Either way the
/// next open ends with the same rows.
#[test]
fn a_crash_at_any_step_converges_on_the_next_open() {
    let dir = temp_dir("canvases-migration-crash");
    let path = dir.path().join("data.db");
    older_file(&path);
    {
        let mut conn = Connection::open(&path).expect("open");
        let tx = conn.transaction().expect("tx");
        tx.execute_batch(DATA_MIGRATIONS[before()].sql)
            .expect("0037 commits");
        tx.commit().expect("commit");
        // Crash: `user_version` still names the migration before and nothing
        // is projected.
        assert_eq!(
            user_version(&conn).expect("version"),
            DATA_MIGRATIONS[before() - 1].version
        );
    }
    let db = open_data(&path).expect("the re-run is a no-op that then fills");
    db.call_blocking(|conn| {
        assert_eq!(rows(conn)?, expected());
        // A crash before the fill committed.
        conn.execute("DELETE FROM canvases", []).map_err(failed)?;
        Ok(())
    })
    .expect("first open");
    drop(db);
    let db = open_data(&path).expect("reopen");
    db.call_blocking(|conn| {
        assert_eq!(rows(conn)?, expected());
        assert_eq!(sync_items::heal_projections(conn)?, 0, "nothing left");
        Ok(())
    })
    .expect("converged");
}

/// An older build opens a migrated file (its `run` skips every version it
/// knows) and keeps writing canvas payloads with no projector: a new canvas
/// and an edit of a projected one. The next open of this build shows both.
#[test]
fn canvases_an_older_build_wrote_into_a_migrated_file_show_on_the_next_open() {
    let dir = temp_dir("canvases-older-build");
    let path = dir.path().join("data.db");
    older_file(&path);
    drop(open_data(&path).expect("migrate"));
    {
        let conn = Connection::open(&path).expect("the older build");
        conn.execute_batch(&format!(
            "UPDATE sync_items SET payload = '{}', updated_at = 4000
               WHERE item_type = 'canvas' AND item_id = 'old';
             INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
               VALUES ('canvas', 'later', '{}', 'full', 5000);",
            payload("old", "Renamed", "Work"),
            payload("later", "Later", ""),
        ))
        .expect("written without a projection");
    }
    let db = open_data(&path).expect("reopen");
    db.call_blocking(|conn| {
        let listed: Vec<(String, Option<String>)> = canvas::list(conn, "vault-1")?
            .into_iter()
            .map(|canvas| (canvas.id, canvas.title))
            .collect();
        assert_eq!(
            listed,
            [
                ("later".to_owned(), Some("Later".to_owned())),
                ("old".to_owned(), Some("Renamed".to_owned())),
                ("new".to_owned(), Some("New".to_owned())),
            ]
        );
        assert!(canvas::get(conn, "later")?.is_some());
        Ok(())
    })
    .expect("healed");
}

/// A recovery migrates an empty fresh file, then salvages the quarantined
/// file's payloads into it; a quarantine from before 0037 has no `canvases`
/// table to salvage. The open after the recovery projects them.
#[test]
fn a_recovery_from_an_older_file_shows_its_canvases() {
    let dir = temp_dir("canvases-recovery");
    let path = dir.path().join("data.db");
    older_file(&path);
    crate::storage::recovery::quarantine_and_rebuild(&path).expect("recover");
    let db = open_data(&path).expect("open the recovered file");
    db.call_blocking(|conn| {
        assert_eq!(rows(conn)?, expected());
        Ok(())
    })
    .expect("recovered");
}

/// A file a newer build wrote is left alone: its projector may differ.
#[test]
fn a_newer_file_is_not_filled() {
    let db = crate::storage::Db::open_in_memory().expect("open");
    db.call_blocking(|conn| {
        run(conn, DATA_MIGRATIONS)?;
        conn.execute(
            "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
             VALUES ('canvas', 'c1', ?1, 'full', 1)",
            [payload("c1", "Newer", "")],
        )
        .map_err(failed)?;
        conn.execute_batch(&format!(
            "PRAGMA user_version = {}",
            latest_version(DATA_MIGRATIONS) + 1
        ))
        .map_err(failed)?;
        assert_eq!(sync_items::heal_projections(conn)?, 0);
        assert!(rows(conn)?.is_empty());
        Ok(())
    })
    .expect("left alone");
}
