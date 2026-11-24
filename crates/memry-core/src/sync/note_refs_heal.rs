//! The one-time attachment row backfill (#5675).
//!
//! Before #5675 applying a note wrote `notes.attachment_references` and no
//! cache row, so the re-drive never fetched a peer's picture and no block
//! could bind it. A note applied since then gets its rows in the projecting
//! transaction. This merges every live note's stored list once, under
//! [`META_NOTE_REFS_HEAL`], so a device that applied its notes on an older
//! build gets the rows it never wrote. Merging a list already merged changes
//! nothing, so a run is safe to repeat.

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::domain::attachment_refs;
use crate::storage::nested_tx;

use super::first_sync_store::{read_meta, write_meta};

/// Absent until every live note's references have been merged once.
pub const META_NOTE_REFS_HEAL: &str = "sync.note_refs_heal";

/// Merges each live note's `attachment_references` into the cache, once per
/// install. Answers how many notes it merged.
pub fn merge_applied_notes(conn: &Connection) -> Result<usize, StorageError> {
    if read_meta(conn, META_NOTE_REFS_HEAL)?.is_some() {
        return Ok(0);
    }
    let txn = nested_tx::begin(conn).map_err(failed)?;
    let notes: Vec<(String, String)> = txn
        .prepare(
            "SELECT id, attachment_references FROM notes \
             WHERE deleted_at IS NULL AND attachment_references IS NOT NULL",
        )
        .map_err(failed)?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    for (note_id, references) in &notes {
        // The projector wrote this column from a validated string array, so a
        // list that will not parse is not one: leave it as unknown.
        let references = serde_json::from_str::<Vec<String>>(references).ok();
        attachment_refs::merge_note_references(&txn, note_id, references.as_deref())?;
    }
    write_meta(&txn, META_NOTE_REFS_HEAL, "done")?;
    txn.commit().map_err(failed)?;
    Ok(notes.len())
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
