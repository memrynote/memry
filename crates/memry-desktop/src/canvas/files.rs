//! `canvas_files` (data migration `0036`) and `canvas_scene_marks` (`0037`): where this device
//! keeps each canvas's `.excalidraw` document, and the point where the document and the record
//! last agreed: the sha256 of the document's bytes and of the record's scene then. Device-local,
//! never synced; the services here are their only writer, and only at an agreement.

use memry_core::api::errors::StorageError;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest as _, Sha256};

use crate::vault::layout::CANVAS_DIR;

/// A canvas's document, and where it last agreed with the record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileRow {
    pub path: String,
    /// The document's bytes at the agreement.
    pub sha256: String,
    /// The record's scene at the agreement ([`scene_sha256`]); `None` when unknown (a row an
    /// earlier build wrote), which settle reads as "the record changed".
    pub record_sha256: Option<String>,
}

impl FileRow {
    /// A row whose record side is not known yet.
    pub(crate) fn unmarked(path: String, sha256: String) -> Self {
        Self {
            path,
            sha256,
            record_sha256: None,
        }
    }
}

/// The sha256 of a record's scene text.
pub(crate) fn scene_sha256(scene: &str) -> String {
    hex::encode(Sha256::digest(scene.as_bytes()))
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: format!("canvas_files: {error}"),
    }
}

pub(crate) fn get(conn: &Connection, canvas_id: &str) -> Result<Option<FileRow>, StorageError> {
    conn.query_row(
        // A mark of another file sha belongs to an earlier agreement: unknown.
        "SELECT f.file_path, f.scene_sha256, m.record_sha256
         FROM canvas_files f
         LEFT JOIN canvas_scene_marks m
           ON m.canvas_id = f.canvas_id AND m.file_sha256 = f.scene_sha256
         WHERE f.canvas_id = ?1",
        [canvas_id],
        |row| {
            Ok(FileRow {
                path: row.get(0)?,
                sha256: row.get(1)?,
                record_sha256: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(failed)
}

pub(crate) fn put(
    conn: &Connection,
    canvas_id: &str,
    row: &FileRow,
    now_ms: i64,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO canvas_files (canvas_id, file_path, scene_sha256, written_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (canvas_id) DO UPDATE SET
             file_path = excluded.file_path,
             scene_sha256 = excluded.scene_sha256,
             written_at = excluded.written_at",
        params![canvas_id, row.path, row.sha256, now_ms],
    )
    .map_err(failed)?;
    match &row.record_sha256 {
        Some(record_sha256) => conn.execute(
            "INSERT INTO canvas_scene_marks (canvas_id, file_sha256, record_sha256)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (canvas_id) DO UPDATE SET
                 file_sha256 = excluded.file_sha256,
                 record_sha256 = excluded.record_sha256",
            params![canvas_id, row.sha256, record_sha256],
        ),
        None => conn.execute(
            "DELETE FROM canvas_scene_marks WHERE canvas_id = ?1",
            [canvas_id],
        ),
    }
    .map(drop)
    .map_err(failed)
}

pub(crate) fn remove(conn: &Connection, canvas_id: &str) -> Result<(), StorageError> {
    conn.execute("DELETE FROM canvas_files WHERE canvas_id = ?1", [canvas_id])
        .map_err(failed)?;
    // A mark without its row is never read (`get` joins on the row), so this second
    // statement only keeps the table small.
    conn.execute(
        "DELETE FROM canvas_scene_marks WHERE canvas_id = ?1",
        [canvas_id],
    )
    .map(drop)
    .map_err(failed)
}

/// Re-points a canvas's row at `folder` (`None` the root), keeping its file name: its folder's
/// directory moved with the document in it.
pub(crate) fn refile(
    conn: &Connection,
    canvas_id: &str,
    folder: Option<&str>,
) -> Result<(), StorageError> {
    let Some(row) = get(conn, canvas_id)? else {
        return Ok(());
    };
    let name = row.path.rsplit('/').next().unwrap_or_default();
    let path = match folder {
        Some(folder) => format!("{CANVAS_DIR}/{folder}/{name}"),
        None => format!("{CANVAS_DIR}/{name}"),
    };
    conn.execute(
        "UPDATE canvas_files SET file_path = ?2 WHERE canvas_id = ?1",
        params![canvas_id, path],
    )
    .map(drop)
    .map_err(failed)
}

/// Every row as `(canvas_id, file_path, live)`; `live` is false for a canvas that is deleted or
/// has no record.
pub(crate) fn all(conn: &Connection) -> Result<Vec<(String, String, bool)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT f.canvas_id, f.file_path,
                    EXISTS (SELECT 1 FROM canvases c WHERE c.id = f.canvas_id AND c.deleted_at IS NULL)
             FROM canvas_files f",
        )
        .map_err(failed)?;
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}
