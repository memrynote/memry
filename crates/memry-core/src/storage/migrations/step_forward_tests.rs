//! Each feat/tauri-v2 data migration from 19 to 24 applied to a `data.db` the build before it
//! left: the rows it held survive, and the migration is a no-op the second time.

use super::tests::table_names;
use super::*;
use crate::storage::Db;

#[test]
fn note_snapshots_applies_to_a_version_18_database_and_keeps_its_rows() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..18]))
        .expect("a database as the last shipped build left it");
    db.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('device.id', 'dev-1')",
            [],
        )
        .map_err(|err| StorageError::Failed {
            what: err.to_string(),
        })
    })
    .expect("a row to keep");
    assert!(!table_names(&db).iter().any(|n| n == "note_snapshots"));

    let version = db
        .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("step forward");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));

    let (device, indexes): (String, i64) = db
        .call_blocking(|conn| {
            conn.execute(
                "INSERT INTO note_snapshots
                   (id, note_id, content, title, content_hash, reason, created_at)
                 VALUES ('s1', 'n1', 'body', 'Title', 'hash', 'manual', '2026-10-24T00:00:00Z')",
                [],
            )
            .map_err(|err| StorageError::Failed {
                what: err.to_string(),
            })?;
            let device = conn
                .query_row(
                    "SELECT value FROM meta WHERE key = 'device.id'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })?;
            let indexes = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type = 'index' AND tbl_name = 'note_snapshots'
                       AND name IN ('idx_note_snapshots_note_id', 'idx_note_snapshots_created')",
                    [],
                    |row| row.get(0),
                )
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })?;
            Ok((device, indexes))
        })
        .expect("read back");
    assert_eq!(device, "dev-1");
    assert_eq!(indexes, 2);
}

#[test]
fn local_settings_applies_to_a_version_19_database_and_keeps_its_rows() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..19]))
        .expect("a database as the last shipped build left it");
    db.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('device.id', 'dev-1')",
            [],
        )
        .map_err(|err| StorageError::Failed {
            what: err.to_string(),
        })
    })
    .expect("a row to keep");
    assert!(!table_names(&db).iter().any(|n| n == "local_settings"));

    let version = db
        .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("step forward");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));

    let (device, rows): (String, i64) = db
        .call_blocking(|conn| {
            let device = conn
                .query_row(
                    "SELECT value FROM meta WHERE key = 'device.id'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })?;
            let rows = conn
                .query_row("SELECT COUNT(*) FROM local_settings", [], |row| row.get(0))
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })?;
            Ok((device, rows))
        })
        .expect("read back");
    assert_eq!(device, "dev-1");
    assert_eq!(rows, 0);
}

#[test]
fn note_files_applies_to_a_version_20_database_and_keeps_its_rows() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..20]))
        .expect("a database as the last shipped build left it");
    db.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO local_settings (key, value, updated_at) VALUES ('general', '{}', 1)",
            [],
        )
        .map_err(|err| StorageError::Failed {
            what: err.to_string(),
        })
    })
    .expect("a row to keep");
    assert!(!table_names(&db).iter().any(|n| n == "note_files"));

    let version = db
        .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("step forward");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));

    let (kept, files): (i64, i64) = db
        .call_blocking(|conn| {
            let read = |sql: &str| {
                conn.query_row(sql, [], |row| row.get::<_, i64>(0))
                    .map_err(|err| StorageError::Failed {
                        what: err.to_string(),
                    })
            };
            Ok((
                read("SELECT COUNT(*) FROM local_settings")?,
                read("SELECT COUNT(*) FROM note_files")?,
            ))
        })
        .expect("read back");
    assert_eq!((kept, files), (1, 0));
}

