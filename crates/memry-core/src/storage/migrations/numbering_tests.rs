//! Data migration numbering (#4052): main shipped `calendar_cursor_reset` and
//! `calendar_foreign_cursor_reset` as 13 and 14, while feat/tauri-v2 builds had used 13..22
//! for their own. Files written under either numbering open through [`open_data`], the real
//! entry point, and end with the schema of a fresh database, every row and the calendar cursors
//! reset.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::*;
use crate::storage::open_data;
use crate::storage::test_support::{TempDir, temp_dir};

/// feat/tauri-v2's own data migrations, in the order its earlier builds numbered them 13..22.
const FEAT_OWN: [&str; 10] = [
    "note_snapshots",
    "local_settings",
    "note_files",
    "notes_device_tables",
    "note_file_hashes",
    "note_identity",
    "wiki_name_keys",
    "vault_locks",
    "note_large_files",
    "note_file_marks",
];

fn copy(migration: &Migration, version: u32) -> Migration {
    Migration {
        version,
        name: migration.name,
        sql: migration.sql,
    }
}

fn shared() -> impl Iterator<Item = Migration> {
    DATA_MIGRATIONS[..12].iter().map(|m| copy(m, m.version))
}

/// The list a feat/tauri-v2 build before #4052 ran: 1..12 as main, then its own at 13..22.
fn earlier_feat_list() -> Vec<Migration> {
    let own = FEAT_OWN.iter().zip(13..).map(|(name, version)| {
        let migration = DATA_MIGRATIONS
            .iter()
            .find(|m| m.name == *name)
            .unwrap_or_else(|| panic!("no data migration named {name}"));
        copy(migration, version)
    });
    shared().chain(own).collect()
}

/// The list main shipped (v2026-11-06): 1..12, then the two calendar cursor resets.
fn main_list() -> Vec<Migration> {
    shared()
        .chain([
            Migration {
                version: 13,
                name: "calendar_cursor_reset",
                sql: include_str!("data/0013_calendar_cursor_reset.sql"),
            },
            Migration {
                version: 14,
                name: "calendar_foreign_cursor_reset",
                sql: include_str!("data/0014_calendar_foreign_cursor_reset.sql"),
            },
        ])
        .collect()
}

fn has_table(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = ?1",
        [name],
        |row| row.get::<_, i64>(0),
    )
    .expect("schema")
        == 1
}

