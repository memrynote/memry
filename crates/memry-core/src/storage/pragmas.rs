//! The pragmas and SQL functions every core-owned connection runs under, written
//! once so the writer and every reader of a database agree (research R4, §A.0).
//!
//! | Pragma                 | Writer | Reader | Why                                         |
//! | ---------------------- | ------ | ------ | ------------------------------------------- |
//! | `busy_timeout` 5000    | yes    | yes    | a checkpoint must not fail a concurrent read |
//! | `foreign_keys` ON      | yes    | yes    | a reader runs the same joins                 |
//! | `synchronous` NORMAL   | yes    | no     | only a writer syncs; harmless on a reader   |
//! | `temp_store` MEMORY    | yes    | yes    | sort and index spill stays off the disk     |
//! | `cache_size`           | yes    | yes    | per [`Profile`], the Electron values        |
//! | `journal_mode` WAL     | yes    | no     | persistent in the file; readers inherit it  |
//! | `journal_size_limit`   | yes    | no     | caps the `-wal` the writer leaves behind    |
//! | `mmap_size` 0          | yes    | yes    | a truncated page must not SIGBUS the app    |
//! | `query_only` ON        | no     | yes    | a misclassified write fails, never corrupts |
//!
//! `wal_autocheckpoint` stays at SQLite's 1000 pages. A reader holds a snapshot
//! only for one call, so checkpoints finish.

use std::time::Duration;

use rusqlite::Connection;
use rusqlite::functions::FunctionFlags;
use rusqlite::types::{Value, ValueRef};

use crate::api::errors::StorageError;

/// How long a connection waits for another connection's lock, and how long a
/// caller waits for a free reader, before giving up (research R4). Long enough
/// that a compaction pass does not fail a concurrent read, short enough that a
/// genuinely stuck writer surfaces.
pub const BUSY_TIMEOUT_MS: u64 = 5_000;

/// Which database a connection belongs to. Only the page cache differs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    /// `data.db`: 8000 KiB of page cache.
    Data,
    /// `index.db`: 16000 KiB, because a search touches far more pages.
    Index,
}

impl Profile {
    /// Negative `cache_size` is KiB (the Electron values, `database/client.ts`).
    fn cache_kib(self) -> i64 {
        match self {
            Self::Data => -8_000,
            Self::Index => -16_000,
        }
    }
}

fn fail(what: &str, err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: format!("could not set {what}: {err}"),
    }
}

/// Pragmas and functions for the one connection that writes.
pub fn configure_writer(conn: &Connection, profile: Profile) -> Result<(), StorageError> {
    // Asserted here rather than discovered on the first search: a core without
    // FTS5 cannot index anything and should say so at startup (research R4).
    assert_fts5(conn)?;
    common(conn, profile)?;

    // `journal_mode` answers with the mode it settled on, so it is a query and
    // not an update. A `:memory:` database answers `memory` and that is fine.
    let _mode: String = conn
        .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
        .map_err(|err| fail("journal_mode", err))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|err| fail("synchronous", err))?;
    conn.pragma_update(None, "journal_size_limit", 67_108_864_i64)
        .map_err(|err| fail("journal_size_limit", err))?;
    register_functions(conn)
}

/// Pragmas and functions for a pooled reader. The connection is already opened
/// `SQLITE_OPEN_READ_ONLY`; `query_only` is the second lock on the same door.
pub fn configure_reader(conn: &Connection, profile: Profile) -> Result<(), StorageError> {
    common(conn, profile)?;
    conn.pragma_update(None, "query_only", true)
        .map_err(|err| fail("query_only", err))?;
    register_functions(conn)
}

fn common(conn: &Connection, profile: Profile) -> Result<(), StorageError> {
    conn.busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS))
        .map_err(|err| fail("busy_timeout", err))?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|err| fail("foreign_keys", err))?;
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(|err| fail("temp_store", err))?;
    conn.pragma_update(None, "cache_size", profile.cache_kib())
        .map_err(|err| fail("cache_size", err))?;
    conn.pragma_update(None, "mmap_size", 0_i64)
        .map_err(|err| fail("mmap_size", err))?;
    Ok(())
}

/// `tag_fold(text)`: tag identity (§13.7.7), because `COLLATE NOCASE` folds ASCII
/// only. `ulower(x)`: Unicode lowercase of a text value, any other value
/// unchanged, the SQL twin of the desktop `ulower` function.
fn register_functions(conn: &Connection) -> Result<(), StorageError> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    conn.create_scalar_function("tag_fold", 1, flags, |ctx| {
        Ok(crate::domain::tags::fold(&ctx.get::<String>(0)?))
    })
    .map_err(|err| fail("tag_fold", err))?;
    conn.create_scalar_function("ulower", 1, flags, |ctx| {
        Ok(match ctx.get_raw(0) {
            ValueRef::Text(bytes) => Value::Text(String::from_utf8_lossy(bytes).to_lowercase()),
            ValueRef::Null => Value::Null,
            ValueRef::Integer(n) => Value::Integer(n),
            ValueRef::Real(x) => Value::Real(x),
            ValueRef::Blob(bytes) => Value::Blob(bytes.to_vec()),
        })
    })
    .map_err(|err| fail("ulower", err))
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
    use crate::storage::Db;

    fn ulower(db: &Db, value: Value) -> Value {
        db.read_blocking(|conn| {
            conn.query_row("SELECT ulower(?1)", [value], |row| row.get(0))
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        })
        .expect("ulower")
    }

    #[test]
    fn ulower_folds_unicode_and_passes_other_values_through() {
        let dir = crate::storage::test_support::temp_dir("ulower");
        // A file-backed database, so the call runs on a pooled reader.
        let db = Db::open(&dir.path().join("data.db")).expect("open");

        let text = |s: &str| ulower(&db, Value::Text(s.to_owned()));
        assert_eq!(
            text("Ödeme Toplantısı"),
            Value::Text("ödeme toplantısı".to_owned())
        );
        // Rust's lowercase of `İ` is `i` plus a combining dot above (U+0307).
        assert_eq!(text("İ"), Value::Text("i\u{307}".to_owned()));
        // Final sigma: Σ at the end of a word lowercases to ς.
        assert_eq!(text("ΟΔΟΣ"), Value::Text("οδος".to_owned()));
        assert_eq!(ulower(&db, Value::Null), Value::Null);
        assert_eq!(ulower(&db, Value::Integer(42)), Value::Integer(42));
    }
}
