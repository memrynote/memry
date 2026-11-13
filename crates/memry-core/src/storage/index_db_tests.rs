use super::*;
use crate::storage::migrations::user_version;
use crate::storage::test_support::temp_dir;
use std::fs;

/// The files in `dir` whose name starts with `prefix`, sorted.
fn named(dir: &Path, prefix: &str) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .expect("dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(prefix))
        .collect();
    names.sort();
    names
}

fn row_count(db: &Db) -> i64 {
    db.call_blocking(|conn| {
        conn.query_row("SELECT COUNT(*) FROM index_meta", [], |row| row.get(0))
            .map_err(|err| StorageError::Failed {
                what: err.to_string(),
            })
    })
    .expect("count")
}

fn mark(db: &Db) {
    db.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO index_meta (key, value) VALUES ('data.user_version', '2')",
            [],
        )
        .map_err(|err| StorageError::Failed {
            what: err.to_string(),
        })
    })
    .expect("mark");
}

#[test]
fn a_missing_file_is_built_and_reported_as_a_rebuild() {
    let dir = temp_dir("index-missing");
    let opened = open_or_rebuild(&dir.path().join("index.db")).expect("open");

    assert!(opened.rebuild_reason.is_some());
    let version = opened
        .db
        .call_blocking(|conn| user_version(conn))
        .expect("version");
    assert_eq!(version, migrations::latest_version(INDEX_MIGRATIONS));
}

#[test]
fn a_good_file_is_reused() {
    let dir = temp_dir("index-reuse");
    let path = dir.path().join("index.db");

    let first = open_or_rebuild(&path).expect("first open");
    mark(&first.db);
    drop(first);

    let second = open_or_rebuild(&path).expect("second open");
    assert!(second.rebuild_reason.is_none());
    assert_eq!(row_count(&second.db), 1);
}

#[test]
fn an_unexpected_version_is_deleted_and_rebuilt() {
    let dir = temp_dir("index-version");
    let path = dir.path().join("index.db");

    let first = open_or_rebuild(&path).expect("first open");
    mark(&first.db);
    // A file written by a future build.
    first
        .db
        .call_blocking(|conn| {
            conn.execute_batch("PRAGMA user_version = 99")
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        })
        .expect("bump");
    drop(first);

    let second = open_or_rebuild(&path).expect("second open");
    assert!(
        second
            .rebuild_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("99"))
    );
    assert_eq!(row_count(&second.db), 0);
}

#[test]
fn a_corrupt_file_is_deleted_and_rebuilt() {
    let dir = temp_dir("index-corrupt");
    let path = dir.path().join("index.db");
    fs::write(&path, b"this is not a SQLite database").expect("write garbage");

    let opened = open_or_rebuild(&path).expect("open");

    assert!(opened.rebuild_reason.is_some());
    assert_eq!(row_count(&opened.db), 0);
    let version = opened
        .db
        .call_blocking(|conn| user_version(conn))
        .expect("version");
    assert_eq!(version, migrations::latest_version(INDEX_MIGRATIONS));
}

#[test]
fn a_stale_wal_does_not_follow_into_the_rebuilt_index() {
    let dir = temp_dir("index-sidecar");
    let path = dir.path().join("index.db");

    let first = open_or_rebuild(&path).expect("first open");
    first
        .db
        .call_blocking(|conn| {
            conn.execute_batch("PRAGMA user_version = 99")
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        })
        .expect("bump");
    drop(first);
    fs::write(dir.path().join("index.db-wal"), b"stale log").expect("a stale sidecar");

    let second = open_or_rebuild(&path).expect("second open");

    assert!(second.rebuild_reason.is_some());
    // The stale log went with the file it belonged to.
    let wal = fs::read(dir.path().join("index.db-wal")).unwrap_or_default();
    assert_ne!(wal, b"stale log");
}

/// An `index.db` at `INDEX_MIGRATIONS[..1]`, as a build before the second
/// migration left it, holding one row in each table.
fn index_at_version_one(path: &Path) {
    let db = Db::open_with(path, Profile::Index).expect("open");
    db.call_blocking(|conn| {
        migrations::run(conn, &INDEX_MIGRATIONS[..1])?;
        conn.execute_batch(
            "INSERT INTO index_meta (key, value) VALUES ('data.user_version', '12');
             INSERT INTO note_links (source_id, target_id, target_title)
               VALUES ('n1', NULL, 'Ödeme Toplantısı');",
        )
        .map_err(|err| StorageError::Failed {
            what: err.to_string(),
        })
    })
    .expect("seed version 1");
}

