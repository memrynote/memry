//! Which notes each cached attachment serves: `attachments.note_refs` (N204).
//!
//! `notes.attachment_references` is the owner, what each note's payload says
//! (§14.7). A row's `note_refs` derives from those lists, and
//! [`merge_note_references`] is its one writer (#5675): a pulled page merges
//! the notes it applied once, after its records ([`merge_page`]), a local
//! write that changes a list or deletes a note merges in its own transaction,
//! and [`crate::sync::note_refs_heal`] adds the references of the notes a
//! build before that applied. The re-drive (`attachments::missing_downloads`)
//! walks these rows.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension as _};

use crate::api::errors::StorageError;

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Merges a note's `attachmentReferences` into the cache.
///
/// The one writer of `note_refs`, which derives from the note's list (#5675),
/// so a peer's picture is a row the re-drive sees once its note lands. A
/// deleted note passes `Some(&[])`: it wants none of its pictures.
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
    let stored = conn
        .prepare_cached("SELECT attachment_references FROM notes WHERE id = ?1")
        .and_then(|mut statement| statement.query_row([note_id], |row| row.get(0)).optional())
        .map_err(failed)?;
    let named = naming(conn, note_id, stored)?;
    merge_named(conn, note_id, &named, references)
}

/// The stored lists of a page's notes, read before any record of the page
/// applies. A note this device does not hold yet has no entry.
pub(crate) struct StoredLists(HashMap<String, Option<String>>);

/// Reads [`StoredLists`] for `note_ids` in one statement.
pub(crate) fn stored_lists(
    conn: &Connection,
    note_ids: &[&str],
) -> Result<StoredLists, StorageError> {
    if note_ids.is_empty() {
        return Ok(StoredLists(HashMap::new()));
    }
    let ids = serde_json::to_string(note_ids).unwrap_or_else(|_| "[]".to_owned());
    conn.prepare_cached(
        "SELECT id, attachment_references FROM notes
         WHERE id IN (SELECT value FROM json_each(?1))",
    )
    .and_then(|mut statement| {
        statement
            .query_map([ids], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()
    })
    .map(StoredLists)
    .map_err(failed)
}

/// Merges the lists the page's applied notes now carry, after its last record.
///
/// Each record applies in its own savepoint, and two attachment pages written
/// there spill the savepoint journal to a temp file for the rest of the page
/// (#5675). Here the rows are written once per page, in the page's
/// transaction. The lists are read as the page left them, so a record that was
/// skipped or rolled back changes no row. `before` bounds the rows to drop
/// each note from, as the stored list does in [`merge_note_references`].
pub(crate) fn merge_page(
    conn: &Connection,
    before: &StoredLists,
    applied: &[String],
) -> Result<(), StorageError> {
    if applied.is_empty() {
        return Ok(());
    }
    let ids = serde_json::to_string(applied).unwrap_or_else(|_| "[]".to_owned());
    let after: Vec<(String, Option<String>, Option<i64>)> = conn
        .prepare_cached(
            "SELECT id, attachment_references, deleted_at FROM notes
             WHERE id IN (SELECT value FROM json_each(?1))",
        )
        .and_then(|mut statement| {
            statement
                .query_map([ids], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<Result<_, _>>()
        })
        .map_err(failed)?;
    for (note_id, list, deleted_at) in after {
        // The projector writes a list it read as a string array, and NULL for
        // one the sender left out: "does not know" leaves the rows alone.
        let references = match deleted_at {
            Some(_) => Vec::new(),
            None => match list.and_then(|json| serde_json::from_str(&json).ok()) {
                Some(references) => references,
                None => continue,
            },
        };
        let named = naming(conn, &note_id, before.0.get(&note_id).cloned())?;
        merge_named(conn, &note_id, &named, &references)?;
    }
    Ok(())
}

/// Drops `note_id` from the `named` rows `references` no longer lists, then
/// adds it to each of `references`.
fn merge_named(
    conn: &Connection,
    note_id: &str,
    named: &[String],
    references: &[String],
) -> Result<(), StorageError> {
    // A reference the note no longer carries stops pointing at it.
    for attachment_id in named.iter().filter(|id| !references.contains(id)) {
        let Some(mut refs) = stored_refs(conn, attachment_id)? else {
            continue;
        };
        let before = refs.len();
        refs.retain(|id| id != note_id);
        if refs.len() != before {
            write_refs(conn, attachment_id, &refs)?;
        }
    }

    for attachment_id in references {
        add_reference(conn, attachment_id, note_id)?;
    }
    Ok(())
}

/// The rows that may name `note_id`, from its `stored` list: that list, or a
/// scan when it is absent. A note not yet in `notes` (`None`) is named by none.
fn naming(
    conn: &Connection,
    note_id: &str,
    stored: Option<Option<String>>,
) -> Result<Vec<String>, StorageError> {
    match stored {
        None => Ok(Vec::new()),
        Some(list) => match list.and_then(|json| serde_json::from_str(&json).ok()) {
            Some(list) => Ok(list),
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
                .map_err(failed),
        },
    }
}

/// Makes `attachment_id`'s row name `note_id`. Idempotent.
///
/// A reference to an attachment this device has never fetched still gets a
/// row, so the note can show a placeholder and a later fetch has somewhere to
/// land. An id with no manifest is "known about, not yet pulled". That insert
/// is the one statement a first sync spends per reference; only a row that
/// already exists is read.
pub(crate) fn add_reference(
    conn: &Connection,
    attachment_id: &str,
    note_id: &str,
) -> Result<(), StorageError> {
    let inserted = conn
        .prepare_cached(
            "INSERT INTO attachments (attachment_id, note_refs) VALUES (?1, ?2)
             ON CONFLICT(attachment_id) DO NOTHING",
        )
        .and_then(|mut statement| {
            statement.execute(rusqlite::params![
                attachment_id,
                serde_json::to_string(&[note_id]).unwrap_or_else(|_| "[]".to_owned())
            ])
        })
        .map_err(failed)?;
    if inserted > 0 {
        return Ok(());
    }
    let mut refs = stored_refs(conn, attachment_id)?.unwrap_or_default();
    if refs.iter().any(|id| id == note_id) {
        return Ok(());
    }
    refs.push(note_id.to_owned());
    refs.sort();
    write_refs(conn, attachment_id, &refs)
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
