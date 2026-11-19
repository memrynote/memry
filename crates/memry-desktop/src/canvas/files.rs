//! `canvas_files` (data migration `0036`): where this device keeps each canvas's `.excalidraw`
//! document and the sha256 of the bytes the app last wrote or read there. Device-local, never
//! synced; the services here are its only writer. A save expects the document to still hold
//! those bytes, so an edit made on disk since is never overwritten.

use memry_core::api::errors::StorageError;
use rusqlite::{Connection, OptionalExtension, params};

use crate::vault::layout::CANVAS_DIR;

/// A canvas's document as the app last saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileRow {
    pub path: String,
    pub sha256: String,
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: format!("canvas_files: {error}"),
    }
}

pub(crate) fn get(conn: &Connection, canvas_id: &str) -> Result<Option<FileRow>, StorageError> {
    conn.query_row(
        "SELECT file_path, scene_sha256 FROM canvas_files WHERE canvas_id = ?1",
        [canvas_id],
        |row| {
            Ok(FileRow {
                path: row.get(0)?,
                sha256: row.get(1)?,
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
    .map(drop)
    .map_err(failed)
}

pub(crate) fn remove(conn: &Connection, canvas_id: &str) -> Result<(), StorageError> {
    conn.execute("DELETE FROM canvas_files WHERE canvas_id = ?1", [canvas_id])
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

/// When the row was last written: the scene the canvas's record held then is the one its
/// document held.
pub(crate) fn written_at(conn: &Connection, canvas_id: &str) -> Result<Option<i64>, StorageError> {
    conn.query_row(
        "SELECT written_at FROM canvas_files WHERE canvas_id = ?1",
        [canvas_id],
        |row| row.get(0),
    )
    .optional()
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
