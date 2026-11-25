//! The live notes and journal days no `note_files` row names: a record pulled from another
//! device before its file was written here (#3534 L5b). The desktop write-back gives each one
//! its file once its body is here.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

use super::failed;
use crate::api::errors::StorageError;
use crate::domain::note_meta::note_payload;
use crate::domain::notes::names;
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
    /// The other names the record holds. `None` for a day with no stored list (no
    /// `journal_aliases` row, or NULL): a pull never sent one, so the file keeps its own. A
    /// note's NULL reads as `[]`.
    pub aliases: Option<Vec<String>>,
    pub properties: Map<String, Value>,
    /// A note's `cover` as its payload carries it (protocol 13.7.1.1), unchecked: the writer
    /// gates each key as Electron's `applyNoteCoverToFrontmatter` does. `None` for a day.
    pub cover: Option<Map<String, Value>>,
}

/// A live markdown note, or a live day not owed a move of its file, that no row names.
///
/// Invariant (#5766): an id a live journal day holds reads as the day, never as the `notes` row
/// a peer's same-id `note` record keeps beside it (Electron names a day's pictures that way,
/// #5731). The journal layer alone places a day's file, at its date's path under the vault's
/// format; the note's title and folder would place it elsewhere and patch it as a note.
const UNFILED: &str = "SELECT id, title, folder_path, 0 AS is_day, aliases FROM notes n
  WHERE n.deleted_at IS NULL AND n.file_type = 'markdown'
    AND NOT EXISTS (SELECT 1 FROM note_files f WHERE f.note_id = n.id)
    AND NOT EXISTS (SELECT 1 FROM journal_entries d WHERE d.id = n.id AND d.deleted_at IS NULL)
 UNION ALL
 SELECT id, date, NULL, 1,
        (SELECT aliases FROM journal_aliases a WHERE a.journal_id = j.id)
   FROM journal_entries j
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

/// The record `id` when it is unfiled, with the tags, other names, properties and cover its new
/// file carries.
pub fn unfiled(conn: &Connection, id: &str) -> Result<Option<Unfiled>, StorageError> {
    let found = conn
        .query_row(
            &format!("SELECT title, folder_path, is_day, aliases FROM ({UNFILED}) WHERE id = ?1"),
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(failed)?;
    let Some((title, folder_path, is_day, aliases)) = found else {
        return Ok(None);
    };
    record_of(conn, id, (title, folder_path, is_day, aliases)).map(Some)
}

/// The live markdown note or journal day `id` as its record reads now, whether or not a row
/// names its file: what a pulled change gives the file it has (desktop write-back, #5309; a
/// day's tags, other names and properties, #5509). `None` for a deleted day or note, and for a
/// file note. A live day's id reads as the day ([`UNFILED`]'s invariant, #5766).
pub fn placed(conn: &Connection, id: &str) -> Result<Option<Unfiled>, StorageError> {
    let found = conn
        .query_row(
            "SELECT title, folder_path, 0, aliases FROM notes n
              WHERE id = ?1 AND deleted_at IS NULL AND file_type = 'markdown'
                AND NOT EXISTS (SELECT 1 FROM journal_entries d
                                 WHERE d.id = n.id AND d.deleted_at IS NULL)
             UNION ALL
             SELECT date, NULL, 1,
                    (SELECT aliases FROM journal_aliases a WHERE a.journal_id = j.id)
               FROM journal_entries j
              WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(failed)?;
    found.map(|found| record_of(conn, id, found)).transpose()
}

/// The record `id` read from its place `(title, folder_path, is_day, aliases)`.
fn record_of(
    conn: &Connection,
    id: &str,
    (title, folder_path, is_day, aliases): (String, Option<String>, bool, Option<String>),
) -> Result<Unfiled, StorageError> {
    let item_type = if is_day {
        journal::ITEM_TYPE
    } else {
        notes::ITEM_TYPE
    };
    let aliases = match (is_day, aliases) {
        (true, None) => None,
        (_, aliases) => {
            Some(
                names::parse_stored(aliases).map_err(|error| StorageError::Failed {
                    what: format!("{id} aliases: {error}"),
                })?,
            )
        }
    };
    let cover = match is_day {
        true => None,
        false => note_payload(conn, id)?.and_then(|mut payload| match payload.remove("cover") {
            Some(Value::Object(cover)) => Some(cover),
            _ => None,
        }),
    };
    Ok(Unfiled {
        date: is_day.then(|| title.clone()),
        title,
        folder_path,
        tags: tags::list(conn, item_type, id)?,
        aliases,
        properties: properties::values(conn, item_type, id)?,
        cover,
    })
}

/// Whether a day's file must not be named now: a journal setting change is recorded, or days
/// moved with the journal folder are held until the setting follows them. A day named under
/// the saved setting meanwhile would land where the settled journal does not read it, or make
/// the old folder again so the setting never follows (desktop `create_day_now`).
#[cfg(feature = "markdown")]
pub fn days_wait(conn: &Connection) -> Result<bool, StorageError> {
    Ok(
        crate::domain::notes::journal_change::pending(conn)?.is_some()
            || crate::domain::notes::place_held::any_held(conn)?,
    )
}
