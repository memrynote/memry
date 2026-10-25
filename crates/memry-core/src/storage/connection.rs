//! One writer plus a read pool per database, reached from async code only
//! through `spawn_blocking` (research R4, data-model §A.0).
//!
//! SQLite's own threading modes are not the tool here. `rusqlite`'s `Connection`
//! is `Send` but not `Sync`, and the core's async tasks are scheduled across a
//! multi-threaded runtime, so each connection needs an owner. The writer's owner
//! is a `std::sync::Mutex`, deliberately and not a `tokio::sync::Mutex`: a
//! blocking mutex cannot be held across an `.await`, because the only place it is
//! ever locked is inside the closure handed to `spawn_blocking`, and that closure
//! has no `.await` points. The compiler enforces what a comment would only ask
//! for.
//!
//! **Routing.** A method that only runs `SELECT` uses [`Db::read`] or
//! [`Db::read_blocking`]. Anything that writes, or reads and then writes in one
//! logical step, uses [`Db::call`] or [`Db::call_blocking`]. A command that writes
//! and then returns data re-reads through the writer inside the same closure.
//! Readers are `query_only`, so a misclassified write fails with `attempt to
//! write a readonly database` instead of corrupting anything.
//!
//! A statement run on the async runtime's worker threads would stall every other
//! task on that thread for the duration of the write.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::storage::pool::ReaderPool;
use crate::storage::pragmas;
pub use crate::storage::pragmas::{BUSY_TIMEOUT_MS, Profile};

/// A single SQLite database the core owns.
///
/// Cheap to clone: every clone shares the one writer and the one pool.
#[derive(Clone)]
pub struct Db {
    /// `None` for an in-memory database, which a second connection cannot share.
    ///
    /// Declared before `writer` on purpose: fields drop in order, and the
    /// connection that closes last checkpoints the WAL and deletes it. A
    /// read-only connection cannot, so the writer has to be the last one out or
    /// `data.db-wal` outlives the handle holding every recent write.
    readers: Option<Arc<ReaderPool>>,
    writer: Arc<Mutex<Connection>>,
}

impl Db {
    /// Opens (creating if absent) the `data.db`-profile database at `path`: the
    /// writer, then the reader pool.
    ///
    /// File protection and backup exclusion are the shell's job, through the
    /// `FileProtection` seam: they are attributes of the file, not of the
    /// connection, and they have to be set by the process that owns the sandbox.
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        Self::open_with(path, Profile::Data)
    }

    /// As [`Db::open`], for a database with another [`Profile`] (`index.db`).
    pub fn open_with(path: &Path, profile: Profile) -> Result<Self, StorageError> {
        let conn = Connection::open(path).map_err(|err| StorageError::Failed {
            what: format!("could not open {}: {err}", path.display()),
        })?;
        pragmas::configure_writer(&conn, profile)?;
        // The writer has created the file and persisted WAL by now.
        let readers = ReaderPool::open(path, profile)?;
        Ok(Self {
            writer: Arc::new(Mutex::new(conn)),
            readers: Some(Arc::new(readers)),
        })
    }

    /// An anonymous in-memory database, for tests and nothing else.
    ///
    /// WAL is not available to a `:memory:` database, and a private in-memory
    /// database cannot be shared with a second connection, so there is no pool:
    /// [`Db::read`] falls back to the writer. Nothing else differs.
    pub fn open_in_memory() -> Result<Self, StorageError> {
        let conn = Connection::open_in_memory().map_err(|err| StorageError::Failed {
            what: format!("could not open an in-memory database: {err}"),
        })?;
        pragmas::configure_writer(&conn, Profile::Data)?;
        Ok(Self {
            writer: Arc::new(Mutex::new(conn)),
            readers: None,
        })
    }

    /// Runs `f` against the writer on the blocking pool.
    ///
    /// The mutex is taken inside the spawned closure and released when it
    /// returns, so no lock is ever alive across an `.await` in the caller.
    pub async fn call<F, T>(&self, f: F) -> Result<T, StorageError>
    where
        F: FnOnce(&mut Connection) -> Result<T, StorageError> + Send + 'static,
        T: Send + 'static,
    {
        let conn = Arc::clone(&self.writer);
        join(tokio::task::spawn_blocking(move || {
            let mut guard = lock(&conn)?;
            f(&mut guard)
        }))
        .await
    }

    /// Runs `f` against the writer on the calling thread.
    ///
    /// For callers that are already off the async runtime: startup, migrations,
    /// and tests. Calling this from an async task blocks that task's worker
    /// thread, which is the thing [`Db::call`] exists to prevent.
    pub fn call_blocking<F, T>(&self, f: F) -> Result<T, StorageError>
    where
        F: FnOnce(&mut Connection) -> Result<T, StorageError>,
    {
        let mut guard = lock(&self.writer)?;
        f(&mut guard)
    }

    /// Runs the `SELECT`-only `f` on a pooled reader, on the blocking pool. It
    /// sees the last commit; it never waits behind a write transaction.
    pub async fn read<F, T>(&self, f: F) -> Result<T, StorageError>
    where
        F: FnOnce(&Connection) -> Result<T, StorageError> + Send + 'static,
        T: Send + 'static,
    {
        let db = self.clone();
        join(tokio::task::spawn_blocking(move || db.read_blocking(f))).await
    }

    /// As [`Db::read`], on the calling thread.
    pub fn read_blocking<F, T>(&self, f: F) -> Result<T, StorageError>
    where
        F: FnOnce(&Connection) -> Result<T, StorageError>,
    {
        match &self.readers {
            Some(pool) => {
                let reader = pool.checkout()?;
                f(&reader)
            }
            None => {
                // Same contract as a pooled reader: a write inside a read
                // closure fails here too, so tests on in-memory databases
                // catch a misclassified site.
                let writer = lock(&self.writer)?;
                set_query_only(&writer, true)?;
                let out = f(&writer);
                set_query_only(&writer, false)?;
                out
            }
        }
    }
}

