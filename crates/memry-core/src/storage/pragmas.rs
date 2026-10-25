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

/// `tag_fold(x)`: a tag's identity (§13.7.7), because `COLLATE NOCASE` folds
/// ASCII only. `ulower(x)`: Unicode lowercase, as `String.prototype.toLowerCase`
/// does it. Both are the SQL twins of the desktop functions in
/// `database/sqlite-functions.ts`, which pass anything but text (NULL, numbers,
/// blobs) through untouched so either is safe to wrap around any column.
fn register_functions(conn: &Connection) -> Result<(), StorageError> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    conn.create_scalar_function("tag_fold", 1, flags, |ctx| {
        Ok(map_text(ctx.get_raw(0), |text| {
            crate::domain::tags::fold(text)
        }))
    })
    .map_err(|err| fail("tag_fold", err))?;
    conn.create_scalar_function("ulower", 1, flags, |ctx| {
        Ok(map_text(ctx.get_raw(0), str::to_lowercase))
    })
    .map_err(|err| fail("ulower", err))
}

/// Applies `f` to a text value and returns every other value unchanged.
fn map_text(value: ValueRef<'_>, f: impl Fn(&str) -> String) -> Value {
    match value {
        ValueRef::Text(bytes) => Value::Text(f(&String::from_utf8_lossy(bytes))),
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => Value::Integer(n),
        ValueRef::Real(x) => Value::Real(x),
        ValueRef::Blob(bytes) => Value::Blob(bytes.to_vec()),
    }
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

    fn file_db(label: &str) -> (crate::storage::test_support::TempDir, Db) {
        let dir = crate::storage::test_support::temp_dir(label);
        // File-backed, so the call runs on a pooled reader.
        let db = Db::open(&dir.path().join("data.db")).expect("open");
        (dir, db)
    }

    fn apply(db: &Db, function: &'static str, value: Value) -> Value {
        db.read_blocking(|conn| {
            conn.query_row(&format!("SELECT {function}(?1)"), [value], |row| row.get(0))
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })
        })
        .expect(function)
    }

    /// Each pair is `String.prototype.toLowerCase` of the input, taken from Node.
    #[test]
    fn ulower_matches_javascript_to_lower_case() {
        let (_dir, db) = file_db("ulower");
        for (input, js) in [
            ("Ödeme Toplantısı", "ödeme toplantısı"),
            // Dotted capital I: `i` plus a combining dot above (U+0307).
            ("İ", "i\u{307}"),
            ("İstanbul", "i\u{307}stanbul"),
            // Final sigma: ς at the end of a word, σ elsewhere.
            ("ΟΔΟΣ", "οδος"),
            ("ΑΣ ΑΣΑ Σ", "ας ασα σ"),
            ("ΣΑΣ", "σας"),
            ("Σ", "σ"),
            ("ǅ", "ǆ"),
            ("ẞ", "ß"),
        ] {
            assert_eq!(
                apply(&db, "ulower", Value::Text(input.to_owned())),
                Value::Text(js.to_owned()),
                "{input}"
            );
        }
    }

    #[test]
    fn ulower_and_tag_fold_pass_anything_but_text_through() {
        let (_dir, db) = file_db("passthrough");
        for function in ["ulower", "tag_fold"] {
            for value in [
                Value::Null,
                Value::Integer(42),
                Value::Real(1.5),
                Value::Blob(vec![0, 1, 0xFF]),
            ] {
                assert_eq!(apply(&db, function, value.clone()), value, "{function}");
            }
        }
    }
}
