//! The `note_files` rows desktop's file text runner reads (#3542 lane G): Electron's
//! `listFiledTextFiles` and `listMarkdownNotes` (`database/queries/extracted-text.ts:83-111`),
//! which read `note_cache`. This index keeps file identity in `data.db`, so they read here.

use rusqlite::Connection;

use super::failed;
use crate::api::errors::StorageError;

/// A filed PDF or image: the note whose own file it is, its vault-relative path and its
/// `file_type` (`pdf` or `image`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FiledTextFile {
    pub note_id: String,
    pub path: String,
    pub file_type: String,
}

fn id_list(ids: &[String]) -> Result<String, StorageError> {
    serde_json::to_string(ids).map_err(|err| StorageError::Failed {
        what: err.to_string(),
    })
}

/// The filed PDFs and images among `ids`, or every one (`listFiledTextFiles`), in path order.
pub fn filed_text_files(
    conn: &Connection,
    ids: Option<&[String]>,
) -> Result<Vec<FiledTextFile>, StorageError> {
    let ids = ids.map(id_list).transpose()?;
    let mut statement = conn
        .prepare_cached(
            "SELECT note_id, path, file_type FROM note_files
              WHERE file_type IN ('pdf', 'image')
                AND (?1 IS NULL OR note_id IN (SELECT value FROM json_each(?1)))
              ORDER BY path",
        )
        .map_err(failed)?;
    statement
        .query_map([ids], |row| {
            Ok(FiledTextFile {
                note_id: row.get(0)?,
                path: row.get(1)?,
                file_type: row.get(2)?,
            })
        })
        .and_then(|rows| rows.collect())
        .map_err(failed)
}

/// The markdown notes among `ids`, as `(note_id, path)`: the ones that can own an
/// attachments folder (`listMarkdownNotes`), in path order.
pub fn markdown_notes(
    conn: &Connection,
    ids: &[String],
) -> Result<Vec<(String, String)>, StorageError> {
    let ids = id_list(ids)?;
    let mut statement = conn
        .prepare_cached(
            "SELECT note_id, path FROM note_files
              WHERE file_type = 'markdown' AND note_id IN (SELECT value FROM json_each(?1))
              ORDER BY path",
        )
        .map_err(failed)?;
    statement
        .query_map([ids], |row| Ok((row.get(0)?, row.get(1)?)))
        .and_then(|rows| rows.collect())
        .map_err(failed)
}

/// The ids among `ids` that name no note any more: no `note_files` row, and no live record in
/// `notes` or `journal_entries`. A filed PDF or image has a record but no row until #4209, so
/// it is not gone.
pub fn gone_notes(conn: &Connection, ids: &[String]) -> Result<Vec<String>, StorageError> {
    let ids = id_list(ids)?;
    let mut statement = conn
        .prepare_cached(
            "SELECT i.value FROM json_each(?1) i
              WHERE NOT EXISTS (SELECT 1 FROM note_files f WHERE f.note_id = i.value)
                AND NOT EXISTS (SELECT 1 FROM notes n
                                 WHERE n.id = i.value AND n.deleted_at IS NULL)
                AND NOT EXISTS (SELECT 1 FROM journal_entries j
                                 WHERE j.id = i.value AND j.deleted_at IS NULL)
              ORDER BY i.value",
        )
        .map_err(failed)?;
    statement
        .query_map([ids], |row| row.get(0))
        .and_then(|rows| rows.collect())
        .map_err(failed)
}
