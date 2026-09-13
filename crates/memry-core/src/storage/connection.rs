//! One `Connection` per database, behind one mutex, reached from async code
//! only through `spawn_blocking` (research R4, data-model §A.0).
//!
//! SQLite's own threading modes are not the tool here. `rusqlite`'s `Connection`
//! is `Send` but not `Sync`, and the core's async tasks are scheduled across a
//! multi-threaded runtime, so the connection needs an owner. That owner is a
//! `std::sync::Mutex`, deliberately and not a `tokio::sync::Mutex`: a blocking
//! mutex cannot be held across an `.await`, because the only place it is ever
//! locked is inside the closure handed to `spawn_blocking`, and that closure has
//! no `.await` points. The compiler enforces what a comment would only ask for.
//!
//! Everything that touches SQL goes through [`Db::call`] or, when the caller is
//! already on a blocking thread, [`Db::call_blocking`]. A statement run on the
//! async runtime's worker threads would stall every other task on that thread
//! for the duration of the write.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;

use crate::api::errors::StorageError;

/// How long a writer waits for another connection's lock before giving up
/// (research R4). Long enough that a compaction pass does not fail a concurrent
/// read, short enough that a genuinely stuck writer surfaces.
pub const BUSY_TIMEOUT_MS: u64 = 5_000;

/// A single SQLite database the core owns.
///
/// Cheap to clone: every clone shares the one connection and the one mutex.
#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    /// Opens (creating if absent) the database at `path` and applies the pragmas
    /// every core-owned database runs under.
    ///
    /// File protection and backup exclusion are the shell's job, through the
    /// `FileProtection` seam: they are attributes of the file, not of the
    /// connection, and they have to be set by the process that owns the sandbox.
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        let conn = Connection::open(path).map_err(|err| StorageError::Failed {
            what: format!("could not open {}: {err}", path.display()),
        })?;
        Self::adopt(conn)
    }

    /// An anonymous in-memory database, for tests.
    ///
    /// WAL is not available to a `:memory:` database, and `configure` does not
    /// insist on it for that reason. Nothing else differs.
    pub fn open_in_memory() -> Result<Self, StorageError> {
        let conn = Connection::open_in_memory().map_err(|err| StorageError::Failed {
            what: format!("could not open an in-memory database: {err}"),
        })?;
        Self::adopt(conn)
    }

    fn adopt(conn: Connection) -> Result<Self, StorageError> {
        configure(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Runs `f` against the connection on the blocking pool.
    ///
    /// The mutex is taken inside the spawned closure and released when it
    /// returns, so no lock is ever alive across an `.await` in the caller.
    pub async fn call<F, T>(&self, f: F) -> Result<T, StorageError>
    where
        F: FnOnce(&mut Connection) -> Result<T, StorageError> + Send + 'static,
        T: Send + 'static,
    {
        let conn = Arc::clone(&self.conn);
        tokio::task::spawn_blocking(move || {
            let mut guard = lock(&conn)?;
            f(&mut guard)
        })
        .await
        .map_err(|err| StorageError::Failed {
            what: format!("database task did not finish: {err}"),
        })?
    }

    /// Runs `f` against the connection on the calling thread.
    ///
    /// For callers that are already off the async runtime: startup, migrations,
    /// and tests. Calling this from an async task blocks that task's worker
    /// thread, which is the thing [`Db::call`] exists to prevent.
    pub fn call_blocking<F, T>(&self, f: F) -> Result<T, StorageError>
    where
        F: FnOnce(&mut Connection) -> Result<T, StorageError>,
    {
        let mut guard = lock(&self.conn)?;
        f(&mut guard)
    }
}

fn lock(conn: &Arc<Mutex<Connection>>) -> Result<MutexGuard<'_, Connection>, StorageError> {
    conn.lock().map_err(|_| StorageError::Failed {
        what: "the database mutex was poisoned by a panic in an earlier statement".to_owned(),
    })
}

/// The pragmas every core-owned database runs under (research R4, §A.0).
fn configure(conn: &Connection) -> Result<(), StorageError> {
    // Asserted here rather than discovered on the first search: a core without
    // FTS5 cannot index anything and should say so at startup (research R4).
    assert_fts5(conn)?;

    conn.busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS))
        .map_err(|err| StorageError::Failed {
            what: format!("could not set busy_timeout: {err}"),
        })?;

    // `journal_mode` answers with the mode it settled on, so it is a query and
    // not an update. A `:memory:` database answers `memory` and that is fine.
    let _mode: String = conn
        .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
        .map_err(|err| StorageError::Failed {
            what: format!("could not set journal_mode: {err}"),
        })?;

    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|err| StorageError::Failed {
            what: format!("could not set synchronous: {err}"),
        })?;

    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|err| StorageError::Failed {
            what: format!("could not set foreign_keys: {err}"),
        })?;

    Ok(())
}

/// `bundled` compiles FTS5 in; there is no `fts5` cargo feature to depend on, so
/// the guarantee is checked against the engine rather than the manifest.
fn assert_fts5(conn: &Connection) -> Result<(), StorageError> {
    let present: bool = conn
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM pragma_compile_options
               WHERE compile_options = 'ENABLE_FTS5'
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|err| StorageError::Failed {
            what: format!("could not read pragma_compile_options: {err}"),
        })?;

    if present {
        Ok(())
    } else {
        Err(StorageError::MissingFts5)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts5_is_compiled_in() {
        let db = Db::open_in_memory().expect("open");
        db.call_blocking(|conn| {
            conn.execute_batch("CREATE VIRTUAL TABLE probe USING fts5(body)")
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        })
        .expect("fts5 virtual table");
    }

    #[test]
    fn foreign_keys_and_busy_timeout_are_set() {
        let db = Db::open_in_memory().expect("open");
        let (foreign_keys, busy_timeout): (i64, i64) = db
            .call_blocking(|conn| {
                let fk = conn
                    .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                    .map_err(|err| StorageError::Failed {
                        what: err.to_string(),
                    })?;
                let bt = conn
                    .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
                    .map_err(|err| StorageError::Failed {
                        what: err.to_string(),
                    })?;
                Ok((fk, bt))
            })
            .expect("pragmas");

        assert_eq!(foreign_keys, 1);
        assert_eq!(busy_timeout, BUSY_TIMEOUT_MS as i64);
    }

    #[test]
    fn a_file_backed_database_is_in_wal_mode() {
        let dir = crate::storage::test_support::temp_dir("connection-wal");
        let db = Db::open(&dir.path().join("data.db")).expect("open");
        let mode: String = db
            .call_blocking(|conn| {
                conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))
                    .map_err(|err| StorageError::Failed {
                        what: err.to_string(),
                    })
            })
            .expect("journal_mode");

        assert_eq!(mode, "wal");
    }

    #[tokio::test]
    async fn call_runs_statements_on_the_blocking_pool() {
        let db = Db::open_in_memory().expect("open");

        db.call(|conn| {
            conn.execute_batch("CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (7)")
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        })
        .await
        .expect("write");

        // Two awaits in a row prove the guard was released between them: a lock
        // held across the first await would deadlock the second.
        let n: i64 = db
            .call(|conn| {
                conn.query_row("SELECT n FROM t", [], |row| row.get(0))
                    .map_err(|err| StorageError::Failed {
                        what: err.to_string(),
                    })
            })
            .await
            .expect("read");

        assert_eq!(n, 7);
    }
}