async fn join<T>(
    task: tokio::task::JoinHandle<Result<T, StorageError>>,
) -> Result<T, StorageError> {
    task.await.map_err(|err| StorageError::Failed {
        what: format!("database task did not finish: {err}"),
    })?
}

fn set_query_only(conn: &Connection, on: bool) -> Result<(), StorageError> {
    conn.pragma_update(None, "query_only", on)
        .map_err(|err| StorageError::Failed {
            what: format!("could not set query_only on the in-memory database: {err}"),
        })
}

fn lock(conn: &Arc<Mutex<Connection>>) -> Result<MutexGuard<'_, Connection>, StorageError> {
    conn.lock().map_err(|_| StorageError::Failed {
        what: "the database mutex was poisoned by a panic in an earlier statement".to_owned(),
    })
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
    fn an_in_memory_read_refuses_a_write_and_the_writer_works_again_after() {
        let db = Db::open_in_memory().expect("open");
        db.call_blocking(|conn| {
            conn.execute_batch("CREATE TABLE t (x)")
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        })
        .expect("create");

        let refused = db.read_blocking(|conn| {
            conn.execute("INSERT INTO t VALUES (1)", [])
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        });
        assert!(
            refused.is_err_and(|err| err.to_string().contains("readonly")),
            "a write inside a read closure must fail like it does on a pooled reader"
        );

        db.call_blocking(|conn| {
            conn.execute("INSERT INTO t VALUES (1)", [])
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        })
        .expect("the writer accepts writes again");
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

    fn failed(err: rusqlite::Error) -> StorageError {
        StorageError::Failed {
            what: err.to_string(),
        }
    }

    fn file_db(label: &str) -> (crate::storage::test_support::TempDir, Db) {
        let dir = crate::storage::test_support::temp_dir(label);
        let db = Db::open(&dir.path().join("data.db")).expect("open");
        db.call_blocking(|conn| {
            conn.execute_batch("CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1)")
                .map_err(failed)
        })
        .expect("seed");
        (dir, db)
    }

    #[test]
    fn a_reader_sees_the_write_committed_before_it() {
        let (_dir, db) = file_db("read-your-writes");
        db.call_blocking(|conn| conn.execute("INSERT INTO t VALUES (2)", []).map_err(failed))
            .expect("write");

        let sum: i64 = db
            .read_blocking(|conn| {
                conn.query_row("SELECT SUM(n) FROM t", [], |row| row.get(0))
                    .map_err(failed)
            })
            .expect("read");

        assert_eq!(sum, 3);
    }

    #[test]
    fn a_reader_refuses_a_write_instead_of_corrupting() {
        let (_dir, db) = file_db("read-refuses-write");

        let refused = db.read_blocking(|conn| {
            conn.execute("INSERT INTO t VALUES (9)", [])
                .map(|_| ())
                .map_err(failed)
        });

        assert!(matches!(
            refused,
            Err(StorageError::Failed { ref what }) if what.contains("readonly")
        ));
        let count: i64 = db
            .call_blocking(|conn| {
                conn.query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0))
                    .map_err(failed)
            })
            .expect("count");
        assert_eq!(count, 1);
    }

    #[test]
    fn a_reader_never_sees_an_uncommitted_write_and_does_not_wait_for_it() {
        let (_dir, db) = file_db("read-isolation");
        let writer = db.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let held = std::thread::spawn(move || {
            writer
                .call_blocking(|conn| {
                    conn.execute_batch("BEGIN IMMEDIATE; INSERT INTO t VALUES (100)")
                        .map_err(failed)?;
                    started_tx.send(()).expect("signal");
                    release_rx.recv().expect("release");
                    conn.execute_batch("ROLLBACK").map_err(failed)
                })
                .expect("writer")
        });
        started_rx.recv().expect("the writer holds its transaction");

        // The writer's mutex is held right now. A read through the writer would
        // block until `release`; the pool answers at once.
        let sum: i64 = db
            .read_blocking(|conn| {
                conn.query_row("SELECT SUM(n) FROM t", [], |row| row.get(0))
                    .map_err(failed)
            })
            .expect("read");
        assert_eq!(sum, 1);

        release_tx.send(()).expect("release the writer");
        held.join().expect("writer thread");
    }

    #[test]
    fn an_in_memory_database_reads_through_its_writer() {
        let db = Db::open_in_memory().expect("open");
        db.call_blocking(|conn| {
            conn.execute_batch("CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (5)")
                .map_err(failed)
        })
        .expect("seed");

        let n: i64 = db
            .read_blocking(|conn| {
                conn.query_row("SELECT n FROM t", [], |row| row.get(0))
                    .map_err(failed)
            })
            .expect("read");

        assert_eq!(n, 5);
    }

    #[tokio::test]
    async fn read_runs_on_the_blocking_pool_and_agrees_with_call() {
        let (_dir, db) = file_db("read-async");
        db.call(|conn| conn.execute("INSERT INTO t VALUES (4)", []).map_err(failed))
            .await
            .expect("write");

        let sum: i64 = db
            .read(|conn| {
                conn.query_row("SELECT SUM(n) FROM t", [], |row| row.get(0))
                    .map_err(failed)
            })
            .await
            .expect("read");

        assert_eq!(sum, 5);
    }

    #[test]
    fn the_data_profile_sets_the_electron_pragmas_on_writer_and_readers() {
        let (_dir, db) = file_db("pragmas");
        let query = |conn: &Connection| -> Result<(i64, i64, i64, i64), StorageError> {
            let get = |sql: &str| {
                conn.query_row(sql, [], |row| row.get::<_, i64>(0))
                    .map_err(failed)
            };
            Ok((
                get("PRAGMA cache_size")?,
                get("PRAGMA temp_store")?,
                get("PRAGMA mmap_size")?,
                get("PRAGMA busy_timeout")?,
            ))
        };
        let from_writer = db.call_blocking(|conn| query(conn)).expect("writer");
        let from_reader = db.read_blocking(|conn| query(conn)).expect("reader");

        // temp_store 2 is MEMORY.
        assert_eq!(from_writer, (-8_000, 2, 0, BUSY_TIMEOUT_MS as i64));
        assert_eq!(from_reader, from_writer);
    }
}
