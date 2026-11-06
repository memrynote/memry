//! Migration 20 on a real `data.db` (Step 14e-1): the lock tables carry every
//! column the `vault_lock` record and the desktop lock guard need, and an
//! existing database at version 19 gains them with its rows kept.

use memry_core::api::vault::Vault;
use memry_core::storage::migrations::{DATA_MIGRATIONS, run, user_version};
use rusqlite::Connection;

fn scratch() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("memry-locks-schema-")
        .tempdir()
        .expect("the scratch directory")
}

/// `(name, type, not null, primary key)` of each column, in order.
fn columns(conn: &Connection, table: &str) -> Vec<(String, String, bool, bool)> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .expect("prepare");
    statement
        .query_map([], |row| {
            Ok((
                row.get(1)?,
                row.get(2)?,
                row.get::<_, i64>(3)? != 0,
                row.get::<_, i64>(5)? != 0,
            ))
        })
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

fn col(name: &str, kind: &str, not_null: bool, key: bool) -> (String, String, bool, bool) {
    (name.to_owned(), kind.to_owned(), not_null, key)
}

#[test]
fn the_lock_tables_have_every_column_and_the_target_index() {
    let dir = scratch();
    drop(Vault::open("v".to_owned(), dir.path().display().to_string()).expect("open"));
    let conn = Connection::open(dir.path().join("data.db")).expect("a reader");

    assert_eq!(
        columns(&conn, "vault_locks"),
        vec![
            col("id", "TEXT", false, true),
            col("target_kind", "TEXT", true, false),
            col("target", "TEXT", true, false),
            col("locked", "INTEGER", true, false),
            col("created_at", "INTEGER", true, false),
            col("updated_at", "INTEGER", true, false),
            col("clock", "TEXT", false, false),
            col("synced_at", "INTEGER", false, false),
            col("deleted_at", "INTEGER", false, false),
        ]
    );
    let index: (bool, String) = conn
        .query_row(
            "SELECT l.\"unique\", group_concat(i.name, ',' ORDER BY i.seqno)
             FROM pragma_index_list('vault_locks') l, pragma_index_info(l.name) i
             WHERE l.name = 'idx_vault_locks_target'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the target index");
    assert_eq!(
        index,
        (false, "target_kind,target".to_owned()),
        "not unique"
    );

    assert_eq!(
        columns(&conn, "vault_lock_baselines"),
        vec![
            col("note_id", "TEXT", false, true),
            col("content_hash", "TEXT", true, false),
            col("content", "TEXT", true, false),
            col("updated_at", "INTEGER", true, false),
        ]
    );
    assert_eq!(
        columns(&conn, "vault_lock_file_modes"),
        vec![
            col("path", "TEXT", false, true),
            col("mode", "INTEGER", true, false),
            col("identity", "TEXT", false, false),
        ]
    );
}

#[test]
fn a_version_19_database_gains_the_lock_tables_and_keeps_its_rows() {
    let dir = scratch();
    let path = dir.path().join("data.db");
    {
        let mut conn = Connection::open(&path).expect("create");
        assert_eq!(run(&mut conn, &DATA_MIGRATIONS[..19]).expect("to 19"), 19);
        conn.execute_batch(
            "INSERT INTO notes (id, title) VALUES ('n1', 'Plan');
             INSERT INTO journal_entries (id, date) VALUES ('j2026-01-02', '2026-01-02');",
        )
        .expect("rows to keep");
    }

    drop(Vault::open("v".to_owned(), dir.path().display().to_string()).expect("open"));

    let conn = Connection::open(&path).expect("a reader");
    assert_eq!(user_version(&conn).expect("version"), 20);
    let kept: (String, String) = conn
        .query_row(
            "SELECT (SELECT title FROM notes WHERE id = 'n1'),
                    (SELECT date FROM journal_entries WHERE id = 'j2026-01-02')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the rows");
    assert_eq!(kept, ("Plan".to_owned(), "2026-01-02".to_owned()));
    let locks: i64 = conn
        .query_row("SELECT COUNT(*) FROM vault_locks", [], |row| row.get(0))
        .expect("count");
    assert_eq!(
        locks, 0,
        "nothing is locked until the owner locks something"
    );
}
