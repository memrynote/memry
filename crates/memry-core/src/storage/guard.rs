//! Looking at a database file before the core opens it for writing: the drizzle
//! guard, and the integrity check.
//!
//! The Electron `data.db` and the core's share 19 table names with different
//! columns (`settings` is `key, value, modified_at` there and `group, key,
//! value, clock, synced_at, deleted_at` here). Core migrations are `IF NOT
//! EXISTS`, so running them over an Electron file would "succeed" and leave a
//! hybrid that corrupts both. The Electron file is recognisable by the
//! `__drizzle_migrations` table drizzle creates; finding it is a hard error and
//! the file is left exactly as it was.
//!
//! **The guard fails closed.** It passes a file only when it is absent or empty,
//! or when SQLite says the file is not a database or is corrupt (the opener then
//! reports that with its own error). Any other failure to look, such as a lock
//! held by a running Electron app mid-checkpoint, an I/O error or a permission
//! error, is an error here, because "could not tell" must never read as "not
//! Electron".
//!
//! Both checks open the file read-only and never write it.

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, ErrorCode, OpenFlags};

use crate::api::errors::StorageError;
use crate::storage::pragmas::BUSY_TIMEOUT_MS;

/// Whether SQLite is saying the file itself is not a usable database
/// (`SQLITE_CORRUPT*` or `SQLITE_NOTADB`), as opposed to being unable to look.
pub(crate) fn is_damage(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(failure.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}

/// A read-only look at an existing file.
enum Probe {
    /// Nothing there to look at: no file, or an empty one.
    Absent,
    /// SQLite says it is not a database.
    Damaged,
    Open(Connection),
}

fn open_probe(path: &Path, wait: Duration) -> Result<Probe, StorageError> {
    let unreadable = |err: &dyn std::fmt::Display| StorageError::Failed {
        what: format!("could not inspect {}: {err}", path.display()),
    };
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() > 0 => {}
        Ok(_) => return Ok(Probe::Absent),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Probe::Absent),
        Err(err) => return Err(unreadable(&err)),
    }
    let conn = match Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(conn) => conn,
        Err(err) if is_damage(&err) => return Ok(Probe::Damaged),
        Err(err) => return Err(unreadable(&err)),
    };
    conn.busy_timeout(wait).map_err(|err| unreadable(&err))?;
    Ok(Probe::Open(conn))
}

/// Refuses `path` when it is a drizzle database
/// ([`StorageError::ForeignSchema`]). See the module docs for what passes.
pub fn refuse_foreign_schema(path: &Path) -> Result<(), StorageError> {
    refuse_foreign_schema_within(path, Duration::from_millis(BUSY_TIMEOUT_MS))
}

fn refuse_foreign_schema_within(path: &Path, wait: Duration) -> Result<(), StorageError> {
    let conn = match open_probe(path, wait)? {
        Probe::Absent | Probe::Damaged => return Ok(()),
        Probe::Open(conn) => conn,
    };
    let foreign = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM sqlite_master
           WHERE type = 'table' AND name = '__drizzle_migrations'
         )",
        [],
        |row| row.get::<_, bool>(0),
    );
    match foreign {
        Ok(true) => Err(StorageError::ForeignSchema {
            path: path.display().to_string(),
        }),
        Ok(false) => Ok(()),
        Err(err) if is_damage(&err) => Ok(()),
        Err(err) => Err(StorageError::Failed {
            what: format!("could not inspect {}: {err}", path.display()),
        }),
    }
}

/// `PRAGMA quick_check(1)` on an existing file, without opening it for writing.
/// Damage is [`StorageError::Corrupt`]; failing to look is a different error, so
/// a lock never reads as corruption.
///
/// Runs before the file is opened for writing on purpose: opening sets
/// `journal_mode`, which rewrites the file header, and a file reported corrupt
/// should be exactly as it was found.
pub fn check_integrity(path: &Path) -> Result<(), StorageError> {
    let corrupt = || StorageError::Corrupt {
        path: path.display().to_string(),
    };
    let conn = match open_probe(path, Duration::from_millis(BUSY_TIMEOUT_MS))? {
        Probe::Absent => return Ok(()),
        Probe::Damaged => return Err(corrupt()),
        Probe::Open(conn) => conn,
    };
    match conn.query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0)) {
        Ok(verdict) if verdict == "ok" => Ok(()),
        Ok(_) => Err(corrupt()),
        Err(err) if is_damage(&err) => Err(corrupt()),
        Err(err) => Err(StorageError::Failed {
            what: format!("quick_check on {} did not finish: {err}", path.display()),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::temp_dir;
    use crate::storage::{OpenOptions, open_data, open_data_with, open_index};

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

    #[test]
    fn drizzle_guard_fails_closed_when_the_file_is_locked() {
        // An Electron app mid-write holds the file; "could not look" must not
        // read as "not Electron".
        let dir = temp_dir("drizzle-guard-locked");
        let path = dir.path().join("data.db");
        electron_file(&path);
        let holder = Connection::open(&path).expect("holder");
        holder.execute_batch("BEGIN EXCLUSIVE").expect("lock");

        let outcome = refuse_foreign_schema_within(&path, Duration::from_millis(50));

        assert!(
            matches!(outcome, Err(StorageError::Failed { .. })),
            "{outcome:?}"
        );
        holder.execute_batch("ROLLBACK").expect("release");
        assert!(matches!(
            refuse_foreign_schema_within(&path, Duration::from_millis(50)),
            Err(StorageError::ForeignSchema { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn drizzle_guard_fails_closed_when_the_file_cannot_be_read() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = temp_dir("drizzle-guard-unreadable");
        let path = dir.path().join("data.db");
        electron_file(&path);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        if std::fs::read(&path).is_ok() {
            return; // root ignores file modes
        }

        let outcome = refuse_foreign_schema(&path);

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("restore");
        assert!(
            matches!(outcome, Err(StorageError::Failed { .. })),
            "{outcome:?}"
        );
    }

    #[test]
    fn drizzle_guard_leaves_a_damaged_file_to_its_opener() {
        let dir = temp_dir("drizzle-guard-damaged");
        let path = dir.path().join("data.db");
        std::fs::write(&path, b"this is not a SQLite database").expect("garbage");

        refuse_foreign_schema(&path).expect("not Electron");
        assert!(matches!(
            check_integrity(&path),
            Err(StorageError::Corrupt { .. })
        ));
        let verified = OpenOptions {
            verify_integrity: true,
        };
        assert!(matches!(
            open_data_with(&path, verified),
            Err(StorageError::Corrupt { .. })
        ));
    }
}
