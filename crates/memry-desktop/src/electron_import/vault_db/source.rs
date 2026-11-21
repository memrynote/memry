//! Copies of the Electron databases. SQLite never opens an Electron file, not even read-only: a
//! read-only open of a WAL database can still write its `-shm`. The file and its `-wal` and
//! `-journal` are copied byte for byte (`-shm` is not: the first connection to the copy rebuilds
//! it from the WAL), the copy is opened, checked, and written out once more through the online
//! backup API, which folds the WAL into one file.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use rusqlite::backup::Backup;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, Row};

use super::ImportError;
use super::tables::SourceDb;
use crate::electron_import::scratch::DEFAULT_MAX_COPY_BYTES;

const SOURCE_DIR: &str = "source";
/// Copied with the database: the WAL holds the last commits, a hot journal the undo of a torn
/// one. `-shm` is a cache of the WAL and is left behind.
const COPIED_SIDECARS: [&str; 2] = ["-wal", "-journal"];

pub(super) struct Sources {
    data: Connection,
    index: Connection,
}

impl Sources {
    pub(super) fn conn(&self, db: SourceDb) -> &Connection {
        match db {
            SourceDb::Data => &self.data,
            SourceDb::Index => &self.index,
        }
    }
}

pub(super) fn copy_sources(
    data: &Path,
    index: &Path,
    staging: &Path,
) -> Result<Sources, ImportError> {
    let dir = staging.join(SOURCE_DIR);
    fs::create_dir_all(&dir).map_err(|e| ImportError::io(&dir, e))?;
    Ok(Sources {
        data: copy_one(SourceDb::Data, data, &dir)?,
        index: copy_one(SourceDb::Index, index, &dir)?,
    })
}

/// Deletes the source copies once the staged pair is written.
pub(super) fn remove(staging: &Path) -> Result<(), ImportError> {
    let dir = staging.join(SOURCE_DIR);
    fs::remove_dir_all(&dir).map_err(|e| ImportError::io(&dir, e))
}

/// `(suffix, bytes, modified)` of one file the copy reads.
type Fingerprint = Vec<(&'static str, u64, Option<SystemTime>)>;

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(suffix);
    PathBuf::from(name)
}

/// Size and modification time of the database and each sidecar present. A missing database
/// is an error: an Electron vault always has both files, and `index.db` holds version history.
fn fingerprint(src: &Path) -> Result<Fingerprint, ImportError> {
    let mut found = Vec::new();
    for suffix in std::iter::once("").chain(COPIED_SIDECARS) {
        let path = with_suffix(src, suffix);
        match fs::metadata(&path) {
            Ok(meta) => found.push((suffix, meta.len(), meta.modified().ok())),
            Err(e) if e.kind() == io::ErrorKind::NotFound && !suffix.is_empty() => {}
            Err(e) => return Err(ImportError::io(path, e)),
        }
    }
    Ok(found)
}

fn copy_one(db: SourceDb, src: &Path, dir: &Path) -> Result<Connection, ImportError> {
    let raw = dir.join(format!("raw-{}", db.name()));
    let before = fingerprint(src)?;
    for (suffix, bytes, _) in &before {
        let from = with_suffix(src, suffix);
        if *bytes > DEFAULT_MAX_COPY_BYTES {
            return Err(ImportError::TooLarge {
                path: from,
                bytes: *bytes,
                max: DEFAULT_MAX_COPY_BYTES,
            });
        }
        fs::copy(&from, with_suffix(&raw, suffix)).map_err(|e| ImportError::io(&from, e))?;
    }
    // A checkpoint between copying the file and its WAL pairs a database with the wrong WAL.
    // Electron must have quit; if it wrote meanwhile, the run stops and can be repeated.
    if fingerprint(src)? != before {
        return Err(ImportError::SourceChanged(src.to_owned()));
    }

    let out = dir.join(db.name());
    {
        let raw_conn = Connection::open(&raw).map_err(|e| source_error(db, e))?;
        let check: String = raw_conn
            .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
            .map_err(|e| source_error(db, e))?;
        if check != "ok" {
            return Err(ImportError::Source {
                db: db.name(),
                detail: format!("quick_check: {check}"),
            });
        }
        let mut out_conn = Connection::open(&out).map_err(|e| source_error(db, e))?;
        Backup::new(&raw_conn, &mut out_conn)
            .and_then(|backup| backup.run_to_completion(4096, Duration::ZERO, None))
            .map_err(|e| source_error(db, e))?;
    }
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let path = with_suffix(&raw, suffix);
        if let Err(e) = fs::remove_file(&path)
            && e.kind() != io::ErrorKind::NotFound
        {
            return Err(ImportError::io(path, e));
        }
    }
    Connection::open_with_flags(
        &out,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| source_error(db, e))
}

pub(super) fn source_error(db: SourceDb, error: rusqlite::Error) -> ImportError {
    ImportError::Source {
        db: db.name(),
        detail: error.to_string(),
    }
}

/// Reads an id column of a source row byte for byte. Every id imports exactly as Electron stored
/// it: no trimming, case folding, Unicode normalisation or re-minting, because the vault's
/// attachment folders, document names, cursors and server items are keyed on it. An id that is
/// not TEXT, or not UTF-8, fails the import with the table and rowid named (the query selects
/// `rowid`).
pub fn read_source_id(
    row: &Row<'_>,
    db: SourceDb,
    table: &str,
    column: &str,
) -> Result<String, ImportError> {
    let not_text = || ImportError::NonTextId {
        table: table.to_owned(),
        rowid: row.get::<_, i64>("rowid").unwrap_or(-1),
    };
    match row.get_ref(column).map_err(|e| source_error(db, e))? {
        ValueRef::Text(bytes) => String::from_utf8(bytes.to_vec()).map_err(|_| not_text()),
        _ => Err(not_text()),
    }
}
