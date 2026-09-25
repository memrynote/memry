//! The `PRAGMA user_version` migration runner (data-model §A.0).
//!
//! Hand written, forward only, never dropping a column. A removed concept leaves
//! its column in place unread, because a rollback to an older build must still
//! open the file. There is no migrations table, because a migrations table
//! itself eventually needs migrating.
//!
//! §A.0 states the convention normatively, and it is easy to get subtly wrong:
//! read `user_version`; for each migration whose version exceeds it, run that
//! migration's statements inside **one** transaction, then set `user_version` to
//! that migration's number **outside** that transaction, immediately after it
//! commits. The two databases carry independent counters, which is why [`run`]
//! takes the migration list rather than reading a global.
//!
//! **Why the DDL is written `IF NOT EXISTS`.** Setting the counter outside the
//! transaction leaves a window: a crash after the commit and before the pragma
//! re-runs the migration on the next launch. The transaction is all or nothing,
//! so on that re-run either every object already exists or none does; `IF NOT
//! EXISTS` makes the first case a clean no-op that then sets the counter, and
//! leaves the second case a normal first application. Without it, the crash
//! window is unrecoverable: the database is at the older version and the
//! migration can never succeed again.

use rusqlite::Connection;

use crate::api::errors::StorageError;

/// One hand-written, forward-only step.
pub struct Migration {
    /// The value `user_version` takes once this migration has committed.
    /// Strictly ascending across a list, starting at 1.
    pub version: u32,
    /// For error messages and logs only. Never read as an identity.
    pub name: &'static str,
    /// The statements, run as one batch inside one transaction.
    pub sql: &'static str,
}

/// `data.db`: source of record, then the typed projections over it.
pub const DATA_MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "baseline",
        sql: include_str!("migrations/data/0001_baseline.sql"),
    },
    Migration {
        version: 2,
        name: "projections",
        sql: include_str!("migrations/data/0002_projections.sql"),
    },
    Migration {
        version: 3,
        name: "saved_filters",
        sql: include_str!("migrations/data/0003_saved_filters.sql"),
    },
    Migration {
        version: 4,
        name: "inbox",
        sql: include_str!("migrations/data/0004_inbox.sql"),
    },
];

/// `index.db`: the rebuildable search and link index.
///
/// This list exists to build the file, not to evolve it. An `index.db` at an
/// unexpected version is deleted and rebuilt rather than migrated (§A.0), so a
/// second entry here would be a new shape for a fresh file, never a step applied
/// to a user's existing one.
pub const INDEX_MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "fts",
    sql: include_str!("migrations/index/0001_fts.sql"),
}];

/// The version a fully migrated database sits at. Zero for an empty list.
pub fn latest_version(migrations: &[Migration]) -> u32 {
    migrations.last().map_or(0, |migration| migration.version)
}

/// Reads `PRAGMA user_version`.
pub fn user_version(conn: &Connection) -> Result<u32, StorageError> {
    conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map(|version| version as u32)
        .map_err(|err| StorageError::Failed {
            what: format!("could not read user_version: {err}"),
        })
}

/// Applies every migration newer than the database's `user_version`, in order,
/// and returns the version it ends at.
///
/// A database already at or past the last version is left untouched, so calling
/// this on every open is the intended use.
pub fn run(conn: &mut Connection, migrations: &[Migration]) -> Result<u32, StorageError> {
    let start = user_version(conn)?;
    let mut current = start;

    for migration in migrations.iter().filter(|m| m.version > start) {
        let fail = |what: String| StorageError::Migration {
            version: migration.version,
            what: format!("{}: {what}", migration.name),
        };

        let tx = conn.transaction().map_err(|err| fail(err.to_string()))?;
        tx.execute_batch(migration.sql)
            .map_err(|err| fail(err.to_string()))?;
        tx.commit().map_err(|err| fail(err.to_string()))?;

        // Outside the transaction, immediately after it commits (§A.0).
        set_user_version(conn, migration.version).map_err(|err| fail(err.to_string()))?;
        current = migration.version;
    }

    Ok(current)
}

