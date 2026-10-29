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
    Migration {
        version: 5,
        name: "tombstone_clocks",
        sql: include_str!("migrations/data/0005_tombstone_clocks.sql"),
    },
    // Spec 007 calendar: after main's 0005, so an install that already ran
    // 0005 still receives these.
    Migration {
        version: 6,
        name: "calendar",
        sql: include_str!("migrations/data/0006_calendar.sql"),
    },
    Migration {
        version: 7,
        name: "calendar_source_states",
        sql: include_str!("migrations/data/0007_calendar_source_states.sql"),
    },
    Migration {
        version: 8,
        name: "calendar_push_queue",
        sql: include_str!("migrations/data/0008_calendar_push_queue.sql"),
    },
    Migration {
        version: 9,
        name: "bookmarks",
        sql: include_str!("migrations/data/0009_bookmarks.sql"),
    },
    Migration {
        version: 10,
        name: "note_body_tags",
        sql: include_str!("migrations/data/0010_note_body_tags.sql"),
    },
    Migration {
        version: 11,
        name: "yjs_doc_epochs",
        sql: include_str!("migrations/data/0011_yjs_doc_epochs.sql"),
    },
    Migration {
        version: 12,
        name: "journal_aliases",
        sql: include_str!("migrations/data/0012_journal_aliases.sql"),
    },
    Migration {
        version: 13,
        name: "note_snapshots",
        sql: include_str!("migrations/data/0013_note_snapshots.sql"),
    },
    Migration {
        version: 14,
        name: "local_settings",
        sql: include_str!("migrations/data/0014_local_settings.sql"),
    },
    Migration {
        version: 15,
        name: "note_files",
        sql: include_str!("migrations/data/0015_note_files.sql"),
    },
    Migration {
        version: 16,
        name: "notes_device_tables",
        sql: include_str!("migrations/data/0016_notes_device_tables.sql"),
    },
    Migration {
        version: 17,
        name: "note_identity",
        sql: include_str!("migrations/data/0017_note_identity.sql"),
    },
];

/// `index.db`: the rebuildable search and link index.
///
/// An `index.db` at a lower version migrates in place through this list and
/// keeps every row; only a damaged file, or one written by a newer build, is
/// deleted and rebuilt (`index_db`). So an entry is hand written, additive and
/// idempotent (`IF NOT EXISTS`), exactly like a `data.db` migration.
pub const INDEX_MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "fts",
        sql: include_str!("migrations/index/0001_fts.sql"),
    },
    Migration {
        version: 2,
        name: "link_target_keys",
        sql: include_str!("migrations/index/0002_link_target_keys.sql"),
    },
];

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

/// A migration that failed, with the SQLite error that stopped it, so the caller
/// can tell a defect in the migration from a lock or a full disk.
#[derive(Debug)]
pub struct MigrationFailure {
    pub version: u32,
    pub name: &'static str,
    pub error: rusqlite::Error,
}

impl From<MigrationFailure> for StorageError {
    fn from(failure: MigrationFailure) -> Self {
        Self::Migration {
            version: failure.version,
            what: format!("{}: {}", failure.name, failure.error),
        }
    }
}

/// As [`run`], with `user_version` written **inside** each migration's
/// transaction. SQLite commits the pragma with the schema change, so there is no
/// window in which a migration has applied and its counter has not, and a
/// migration need not be re-runnable. For `index.db`, which migrates in place;
/// `data.db` keeps the §A.0 convention of [`run`].
pub fn run_atomic(
    conn: &mut Connection,
    migrations: &[Migration],
) -> Result<u32, MigrationFailure> {
    let start = user_version(conn).map_err(|err| MigrationFailure {
        version: 0,
        name: "read user_version",
        error: rusqlite::Error::InvalidParameterName(err.to_string()),
    })?;
    let mut current = start;
    for migration in migrations.iter().filter(|m| m.version > start) {
        let fail = |error| MigrationFailure {
            version: migration.version,
            name: migration.name,
            error,
        };
        let tx = conn.transaction().map_err(fail)?;
        tx.execute_batch(migration.sql).map_err(fail)?;
        tx.execute_batch(&format!("PRAGMA user_version = {}", migration.version))
            .map_err(fail)?;
        tx.commit().map_err(fail)?;
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
mod tests;
