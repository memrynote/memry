//! SQLite DB layer. Owns the single process-wide data DB connection.

use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use std::{
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

pub type DbGuard<'a> = MutexGuard<'a, Connection>;

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    pub fn open(path: impl AsRef<Path>) -> AppResult<Self> {
        let path = path.as_ref();

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        Self::with_init(Connection::open(path)?, |conn| {
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA foreign_keys = ON;
                 PRAGMA busy_timeout = 5000;",
            )
        })
    }

    #[cfg(any(test, feature = "test-helpers"))]
    pub fn open_memory() -> AppResult<Self> {
        Self::with_init(Connection::open_in_memory()?, |conn| {
            conn.execute_batch(
                "PRAGMA journal_mode = MEMORY;
                 PRAGMA foreign_keys = ON;",
            )
        })
    }

    pub fn with_conn<T>(&self, f: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
        let mut conn = self.conn()?;
        f(&mut conn)
    }

    pub fn conn(&self) -> AppResult<DbGuard<'_>> {
        self.conn.lock().map_err(AppError::from)
    }

    fn with_init(
        conn: Connection,
        init: impl FnOnce(&Connection) -> rusqlite::Result<()>,
    ) -> AppResult<Self> {
        init(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }
}
