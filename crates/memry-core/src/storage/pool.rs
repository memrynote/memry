//! A fixed pool of read-only connections beside a database's one writer.
//!
//! The writer's mutex is held for a whole write transaction. Without a pool a
//! list the UI asks for during a sync pass waits behind every statement of that
//! pass. WAL lets readers see the last committed snapshot while a writer is
//! mid-transaction, so the pool is the second half of what WAL already allows.
//!
//! Checkout moves the `Connection` out of the pool, so nothing is locked while a
//! reader runs and a panic inside the reader cannot poison the pool: the guard
//! puts the connection back on drop, also while unwinding.

use std::path::Path;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags};

use crate::api::errors::StorageError;
use crate::storage::pragmas::{self, BUSY_TIMEOUT_MS, Profile};

/// Readers per on-disk database. Fixed: the UI has few concurrent screens, and a
/// fifth reader would only queue behind the same disk.
pub const READER_COUNT: usize = 4;

pub(crate) struct ReaderPool {
    idle: Mutex<Vec<Connection>>,
    returned: Condvar,
}

/// A checked-out reader. Derefs to the connection; returns it to the pool on drop.
pub(crate) struct Reader<'pool> {
    pool: &'pool ReaderPool,
    conn: Option<Connection>,
}

impl ReaderPool {
    /// Opens [`READER_COUNT`] read-only connections on `path`. The writer must
    /// have opened the file first: a reader cannot create it, and it inherits the
    /// WAL mode the writer persisted.
    pub(crate) fn open(path: &Path, profile: Profile) -> Result<Self, StorageError> {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI;
        let mut idle = Vec::with_capacity(READER_COUNT);
        for _ in 0..READER_COUNT {
            let conn =
                Connection::open_with_flags(path, flags).map_err(|err| StorageError::Failed {
                    what: format!("could not open a reader on {}: {err}", path.display()),
                })?;
            pragmas::configure_reader(&conn, profile)?;
            idle.push(conn);
        }
        Ok(Self {
            idle: Mutex::new(idle),
            returned: Condvar::new(),
        })
    }

    /// Waits at most [`BUSY_TIMEOUT_MS`] for a free reader.
    pub(crate) fn checkout(&self) -> Result<Reader<'_>, StorageError> {
        self.checkout_within(Duration::from_millis(BUSY_TIMEOUT_MS))
    }

    fn checkout_within(&self, wait: Duration) -> Result<Reader<'_>, StorageError> {
        let deadline = Instant::now() + wait;
        let mut idle = self.lock()?;
        loop {
            if let Some(conn) = idle.pop() {
                return Ok(Reader {
                    pool: self,
                    conn: Some(conn),
                });
            }
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                return Err(StorageError::Failed {
                    what: "read pool exhausted".to_owned(),
                });
            };
            idle = self
                .returned
                .wait_timeout(idle, left)
                .map_err(|_| poisoned())?
                .0;
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Vec<Connection>>, StorageError> {
        self.idle.lock().map_err(|_| poisoned())
    }
}

fn poisoned() -> StorageError {
    StorageError::Failed {
        what: "the read pool mutex was poisoned".to_owned(),
    }
}

impl std::ops::Deref for Reader<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        self.conn
            .as_ref()
            .expect("a reader holds its connection until it drops")
    }
}

impl Drop for Reader<'_> {
    fn drop(&mut self) {
        let Some(conn) = self.conn.take() else { return };
        // A closure that left a read transaction open would pin a WAL snapshot
        // and stall checkpoints for as long as the pool lives.
        if !conn.is_autocommit() {
            let _ = conn.execute_batch("ROLLBACK");
        }
        // A poisoned pool mutex means another thread panicked inside `checkout`
        // itself; the connection is dropped rather than returned, and the pool
        // shrinks by one. Nothing in `checkout` can panic today.
        if let Ok(mut idle) = self.pool.idle.lock() {
            idle.push(conn);
            self.pool.returned.notify_one();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::temp_dir;

    fn pool() -> (crate::storage::test_support::TempDir, ReaderPool) {
        let dir = temp_dir("pool");
        let path = dir.path().join("data.db");
        // The writer creates the file and persists WAL, as `Db::open` does.
        let writer = Connection::open(&path).expect("create");
        let _mode: String = writer
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .expect("wal");
        let pool = ReaderPool::open(&path, Profile::Data).expect("pool");
        // Keep the writer alive: the last connection closing checkpoints and
        // removes the -wal and -shm a reader opened against.
        std::mem::forget(writer);
        (dir, pool)
    }

    #[test]
    fn the_pool_holds_four_readers_and_a_fifth_waits_then_fails() {
        let (_dir, pool) = pool();
        let held: Vec<_> = (0..READER_COUNT)
            .map(|_| pool.checkout().expect("a free reader"))
            .collect();

        let started = Instant::now();
        let refused = pool.checkout_within(Duration::from_millis(60));

        assert!(matches!(
            refused,
            Err(StorageError::Failed { ref what }) if what == "read pool exhausted"
        ));
        assert!(started.elapsed() >= Duration::from_millis(50));
        drop(held);
        pool.checkout()
            .expect("a reader is back after the guards drop");
    }

    #[test]
    fn a_reader_comes_back_after_a_panic_inside_its_closure() {
        let (_dir, pool) = pool();
        for _ in 0..READER_COUNT * 2 {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _reader = pool.checkout().expect("reader");
                panic!("a reader closure panics");
            }));
            assert!(outcome.is_err());
        }
        // Eight panics through a pool of four: every reader came back each time.
        let held: Vec<_> = (0..READER_COUNT)
            .map(|_| pool.checkout().expect("reader"))
            .collect();
        assert_eq!(held.len(), READER_COUNT);
    }

    #[test]
    fn a_reader_that_left_a_transaction_open_is_rolled_back_on_return() {
        let (_dir, pool) = pool();
        {
            let reader = pool.checkout().expect("reader");
            reader.execute_batch("BEGIN").expect("begin");
            assert!(!reader.is_autocommit());
        }
        let held: Vec<_> = (0..READER_COUNT)
            .map(|_| pool.checkout().expect("reader"))
            .collect();
        assert!(held.iter().all(|reader| reader.is_autocommit()));
    }
}
