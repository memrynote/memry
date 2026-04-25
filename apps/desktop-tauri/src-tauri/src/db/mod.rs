//! SQLite DB layer. Owns the single process-wide data DB connection.

use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use std::{
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

pub mod migrations;

pub mod bookmarks;
pub mod calendar_bindings;
pub mod calendar_events;
pub mod calendar_external_events;
pub mod calendar_sources;
pub mod folder_configs;
pub mod inbox;
pub mod note_metadata;
pub mod note_positions;
pub mod notes_cache;
pub mod projects;
pub mod reminders;
pub mod saved_filters;
pub mod search_reasons;
pub mod settings;
pub mod statuses;
pub mod sync_devices;
pub mod sync_history;
pub mod sync_queue;
pub mod sync_state;
pub mod tag_definitions;
pub mod tasks;

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

        let db = Self::with_init(Connection::open(path)?, |conn| {
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA foreign_keys = ON;
                 PRAGMA busy_timeout = 5000;",
            )
        })?;
        db.with_conn(migrations::apply_pending)?;
        Ok(db)
    }

    #[cfg(any(test, feature = "test-helpers"))]
    pub fn open_memory() -> AppResult<Self> {
        let db = Self::with_init(Connection::open_in_memory()?, |conn| {
            conn.execute_batch(
                "PRAGMA journal_mode = MEMORY;
                 PRAGMA foreign_keys = ON;",
            )
        })?;
        db.with_conn(migrations::apply_pending)?;
        Ok(db)
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