#[test]
fn index_migrates_in_place_keeps_rows() {
    let dir = temp_dir("index-in-place");
    let path = dir.path().join("index.db");
    index_at_version_one(&path);

    let opened = open_or_rebuild(&path).expect("open");

    assert!(
        opened.rebuild_reason.is_none(),
        "a lower version is migrated, not rebuilt"
    );
    let (version, links, meta, keyed) = opened
        .db
        .call_blocking(|conn| {
            let count = |sql: &str| {
                conn.query_row(sql, [], |row| row.get::<_, i64>(0))
                    .map_err(|err| StorageError::Failed {
                        what: err.to_string(),
                    })
            };
            Ok((
                user_version(conn)?,
                count("SELECT COUNT(*) FROM note_links WHERE target_title = 'Ödeme Toplantısı'")?,
                count("SELECT COUNT(*) FROM index_meta")?,
                // The column migration 2 adds exists and is queryable.
                count("SELECT COUNT(*) FROM note_links WHERE target_key IS NULL")?,
            ))
        })
        .expect("read back");
    assert_eq!(version, migrations::latest_version(INDEX_MIGRATIONS));
    assert_eq!((links, meta, keyed), (1, 1, 1));
}

#[test]
fn index_newer_version_is_rebuilt() {
    let dir = temp_dir("index-newer");
    let path = dir.path().join("index.db");
    index_at_version_one(&path);
    let newer = migrations::latest_version(INDEX_MIGRATIONS) + 1;
    Db::open_with(&path, Profile::Index)
        .expect("open")
        .call_blocking(|conn| {
            conn.execute_batch(&format!("PRAGMA user_version = {newer}"))
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        })
        .expect("a newer build wrote this");

    let opened = open_or_rebuild(&path).expect("open");

    assert!(
        opened
            .rebuild_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("newer"))
    );
    assert_eq!(row_count(&opened.db), 0);
}

#[test]
fn index_migration_that_cannot_rerun_falls_back_to_a_rebuild() {
    // The crash window of migrations.rs: migration 2 committed, the counter
    // stayed at 1, and `ADD COLUMN` cannot be written `IF NOT EXISTS`.
    let dir = temp_dir("index-crash-window");
    let path = dir.path().join("index.db");
    index_at_version_one(&path);
    Db::open_with(&path, Profile::Index)
        .expect("open")
        .call_blocking(|conn| {
            conn.execute_batch("ALTER TABLE note_links ADD COLUMN target_key TEXT")
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        })
        .expect("migration 2 applied without its counter");

    let opened = open_or_rebuild(&path).expect("open");

    assert!(
        opened
            .rebuild_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("in-place migration"))
    );
    assert_eq!(row_count(&opened.db), 0);
}

fn set_aside_copy(dir: &Path, label: &str) -> Db {
    let names = named(dir, &format!("index.db.{label}-"));
    let file = names
        .iter()
        .find(|n| !n.ends_with("-wal") && !n.ends_with("-shm"))
        .unwrap_or_else(|| panic!("no index.db.{label}-* in {names:?}"));
    Db::open_with(&dir.join(file), Profile::Index).expect("open the copy")
}

#[test]
fn a_newer_index_is_set_aside_with_its_rows_not_wiped() {
    // Two builds taking turns on one vault must not wipe each other's index.
    let dir = temp_dir("index-newer-kept");
    let path = dir.path().join("index.db");
    index_at_version_one(&path);
    let newer = migrations::latest_version(INDEX_MIGRATIONS) + 1;
    Db::open_with(&path, Profile::Index)
        .expect("open")
        .call_blocking(|conn| {
            conn.execute_batch(&format!("PRAGMA user_version = {newer}"))
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        })
        .expect("a newer build wrote this");

    let opened = open_or_rebuild(&path).expect("open");
    assert!(opened.rebuild_reason.is_some());
    drop(opened);

    let kept = set_aside_copy(dir.path(), "newer");
    assert_eq!(
        row_count(&kept),
        1,
        "the newer build's rows are still there"
    );
}

#[test]
fn a_corrupt_index_is_set_aside_not_deleted() {
    let dir = temp_dir("index-corrupt-kept");
    let path = dir.path().join("index.db");
    fs::write(&path, b"this is not a SQLite database").expect("garbage");

    open_or_rebuild(&path).expect("open");

    let copy = named(dir.path(), "index.db.corrupt-");
    assert_eq!(copy.len(), 1, "{copy:?}");
    assert_eq!(
        fs::read(dir.path().join(&copy[0])).expect("kept"),
        b"this is not a SQLite database"
    );
}

