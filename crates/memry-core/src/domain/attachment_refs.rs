//! Which notes each cached attachment serves: `attachments.note_refs` (N204).
//!
//! `notes.attachment_references` is the owner, what each note's payload says
//! (§14.7). A row's `note_refs` derives from those lists, and
//! [`merge_note_references`] is its one writer: every projection of a `note`
//! merges in the projecting transaction (#5675), and
//! [`crate::sync::note_refs_heal`] merges the notes a build before that
//! applied. The re-drive (`attachments::missing_downloads`) walks these rows.

use rusqlite::{Connection, OptionalExtension as _};

use crate::api::errors::StorageError;

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Merges a note's `attachmentReferences` into the cache.
///
/// The one writer of `note_refs`, which derives from the note's list. Every
/// projection of a `note` calls it in the projecting transaction (#5675), so
/// a peer's picture is a row the re-drive sees once its note lands. A deleted
/// note passes `Some(&[])`: it wants none of its pictures.
///
/// **Called before `notes.attachment_references` takes the new list.** Each
/// merge leaves exactly its list naming the note, so the list still stored
/// bounds the rows to drop it from, and a first sync stays linear: a note not
/// yet in `notes` is named by no row. Only a stored list that went absent
/// leaves rows it cannot name, and those are found by a scan.
///
/// **`None` does nothing** (§14.7). The field is nullable and optional, so a
/// client that does not know about attachments pushes a note without it, and
/// clearing the local list on that would delete a note's pictures from this
/// device because another device stayed quiet. `Some(vec![])` is different and
/// does clear: that sender knows, and says there are none.
pub fn merge_note_references(
    conn: &Connection,
    note_id: &str,
    references: Option<&[String]>,
) -> Result<(), StorageError> {
    let Some(references) = references else {
        // "This sender does not know." Not an empty list, and not a reason to
        // forget what another sender told us.
        return Ok(());
    };

    // A reference the note no longer carries stops pointing at it.
    let stored: Option<Option<String>> = conn
        .prepare_cached("SELECT attachment_references FROM notes WHERE id = ?1")
        .and_then(|mut statement| statement.query_row([note_id], |row| row.get(0)).optional())
        .map_err(failed)?;
    let naming: Vec<String> = match stored {
        None => Vec::new(),
        Some(list) => match list.and_then(|json| serde_json::from_str(&json).ok()) {
            Some(list) => list,
            // `instr` on the id as `write_refs` encodes it narrows the scan.
            None => conn
                .prepare_cached(
                    "SELECT attachment_id FROM attachments WHERE instr(note_refs, ?1) > 0",
                )
                .and_then(|mut statement| {
                    let encoded = serde_json::to_string(note_id).unwrap_or_default();
                    statement
                        .query_map([encoded], |row| row.get(0))?
                        .collect::<Result<_, _>>()
                })
                .map_err(failed)?,
        },
    };
    for attachment_id in naming.iter().filter(|id| !references.contains(id)) {
        let Some(mut refs) = stored_refs(conn, attachment_id)? else {
            continue;
        };
        if !refs.iter().any(|id| id == note_id) {
            continue;
        }
        refs.retain(|id| id != note_id);
        write_refs(conn, attachment_id, &refs)?;
    }

    // A reference to an attachment this device has never fetched still gets a
    // row, so the note can show a placeholder and a later fetch has somewhere
    // to land. An id with no manifest is "known about, not yet pulled".
    for attachment_id in references {
        let Some(mut refs) = stored_refs(conn, attachment_id)? else {
            conn.prepare_cached(
                "INSERT INTO attachments (attachment_id, note_refs) VALUES (?1, ?2)",
            )
            .and_then(|mut statement| {
                statement.execute(rusqlite::params![
                    attachment_id,
                    serde_json::to_string(&[note_id]).unwrap_or_else(|_| "[]".to_owned())
                ])
            })
            .map_err(failed)?;
            continue;
        };
        if refs.iter().any(|id| id == note_id) {
            continue;
        }
        refs.push(note_id.to_owned());
        refs.sort();
        write_refs(conn, attachment_id, &refs)?;
    }
    Ok(())
}

/// One row's `note_refs`, or `None` when the row does not exist.
fn stored_refs(
    conn: &Connection,
    attachment_id: &str,
) -> Result<Option<Vec<String>>, StorageError> {
    conn.prepare_cached("SELECT note_refs FROM attachments WHERE attachment_id = ?1")
        .and_then(|mut statement| {
            statement
                .query_row([attachment_id], |row| row.get::<_, Option<String>>(0))
                .optional()
        })
        .map(|row| row.map(|refs| parse(refs.as_deref())))
        .map_err(failed)
}

/// A row's `note_refs`. A list that will not parse reads as none, as it
/// always has (`attachments::get`).
pub(crate) fn parse(json: Option<&str>) -> Vec<String> {
    json.and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
        .unwrap_or_default()
}

fn write_refs(conn: &Connection, attachment_id: &str, refs: &[String]) -> Result<(), StorageError> {
    conn.prepare_cached("UPDATE attachments SET note_refs = ?2 WHERE attachment_id = ?1")
        .and_then(|mut statement| {
            statement.execute(rusqlite::params![
                attachment_id,
                serde_json::to_string(refs).unwrap_or_else(|_| "[]".to_owned())
            ])
        })
        .map_err(failed)?;
    Ok(())
}