/// Every table, index and trigger with its SQL: equal schemas mean no migration was skipped.
fn schema(conn: &Connection) -> Vec<(String, String, Option<String>)> {
    let mut statement = conn
        .prepare(
            "SELECT type, name, sql FROM sqlite_schema
             WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .expect("prepare");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

fn fresh_schema() -> Vec<(String, String, Option<String>)> {
    let mut conn = Connection::open_in_memory().expect("open");
    run(&mut conn, DATA_MIGRATIONS).expect("migrate");
    schema(&conn)
}

/// The rows a user's file holds; a row goes only into a table the file has.
const ROWS: [(&str, &str); 6] = [
    (
        "meta",
        "INSERT INTO meta (key, value) VALUES ('device.id', 'dev-1')",
    ),
    (
        "note_snapshots",
        "INSERT INTO note_snapshots (id, note_id, content, title, content_hash, reason, created_at)
         VALUES ('s1', 'n1', 'body', 'Plan', 'h', 'manual', '2026-11-01T00:00:00Z')",
    ),
    (
        "local_settings",
        "INSERT INTO local_settings (key, value, updated_at) VALUES ('general', '{}', 1)",
    ),
    (
        "note_files",
        "INSERT INTO note_files (note_id, path, indexed_at) VALUES ('n1', 'Plan.md', 1)",
    ),
    (
        "vault_locks",
        "INSERT INTO vault_locks (id, target_kind, target, locked, created_at, updated_at)
         VALUES ('note:n1', 'note', 'n1', 1, 1, 1)",
    ),
    (
        "note_large_files",
        "INSERT INTO note_large_files (note_id) VALUES ('n1')",
    ),
];

const CALENDAR: &str = "
    INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
    VALUES ('calendar_source', 'src-1',
            '{\"provider\":\"google\",\"kind\":\"calendar\",\"syncCursor\":\"tok-1\"}',
            'full', 1);
    INSERT INTO calendar_sources (id, provider, kind, remote_id, sync_cursor)
    VALUES ('src-1', 'google', 'calendar', 'work@example.com', 'tok-1');";

/// A `data.db` file as a build running `list` left it at `version`, with rows in it.
fn file_at(list: &[Migration], version: u32) -> (TempDir, PathBuf, Vec<&'static str>) {
    let dir = temp_dir("numbering");
    let path = dir.path().join("data.db");
    let mut conn = Connection::open(&path).expect("create");
    assert_eq!(
        run(&mut conn, &list[..version as usize]).expect("migrate"),
        version
    );
    conn.execute_batch(CALENDAR).expect("a calendar");
    let mut seeded = Vec::new();
    for (table, sql) in ROWS {
        if has_table(&conn, table) {
            conn.execute_batch(sql).expect(table);
            seeded.push(table);
        }
    }
    (dir, path, seeded)
}

fn cursors(conn: &Connection) -> (Option<String>, Option<String>) {
    conn.query_row(
        "SELECT (SELECT json_extract(payload, '$.syncCursor') FROM sync_items
                  WHERE item_id = 'src-1'),
                (SELECT sync_cursor FROM calendar_sources WHERE id = 'src-1')",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .expect("cursors")
}

fn assert_same_schema(
    found: &[(String, String, Option<String>)],
    expected: &[(String, String, Option<String>)],
    what: &str,
) {
    let missing: Vec<_> = expected.iter().filter(|o| !found.contains(o)).collect();
    let extra: Vec<_> = found.iter().filter(|o| !expected.contains(o)).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "{what}: schema differs; missing {missing:?}, extra {extra:?}"
    );
}

/// Opens the file through the app's entry point and checks it ended complete with its rows.
fn open_and_check(path: &Path, seeded: &[&str], what: &str) -> Connection {
    drop(open_data(path).unwrap_or_else(|err| panic!("{what}: open: {err}")));
    let conn = Connection::open(path).expect("a reader");
    assert_eq!(
        user_version(&conn).expect("version"),
        latest_version(DATA_MIGRATIONS),
        "{what}"
    );
    assert_same_schema(&schema(&conn), &fresh_schema(), what);
    for table in seeded {
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("count");
        assert_eq!(count, 1, "{what}: a row of {table} was lost");
    }
    conn
}

/// After the first open this device pulls again and stores a new cursor. A later open must
/// keep it: the numbering is settled once, not on every open.
fn reopen_keeps_a_later_cursor(path: &Path, conn: Connection, what: &str) {
    conn.execute_batch(
        "UPDATE sync_items SET payload = json_set(payload, '$.syncCursor', 'tok-2')
          WHERE item_id = 'src-1';
         UPDATE calendar_sources SET sync_cursor = 'tok-2' WHERE id = 'src-1';",
    )
    .expect("a later pull");
    let before = schema(&conn);
    drop(conn);
    drop(open_data(path).expect("reopen"));
    let conn = Connection::open(path).expect("a reader");
    assert_eq!(
        user_version(&conn).expect("version"),
        latest_version(DATA_MIGRATIONS),
        "{what}"
    );
    assert_same_schema(&schema(&conn), &before, what);
    assert_eq!(
        cursors(&conn),
        (Some("tok-2".to_owned()), Some("tok-2".to_owned())),
        "{what}: the reopen ran the cursor resets again"
    );
}

/// Test machines hold files an earlier feat/tauri-v2 build migrated under its own numbering:
/// `note_snapshots` at 13 and on to `note_file_marks` at 22. They keep every row, gain what
/// they lack, and get main's calendar cursor resets.
#[test]
fn a_file_numbered_by_an_earlier_feat_build_is_renumbered_once_and_gets_mains_resets() {
    let list = earlier_feat_list();
    for version in 13..=22 {
        for crashed in [false, true] {
            let what = format!("earlier feat numbering at {version}, crash window {crashed}");
            let (_dir, path, seeded) = file_at(&list, version);
            // From old 17 on the hashes are kept apart from `note_files`, so a hash with no
            // `note_file_hashes` row stays without one. Re-running `note_file_hashes` would
            // backfill it: the file must land past the migrations it ran, not one short.
            let hashes_owned = version >= 17;
            if hashes_owned {
                let conn = Connection::open(&path).expect("open");
                conn.execute_batch("UPDATE note_files SET content_hash = 'h-1'")
                    .expect("a hash");
            }
            if crashed && let Some(next) = list.get(version as usize) {
                let conn = Connection::open(&path).expect("open");
                conn.execute_batch(next.sql)
                    .expect("the next migration commits");
            }

            let conn = open_and_check(&path, &seeded, &what);
            assert_eq!(cursors(&conn), (None, None), "{what}: cursors not reset");
            if hashes_owned {
                assert!(
                    !file_hash_backfilled(&conn),
                    "{what}: an old migration ran again"
                );
            }
            reopen_keeps_a_later_cursor(&path, conn, &what);
        }
    }
}

fn file_hash_backfilled(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM note_file_hashes WHERE note_id = 'n1')",
        [],
        |row| row.get(0),
    )
    .expect("note_file_hashes")
}

