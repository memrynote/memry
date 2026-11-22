//! One writer plus a read pool per database, reached from async code only
//! through `spawn_blocking` (research R4, data-model §A.0).
//!
//! SQLite's own threading modes are not the tool here. `rusqlite`'s `Connection`
//! is `Send` but not `Sync`, and the core's async tasks are scheduled across a
//! multi-threaded runtime, so each connection needs an owner. The writer's owner
//! is a blocking mutex ([`Writer`]), deliberately and not a `tokio::sync::Mutex`: a
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
//!
//! **Body writes are told.** A write closure records which document bodies it
//! wrote while a [`BodyObserver`] is registered ([`Db::observe`]), and the
//! observer hears of them once the closure returned and the writer is free
//! ([`crate::crdt::body_writes`]).

use std::ops::{Deref, DerefMut};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::crdt::body_writes::{self, BodyObserver};
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
    writer: Arc<Writer>,
    observer: Arc<OnceLock<Weak<dyn BodyObserver>>>,
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
            writer: Arc::new(Writer::new(conn)),
            readers: Some(Arc::new(readers)),
            observer: Arc::default(),
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
            writer: Arc::new(Writer::new(conn)),
            readers: None,
            observer: Arc::default(),
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
        let db = self.clone();
        join(tokio::task::spawn_blocking(move || db.call_blocking(f))).await
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
        let observer = self.observer.get().and_then(Weak::upgrade);
        let (result, writes) = body_writes::recording(observer.is_some(), || {
            let mut guard = lock(&self.writer)?;
            let result = f(&mut guard);
            if let Some(observer) = &observer {
                let noted = body_writes::recorded();
                if !noted.is_empty() {
                    observer.bodies_committing(&noted);
                }
            }
            result
        });
        if let Some(observer) = observer.filter(|_| !writes.is_empty()) {
            observer.bodies_written(&writes);
        }
        result
    }

    /// [`Db::call_blocking`] that tells no observer: for the observer's own
    /// writes, which it runs while holding what it takes to hear one.
    #[cfg(feature = "markdown")]
    pub(crate) fn call_blocking_untold<F, T>(&self, f: F) -> Result<T, StorageError>
    where
        F: FnOnce(&mut Connection) -> Result<T, StorageError>,
    {
        body_writes::recording(false, || f(&mut *lock(&self.writer)?)).0
    }

    /// Registers the one observer of this database's body writes, for every
    /// clone of the handle. False when one is already registered.
    pub fn observe(&self, observer: Weak<dyn BodyObserver>) -> bool {
        self.observer.set(observer).is_ok()
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
                let _restore = QueryOnlyOff(&writer);
                f(&writer)
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

/// Turns `query_only` back off on every exit, an `Err` and a panic included.
struct QueryOnlyOff<'a>(&'a Connection);

impl Drop for QueryOnlyOff<'_> {
    fn drop(&mut self) {
        if let Err(err) = set_query_only(self.0, false) {
            eprintln!("memry-core: {err:?}");
        }
    }
}

fn set_query_only(conn: &Connection, on: bool) -> Result<(), StorageError> {
    conn.pragma_update(None, "query_only", on)
        .map_err(|err| StorageError::Failed {
            what: format!("could not set query_only on the in-memory database: {err}"),
        })
}

/// The writer connection and its lock. The lock hands over fairly: `parking_lot`'s mutex gives
/// it to the longest waiter at least every half millisecond. `std::sync::Mutex` on macOS lets the
/// thread that just released it take it again before a woken waiter runs, so one busy writer
/// (a sync apply loop, an indexer) starved every other: a vault write-back pass, which takes the
/// writer about ten times, waited seconds per note behind it (#5410).
///
/// A panic while the writer is held poisons it, as `std`'s does: the connection may be inside
/// a transaction the panic left open, so every later take fails instead of writing into it.
struct Writer {
    conn: parking_lot::Mutex<Connection>,
    poisoned: AtomicBool,
}

impl Writer {
    fn new(conn: Connection) -> Self {
        Self {
            conn: parking_lot::Mutex::new(conn),
            poisoned: AtomicBool::new(false),
        }
    }
}

struct WriterGuard<'a> {
    conn: parking_lot::MutexGuard<'a, Connection>,
    poisoned: &'a AtomicBool,
}

impl Deref for WriterGuard<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        &self.conn
    }
}

impl DerefMut for WriterGuard<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }
}

impl Drop for WriterGuard<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.poisoned.store(true, Ordering::Release);
        }
    }
}

fn lock(writer: &Writer) -> Result<WriterGuard<'_>, StorageError> {
    let conn = writer.conn.lock();
    if writer.poisoned.load(Ordering::Acquire) {
        return Err(StorageError::Failed {
            what: "the database mutex was poisoned by a panic in an earlier statement".to_owned(),
        });
    }
    Ok(WriterGuard {
        conn,
        poisoned: &writer.poisoned,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A caller waiting for the writer gets it while another thread takes it again and again:
    /// the hand-over is fair. Red with `std::sync::Mutex` on macOS, which hands the lock back
    /// to the thread that just released it, so a write-back pass (ten takes) waited seconds
    /// behind a busy writer (#5410). Counted in takes, not timed.
    #[test]
    fn a_waiting_caller_is_not_starved_by_a_busy_writer() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let db = Db::open_in_memory().expect("open");
        let stop = Arc::new(AtomicBool::new(false));
        let busy_takes = Arc::new(AtomicUsize::new(0));
        let busy = {
            let (db, stop, busy_takes) = (db.clone(), stop.clone(), busy_takes.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let held = lock(&db.writer).expect("busy take");
                    busy_takes.fetch_add(1, Ordering::Relaxed);
                    std::thread::sleep(std::time::Duration::from_millis(2));
                    drop(held);
                }
            })
        };
        while busy_takes.load(Ordering::Relaxed) == 0 {
            std::thread::yield_now();
        }
        let before = busy_takes.load(Ordering::Relaxed);
        const TAKES: usize = 20;
        for _ in 0..TAKES {
            db.call_blocking(|_| Ok(())).expect("waiting take");
        }
        let between = busy_takes.load(Ordering::Relaxed) - before;
        stop.store(true, Ordering::Relaxed);
        busy.join().expect("busy thread");
        assert!(
            between < TAKES * 10,
            "the busy thread took the writer {between} times while {TAKES} waiting takes ran"
        );
    }

    /// A panic while the writer is held fails every later take, as before the fair lock.
    #[test]
    fn a_panic_holding_the_writer_poisons_it() {
        let db = Db::open_in_memory().expect("open");
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            db.call_blocking(|_| -> Result<(), StorageError> { panic!("a broken statement") })
        }));
        assert!(panicked.is_err());
        let after = db.call_blocking(|_| Ok(()));
        assert!(after.is_err_and(|err| err.to_string().contains("poisoned")));
    }

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