#[test]
fn note_positions_applies_to_a_version_21_database_and_keeps_its_rows() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..21]))
        .expect("a database as the last shipped build left it");
    db.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO note_files (note_id, path, indexed_at) VALUES ('n1', 'a.md', 1)",
            [],
        )
        .map_err(|err| StorageError::Failed {
            what: err.to_string(),
        })
    })
    .expect("a row to keep");
    assert!(!table_names(&db).iter().any(|n| n == "note_positions"));

    let version = db
        .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("step forward");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));
    // The crash window of §A.0: the migration is a no-op the second time.
    db.call_blocking(|conn| {
        conn.execute_batch(DATA_MIGRATIONS[21].sql)
            .map_err(|err| StorageError::Failed {
                what: err.to_string(),
            })
    })
    .expect("idempotent");

    let (kept, positions): (i64, i64) = db
        .call_blocking(|conn| {
            let read = |sql: &str| {
                conn.query_row(sql, [], |row| row.get::<_, i64>(0))
                    .map_err(|err| StorageError::Failed {
                        what: err.to_string(),
                    })
            };
            Ok((
                read("SELECT COUNT(*) FROM note_files")?,
                read("SELECT COUNT(*) FROM note_positions")?,
            ))
        })
        .expect("read back");
    assert_eq!((kept, positions), (1, 0));
}

#[test]
fn note_file_hashes_applies_to_a_version_22_database_and_names_the_hashes_rows_had() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..22]))
        .expect("a database as the last shipped build left it");
    db.call_blocking(|conn| {
        conn.execute_batch(
            "INSERT INTO note_files (note_id, path, content_hash, indexed_at)
               VALUES ('hashed', 'a.md', 'h1', 1), ('hashless', 'b.md', NULL, 1)",
        )
        .map_err(|err| StorageError::Failed {
            what: err.to_string(),
        })
    })
    .expect("rows to keep");

    let version = db
        .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("step forward");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));
    // The crash window of §A.0: the migration is a no-op the second time.
    db.call_blocking(|conn| {
        conn.execute_batch(DATA_MIGRATIONS[22].sql)
            .map_err(|err| StorageError::Failed {
                what: err.to_string(),
            })
    })
    .expect("idempotent");

    let hashes: Vec<(String, String)> = db
        .call_blocking(|conn| {
            let mut statement = conn
                .prepare("SELECT note_id, file_hash FROM note_file_hashes ORDER BY note_id")
                .unwrap();
            Ok(statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap())
        })
        .expect("read back");
    assert_eq!(hashes, vec![("hashed".to_owned(), "h1".to_owned())]);
}

/// The identity's lookup is the real query (`domain::notes::identity`), so it needs the markdown
/// feature its module is built with.
#[cfg(feature = "markdown")]
#[test]
fn the_note_identity_migration_applies_to_a_version_23_database_and_answers_the_identity() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..23]))
        .expect("a database as the last build left it");
    db.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO notes (id, title, folder_path) VALUES ('n1', 'Plan', 'Work')",
            [],
        )
        .map_err(|err| StorageError::Failed {
            what: err.to_string(),
        })
    })
    .expect("a row to keep");

    let version = db
        .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("step forward");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));
    db.call_blocking(|conn| {
        conn.execute_batch(DATA_MIGRATIONS[23].sql)
            .map_err(|err| StorageError::Failed {
                what: err.to_string(),
            })
    })
    .expect("idempotent");

    let (kept, owed, plan): (i64, i64, Vec<String>) = db
        .call_blocking(|conn| {
            let failed = |err: rusqlite::Error| StorageError::Failed {
                what: err.to_string(),
            };
            let kept = conn
                .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
                .map_err(failed)?;
            let owed = conn
                .query_row("SELECT COUNT(*) FROM note_place_owed", [], |row| row.get(0))
                .map_err(failed)?;
            let mut statement = conn
                .prepare(&format!(
                    "EXPLAIN QUERY PLAN {}",
                    crate::domain::notes::identity::UNFILED_NOTES
                ))
                .map_err(failed)?;
            let plan = statement
                .query_map(rusqlite::params!["Plan", "Work"], |row| {
                    row.get::<_, String>(3)
                })
                .map_err(failed)?
                .collect::<Result<_, _>>()
                .map_err(failed)?;
            Ok((kept, owed, plan))
        })
        .expect("read back");
    assert_eq!((kept, owed), (1, 0));
    // The notes are searched by the index, not scanned.
    assert!(
        plan.iter()
            .any(|step| step.starts_with("SEARCH n USING INDEX idx_notes_live_title")),
        "{plan:?}"
    );
    assert!(
        !plan.iter().any(|step| step.starts_with("SCAN n")),
        "{plan:?}"
    );
}