/// A file at an old version that lacks the table of an earlier old migration did not come
/// from an earlier build, whatever its counter says. It is refused and left as found.
#[test]
fn an_old_numbered_file_missing_an_earlier_table_is_refused_untouched() {
    let list = earlier_feat_list();
    let (_dir, path, _) = file_at(&list, 17);
    let conn = Connection::open(&path).expect("open");
    conn.execute_batch("DROP TABLE local_settings")
        .expect("drop old 14's table");
    drop(conn);

    let err = open_data(&path)
        .err()
        .expect("a file missing local_settings must not open");
    assert!(
        matches!(&err, StorageError::Migration { what, .. } if what.contains("local_settings")),
        "{err:?}"
    );
    let conn = Connection::open(&path).expect("a reader");
    assert_eq!(user_version(&conn).expect("version"), 17);
    assert_eq!(
        cursors(&conn),
        (Some("tok-1".to_owned()), Some("tok-1".to_owned()))
    );
    assert!(!has_table(&conn, "local_settings"), "no migration ran");
}

/// iOS and the CLI on main leave `data.db` at 13 or 14; a desktop build opening it adds the
/// tables main does not have. A file at 13 still owes 14's reset; a file at 14 owes none, so
/// the cursor its device pulled since stays.
#[test]
fn a_file_main_left_at_13_or_14_gains_the_desktop_tables() {
    let list = main_list();
    for (version, cursor) in [(13, None), (14, Some("tok-1".to_owned()))] {
        let what = format!("main at {version}");
        let (_dir, path, seeded) = file_at(&list, version);
        assert_eq!(seeded, ["meta"], "main has none of the desktop tables");

        let conn = open_and_check(&path, &seeded, &what);
        assert_eq!(cursors(&conn), (cursor.clone(), cursor), "{what}");
        reopen_keeps_a_later_cursor(&path, conn, &what);
    }
}

/// A file this numbering wrote is never mistaken for an earlier one, at any version and in
/// the crash window of §A.0, where the next migration has committed and its counter has not.
#[test]
fn a_file_under_this_numbering_is_never_renumbered() {
    for version in 12..latest_version(DATA_MIGRATIONS) {
        for crashed in [false, true] {
            let what = format!("this numbering at {version}, crash window {crashed}");
            let (_dir, path, seeded) = file_at(DATA_MIGRATIONS, version);
            if crashed {
                let conn = Connection::open(&path).expect("open");
                conn.execute_batch(DATA_MIGRATIONS[version as usize].sql)
                    .expect("the next migration commits");
            }

            let conn = open_and_check(&path, &seeded, &what);
            reopen_keeps_a_later_cursor(&path, conn, &what);
        }
    }
}