#[test]
fn a_migration_that_fails_on_its_own_sets_the_file_aside() {
    let dir = temp_dir("index-migration-defect");
    let path = dir.path().join("index.db");
    index_at_version_one(&path);
    Db::open_with(&path, Profile::Index)
        .expect("open")
        .call_blocking(|conn| {
            conn.execute_batch("ALTER TABLE note_links ADD COLUMN target_key TEXT")
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        })
        .expect("a legacy file in the old crash window");

    let opened = open_or_rebuild(&path).expect("open");

    assert!(opened.rebuild_reason.is_some());
    drop(opened);
    assert_eq!(row_count(&set_aside_copy(dir.path(), "old")), 1);
}

/// Cannot be opened at all (mode 000): the environment's fault, not the
/// file's. A rebuild here would delete a healthy index.
#[cfg(unix)]
#[test]
fn an_index_that_cannot_be_read_is_an_error_and_is_left_alone() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = temp_dir("index-unreadable");
    let path = dir.path().join("index.db");
    index_at_version_one(&path);
    let before = fs::read(&path).expect("read");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).expect("chmod");
    // root ignores file modes; nothing to prove then.
    if fs::read(&path).is_ok() {
        return;
    }

    let outcome = open_or_rebuild(&path);

    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("restore");
    assert!(
        matches!(outcome, Err(StorageError::Failed { .. })),
        "{:?}",
        outcome.err()
    );
    assert_eq!(
        fs::read(&path).expect("read"),
        before,
        "the file is untouched"
    );
    assert!(
        named(dir.path(), "index.db.").is_empty(),
        "nothing was set aside"
    );
}

/// Another connection holds the file (a second instance, a backup tool):
/// the environment's fault on every OS, not the file's. Takes the busy
/// timeout (5 s) to give up.
#[test]
fn an_index_held_by_another_connection_is_an_error_and_keeps_its_rows() {
    let dir = temp_dir("index-locked");
    let path = dir.path().join("index.db");
    index_at_version_one(&path);
    // A rollback-mode exclusive lock: nothing else may even read the file.
    let holder = rusqlite::Connection::open(&path).expect("holder");
    holder
        .execute_batch("PRAGMA journal_mode = DELETE")
        .expect("rollback mode");
    holder.execute_batch("BEGIN EXCLUSIVE").expect("lock");

    let outcome = open_or_rebuild(&path);

    assert!(
        matches!(outcome, Err(StorageError::Failed { .. })),
        "{:?}",
        outcome.err()
    );
    holder.execute_batch("ROLLBACK").expect("release");
    drop(holder);
    assert!(
        named(dir.path(), "index.db.").is_empty(),
        "nothing was set aside"
    );
    let reopened = open_or_rebuild(&path).expect("open once it is free");
    assert!(reopened.rebuild_reason.is_none());
    assert_eq!(row_count(&reopened.db), 1, "the rows were never touched");
}

/// feat/tauri-v2 builds before #4438 numbered their own index migrations from 3, where main's
/// 0003 `fts_inbox` now sits. A file one of them left at 3..6 is past 0003 by its counter and
/// never ran it, so it is rebuilt rather than failing every inbox pass.
#[test]
fn an_index_numbered_before_fts_inbox_without_it_is_rebuilt() {
    assert_eq!(INDEX_MIGRATIONS[FTS_INBOX as usize - 1].name, "fts_inbox");
    for old in 3..=6u32 {
        let dir = temp_dir("index-pre-shift");
        let path = dir.path().join("index.db");
        let list: Vec<migrations::Migration> = INDEX_MIGRATIONS
            .iter()
            .filter(|m| m.name != "fts_inbox")
            .map(|m| migrations::Migration {
                version: if m.version > 3 {
                    m.version - 1
                } else {
                    m.version
                },
                ..*m
            })
            .collect();
        let db = Db::open_with(&path, Profile::Index).expect("open");
        db.call_blocking(|conn| {
            migrations::run_atomic(conn, &list[..old as usize])?;
            conn.execute_batch("INSERT INTO index_meta (key, value) VALUES ('k', 'v')")
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        })
        .expect("a pre-shift index");
        drop(db);

        let opened = open_or_rebuild(&path).expect("open");

        assert!(
            opened
                .rebuild_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("fts_inbox")),
            "old {old}: {:?}",
            opened.rebuild_reason
        );
        let inbox: i64 = opened
            .db
            .call_blocking(|conn| {
                conn.query_row("SELECT COUNT(*) FROM fts_inbox", [], |row| row.get(0))
                    .map_err(|err| StorageError::Failed {
                        what: err.to_string(),
                    })
            })
            .expect("fts_inbox is there");
        assert_eq!(inbox, 0);
        drop(opened);
        assert_eq!(
            row_count(&set_aside_copy(dir.path(), "old")),
            1,
            "old {old}"
        );
    }
}
