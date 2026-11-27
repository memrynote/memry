//! The writer side of the Electron vault import (Step 36, #3553).
//!
//! Desktop reads an Electron `data.db`/`index.db` pair and hands rows to the
//! function groups of this module, which write them into a freshly migrated core
//! pair in a staging directory. Desktop never writes SQL against core tables.
//! Rust-only: nothing here crosses UniFFI.
//!
//! A staged pair runs with `journal_mode=OFF` ([`pragmas::configure_staging`]):
//! a staging run that fails or crashes is deleted and repeated from the untouched
//! Electron files, never repaired, so a journal would only cost time.

use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use crate::api::errors::StorageError;
use crate::storage::migrations::{self, INDEX_MIGRATIONS};
use crate::storage::pragmas::{self, Profile};

mod crdt;
#[cfg(feature = "vec")]
mod embeddings;
mod local;
mod notes;
mod outbox;
mod records;
mod sync_state;

pub use crdt::{
    DocumentState, ImportBodyPush, ImportBodySync, ImportBodyVersion, ImportDocument,
    ImportFileHash, document_state,
};
#[cfg(feature = "vec")]
pub use embeddings::{DerivedTable, ImportEmbeddedNote};
pub use local::{ImportInboxJob, ImportInboxTag, ImportInboxUpload, ImportLocalEvent};
pub use notes::{ImportNoteFile, ImportNoteSnapshot};
pub use outbox::{ImportDeleted, ImportQueued, ImportTombstoneClock};
pub use records::ImportRecord;
pub use sync_state::{
    ImportHistory, ImportQuarantined, ImportRecordCursor, ImportRefused, ImportSyncState,
};

/// `meta` key a finished import writes into the staged `data.db`, last. Its
/// presence in `<vault>/.memry/core/data.db` means the vault was imported.
/// Shipped key: older and newer builds ignore it, so its value only grows.
pub const IMPORT_MARKER_KEY: &str = "electron_import.v1";

pub const DATA_FILE: &str = "data.db";
pub const INDEX_FILE: &str = "index.db";

/// Which staged database a call reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Staged {
    Data,
    Index,
}

/// The staged core pair of one import run.
pub struct ImportWriter {
    data: Connection,
    index: Connection,
}

impl ImportWriter {
    /// Creates `data.db` and `index.db` in `dir` at this build's schema. Refuses a
    /// directory that already holds either file: a leftover of an earlier run is
    /// the caller's to delete, and writing over one would mix two runs.
    pub fn create(dir: &Path) -> Result<Self, StorageError> {
        #[cfg(feature = "vec")]
        crate::storage::vec::register()?;
        let mut data = create_file(&dir.join(DATA_FILE), Profile::Data)?;
        let mut index = create_file(&dir.join(INDEX_FILE), Profile::Index)?;
        migrations::run_data(&mut data)?;
        migrations::run_atomic(&mut index, INDEX_MIGRATIONS)?;
        #[cfg(feature = "vec")]
        crate::storage::vec::ensure_vec_tables(&mut index).map_err(|err| StorageError::Failed {
            what: format!("vector table: {err}"),
        })?;
        Ok(Self { data, index })
    }

    /// Rows in `table` of a staged database. The name is checked against the
    /// schema first, so it is never spliced in unless it names a real table.
    pub fn row_count(&self, db: Staged, table: &str) -> Result<u64, StorageError> {
        let conn = self.conn(db);
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                [table],
                |row| row.get(0),
            )
            .map_err(failed)?;
        if !exists {
            return Err(StorageError::NotFound {
                what: format!("staged table {table}"),
            });
        }
        let quoted = table.replace('"', "\"\"");
        conn.query_row(&format!("SELECT count(*) FROM \"{quoted}\""), [], |row| {
            row.get::<_, i64>(0)
        })
        .map(|count| count as u64)
        .map_err(failed)
    }

    /// Stage check 6: `integrity_check` and `foreign_key_check` of both staged
    /// databases. Returns the problems found (at most ten per check), empty when
    /// both are clean.
    pub fn integrity_problems(&self) -> Result<Vec<String>, StorageError> {
        let mut problems = Vec::new();
        for (name, conn) in [(DATA_FILE, &self.data), (INDEX_FILE, &self.index)] {
            let mut stmt = conn.prepare("PRAGMA integrity_check(10)").map_err(failed)?;
            let lines = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(failed)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(failed)?;
            problems.extend(
                lines
                    .into_iter()
                    .filter(|line| line != "ok")
                    .map(|line| format!("{name} integrity: {line}")),
            );
            let mut stmt = conn.prepare("PRAGMA foreign_key_check").map_err(failed)?;
            let violations = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(failed)?
                .take(10)
                .collect::<Result<Vec<_>, _>>()
                .map_err(failed)?;
            problems.extend(
                violations
                    .into_iter()
                    .map(|table| format!("{name} foreign key violation in {table}")),
            );
        }
        Ok(problems)
    }

    /// Writes [`IMPORT_MARKER_KEY`] and closes both databases. The caller writes
    /// the marker only after every stage check passed, so a staged pair without it
    /// is unfinished.
    pub fn finish(self, marker: &str) -> Result<(), StorageError> {
        self.data
            .execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                params![IMPORT_MARKER_KEY, marker],
            )
            .map_err(failed)?;
        self.data.close().map_err(|(_, err)| failed(err))?;
        self.index.close().map_err(|(_, err)| failed(err))
    }

    fn conn(&self, db: Staged) -> &Connection {
        match db {
            Staged::Data => &self.data,
            Staged::Index => &self.index,
        }
    }
}

/// The [`IMPORT_MARKER_KEY`] value of an existing core `data.db`, read through a
/// read-only connection so the file is not changed. `None` when the file has no
/// marker (a vault first opened natively). An unreadable file is an error, never
/// `None`: the caller must not take a file it cannot read for one it may replace.
pub fn read_marker(data_db: &Path) -> Result<Option<String>, StorageError> {
    let conn = Connection::open_with_flags(
        data_db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(failed)?;
    let has_meta: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta')",
            [],
            |row| row.get(0),
        )
        .map_err(failed)?;
    if !has_meta {
        return Ok(None);
    }
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        [IMPORT_MARKER_KEY],
        |row| row.get(0),
    )
    .optional()
    .map_err(failed)
}

fn create_file(path: &Path, profile: Profile) -> Result<Connection, StorageError> {
    if path.exists() {
        return Err(StorageError::Failed {
            what: format!("{} already exists", path.display()),
        });
    }
    let conn = Connection::open(path).map_err(failed)?;
    pragmas::configure_staging(&conn, profile)?;
    Ok(conn)
}

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: format!("import staging: {err}"),
    }
}

#[cfg(test)]
mod tests;
