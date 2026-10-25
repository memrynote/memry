//! The drizzle guard: the core never opens an Electron database.
//!
//! The Electron `data.db` and the core's share 19 table names with different
//! columns (`settings` is `key, value, modified_at` there and `group, key,
//! value, clock, synced_at, deleted_at` here). Core migrations are `IF NOT
//! EXISTS`, so running them over an Electron file would "succeed" and leave a
//! hybrid that corrupts both. The Electron file is recognisable by the
//! `__drizzle_migrations` table drizzle creates; finding it is a hard error and
//! the file is left exactly as it was.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};

use crate::api::errors::StorageError;

/// Refuses `path` when it is a drizzle database. A missing, empty or unreadable
/// file passes: the stage that opens it owns reporting those.
///
/// Opens the file read-only and never writes, so the bytes on disk are the same
/// before and after, whatever the verdict.
pub fn refuse_foreign_schema(path: &Path) -> Result<(), StorageError> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() > 0 => {}
        _ => return Ok(()),
    }
    let Ok(conn) = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Ok(());
    };
    let foreign = conn
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM sqlite_master
               WHERE type = 'table' AND name = '__drizzle_migrations'
             )",
            [],
            |row| row.get::<_, bool>(0),
        )
        // Not a database, or too damaged to read `sqlite_master`: that is
        // corruption, which the opener reports with its own error.
        .unwrap_or(false);
    if foreign {
        Err(StorageError::ForeignSchema {
            path: path.display().to_string(),
        })
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::temp_dir;
    use crate::storage::{open_data, open_index};

    /// What drizzle-kit leaves behind in an Electron `data.db`.
    fn electron_file(path: &Path) {
        let conn = Connection::open(path).expect("create");
        conn.execute_batch(
            "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER);
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, modified_at TEXT NOT NULL);
             INSERT INTO settings VALUES ('theme', 'dark', '2026-01-01');",
        )
        .expect("electron schema");
    }

    #[test]
    fn drizzle_guard_rejects_an_electron_data_db_and_leaves_it_unchanged() {
        let dir = temp_dir("drizzle-guard-data");
        let path = dir.path().join("data.db");
        electron_file(&path);
        let before = std::fs::read(&path).expect("read");

        let refused = open_data(&path);

        assert!(matches!(refused, Err(StorageError::ForeignSchema { .. })));
        assert_eq!(std::fs::read(&path).expect("read"), before);
        // No sidecar, no second file: the guard did not even open for writing.
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .expect("dir")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("data.db")]);
    }

    #[test]
    fn drizzle_guard_rejects_an_electron_index_db_and_leaves_it_unchanged() {
        let dir = temp_dir("drizzle-guard-index");
        let path = dir.path().join("index.db");
        electron_file(&path);
        let before = std::fs::read(&path).expect("read");

        let refused = open_index(&path);

        assert!(matches!(refused, Err(StorageError::ForeignSchema { .. })));
        assert_eq!(std::fs::read(&path).expect("read"), before);
    }

    #[test]
    fn drizzle_guard_lets_a_core_database_and_a_new_path_through() {
        let dir = temp_dir("drizzle-guard-core");
        let path = dir.path().join("data.db");
        refuse_foreign_schema(&path).expect("a missing file passes");
        drop(open_data(&path).expect("create"));
        refuse_foreign_schema(&path).expect("a core file passes");
        open_data(&path).expect("and reopens");
    }
}
