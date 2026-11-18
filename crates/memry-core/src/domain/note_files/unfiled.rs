//! The live notes and journal days no `note_files` row names: a record pulled from another
//! device before its file was written here (#3534 L5b). The desktop write-back gives each one
//! its file once its body is here.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

use super::failed;
use crate::api::errors::StorageError;
use crate::domain::{journal, notes, properties, tags};

/// What a new file for an unfiled record is made of.
#[derive(Debug, Clone, PartialEq)]
pub struct Unfiled {
    /// A note's title, or a day's date.
    pub title: String,
    pub folder_path: Option<String>,
    /// The day's date, `None` for a note.
    pub date: Option<String>,
    pub tags: Vec<String>,
    pub properties: Map<String, Value>,
}

/// A live markdown note, or a live day not owed a move of its file, that no row names.
const UNFILED: &str = "SELECT id, title, folder_path, 0 AS is_day FROM notes n
  WHERE n.deleted_at IS NULL AND n.file_type = 'markdown'
    AND NOT EXISTS (SELECT 1 FROM note_files f WHERE f.note_id = n.id)
 UNION ALL
 SELECT id, date, NULL, 1 FROM journal_entries j
  WHERE j.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM note_files f WHERE f.note_id = j.id)
    AND NOT EXISTS (SELECT 1 FROM note_place_owed o WHERE o.note_id = j.id)";

/// Every unfiled note and day, in id order: the open reconcile gives each a pass, which covers
/// a crash between a pull's commit and its pass, and a vault synced by a build that wrote no
/// file for a pulled record.
pub fn unfiled_bodies(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(&format!("SELECT id FROM ({UNFILED}) ORDER BY id"))
        .map_err(failed)?;
    statement
        .query_map([], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// The record `id` when it is unfiled, with the tags and properties its new file carries.
pub fn unfiled(conn: &Connection, id: &str) -> Result<Option<Unfiled>, StorageError> {
    let found = conn
        .query_row(
            &format!("SELECT title, folder_path, is_day FROM ({UNFILED}) WHERE id = ?1"),
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )
        .optional()
        .map_err(failed)?;
    let Some((title, folder_path, is_day)) = found else {
        return Ok(None);
    };
    let item_type = if is_day {
        journal::ITEM_TYPE
    } else {
        notes::ITEM_TYPE
    };
    Ok(Some(Unfiled {
        date: is_day.then(|| title.clone()),
        title,
        folder_path,
        tags: tags::list(conn, item_type, id)?,
        properties: properties::values(conn, item_type, id)?,
    }))
}