fn set_user_version(conn: &Connection, version: u32) -> Result<(), StorageError> {
    // `pragma_update` cannot bind a parameter to a pragma value, and the value
    // is a `u32` this module owns, so there is nothing here to inject.
    conn.execute_batch(&format!("PRAGMA user_version = {version}"))
        .map_err(|err| StorageError::Failed {
            what: format!("could not set user_version to {version}: {err}"),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Db;

    fn table_names(db: &Db) -> Vec<String> {
        db.call_blocking(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM sqlite_schema
                     WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
                     ORDER BY name",
                )
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })?;
            let names = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })?;
            Ok(names)
        })
        .expect("table names")
    }

    fn migrated(migrations: &'static [Migration]) -> Db {
        let db = Db::open_in_memory().expect("open");
        let version = db
            .call_blocking(|conn| run(conn, migrations))
            .expect("migrate");
        assert_eq!(version, latest_version(migrations));
        db
    }

    #[test]
    fn versions_are_strictly_ascending_from_one() {
        for migrations in [DATA_MIGRATIONS, INDEX_MIGRATIONS] {
            for (index, migration) in migrations.iter().enumerate() {
                let expected = u32::try_from(index + 1).expect("migration count fits u32");
                assert_eq!(migration.version, expected, "{}", migration.name);
            }
        }
    }

    #[test]
    fn a_fresh_data_database_reaches_the_latest_version() {
        let db = migrated(DATA_MIGRATIONS);

        let version = db
            .call_blocking(|conn| user_version(conn))
            .expect("user_version");
        assert_eq!(version, 4);

        let names = table_names(&db);
        // Source of record, §A.2.
        for expected in [
            "attachments",
            "local_notifications",
            "meta",
            "note_bodies",
            "outbox",
            "sync_cursors",
            "sync_items",
            "yjs_snapshots",
            "yjs_updates",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
        // Typed projections, §A.4.
        for expected in [
            "folders",
            "inbox_item_tags",
            "inbox_items",
            "journal_entries",
            "note_tags",
            "notes",
            "project_links",
            "project_statuses",
            "projects",
            "property_definitions",
            "reminders",
            "saved_filters",
            "settings",
            "settings_field_clocks",
            "tag_categories",
            "tag_definitions",
            "task_activity",
            "tasks",
            "templates",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }

    #[test]
    fn a_fresh_index_database_reaches_the_latest_version() {
        let db = migrated(INDEX_MIGRATIONS);

        let version = db
            .call_blocking(|conn| user_version(conn))
            .expect("user_version");
        assert_eq!(version, 1);

        let names = table_names(&db);
        for expected in [
            "fts_notes",
            "fts_tasks",
            "index_meta",
            "note_links",
            "note_properties",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }

    #[test]
    fn running_again_is_a_no_op() {
        let db = migrated(DATA_MIGRATIONS);
        let before = table_names(&db);

        let version = db
            .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
            .expect("second run");

        assert_eq!(version, latest_version(DATA_MIGRATIONS));
        assert_eq!(table_names(&db), before);
    }

    #[test]
    fn an_older_database_steps_forward_without_losing_rows() {
        let db = Db::open_in_memory().expect("open");

        // A database that only ever saw 0001, with a user's row in it.
        db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..1]))
            .expect("first migration");
        db.call_blocking(|conn| {
            conn.execute(
                "INSERT INTO sync_items
                   (item_type, item_id, payload, payload_state, updated_at)
                 VALUES ('note', 'abc123def456', '{\"unmodelled\":1}', 'full', 1757700000000)",
                [],
            )
            .map_err(|err| StorageError::Failed {
                what: err.to_string(),
            })
        })
        .expect("insert");

        let version = db
            .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
            .expect("step forward");
        assert_eq!(version, 4);

        let (count, payload): (i64, String) = db
            .call_blocking(|conn| {
                conn.query_row(
                    "SELECT COUNT(*), payload FROM sync_items WHERE item_id = 'abc123def456'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
            })
            .expect("row survives");

        assert_eq!(count, 1);
        // Verbatim, §A.1: a migration is not an excuse to re-serialise a payload.
        assert_eq!(payload, "{\"unmodelled\":1}");
        // The projections 0002 and 0003 added are present and empty.
        assert!(table_names(&db).iter().any(|n| n == "notes"));
        assert!(table_names(&db).iter().any(|n| n == "saved_filters"));
    }

    #[test]
    fn a_migration_interrupted_between_commit_and_pragma_recovers() {
        let db = Db::open_in_memory().expect("open");

        db.call_blocking(|conn| run(conn, DATA_MIGRATIONS))
            .expect("migrate");
        // The crash window §A.0's ordering leaves open: the statements committed
        // but the counter never moved.
        db.call_blocking(|conn| set_user_version(conn, 0))
            .expect("rewind");

        let version = db
            .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
            .expect("re-run");

        assert_eq!(version, latest_version(DATA_MIGRATIONS));
    }

    #[test]
    fn a_failing_migration_leaves_the_previous_version_in_place() {
        static BROKEN: &[Migration] = &[
            Migration {
                version: 1,
                name: "ok",
                sql: "CREATE TABLE IF NOT EXISTS kept (id TEXT PRIMARY KEY);",
            },
            Migration {
                version: 2,
                name: "broken",
                sql: "CREATE TABLE IF NOT EXISTS added (id TEXT); SELECT nonexistent_fn();",
            },
        ];

        let db = Db::open_in_memory().expect("open");
        let err = db
            .call_blocking(|conn| run(conn, BROKEN))
            .expect_err("second migration fails");

        assert!(matches!(err, StorageError::Migration { version: 2, .. }));

        let version = db
            .call_blocking(|conn| user_version(conn))
            .expect("user_version");
        assert_eq!(version, 1);
        // The whole failing migration rolled back, so its half is not there.
        let names = table_names(&db);
        assert!(names.iter().any(|n| n == "kept"));
        assert!(!names.iter().any(|n| n == "added"));
    }
}
