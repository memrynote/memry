//! A note or journal as the search indexes read it: whether it is live, its
//! title, and its body text. FTS (`maintenance`) and the semantic embedder
//! both read through here, so the two never disagree on what a note says.

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::storage::repositories::StoredPayload;
use crate::storage::repositories::projectors::{self, strings, text};
use crate::storage::repositories::schema::Object;

use super::body_cache::body_text;
use super::failed;

/// One note or journal row, as far as indexing cares.
pub(crate) enum NoteRow {
    /// No row, or a tombstone.
    Absent,
    /// The apply path flagged it corrupt.
    Corrupt,
    /// `metadata-only`: the record's body has not been pulled yet.
    NotPulled,
    Live {
        title: String,
        tags: Vec<String>,
    },
}

pub(crate) fn note_row(data: &Connection, id: &str) -> Result<NoteRow, StorageError> {
    // The primary key is (item_type, item_id), so one id could in principle
    // name both a note and a journal. `journal` sorts first and one row is
    // indexed; the ambiguity is not this module's to resolve.
    let row = data
        .query_row(
            "SELECT item_type, payload, deleted_at, corrupt_reason FROM sync_items
             WHERE item_id = ?1 AND item_type IN ('note', 'journal')
             ORDER BY item_type LIMIT 1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(failed)?;
    Ok(match row {
        None | Some((_, _, Some(_), _)) => NoteRow::Absent,
        Some((_, _, None, Some(_))) => NoteRow::Corrupt,
        Some((_, None, None, None)) => NoteRow::NotPulled,
        Some((item_type, Some(payload), None, None)) => {
            let view = read_payload(&item_type, id, &payload)?;
            NoteRow::Live {
                title: title(&view),
                tags: strings(&view, "tags"),
            }
        }
    })
}

/// A live note's title and body text, the body read through the `note_bodies`
/// cache. `None` unless the note is live.
pub(crate) fn note_text(
    data: &Connection,
    id: &str,
    now_ms: i64,
) -> Result<Option<(String, String)>, StorageError> {
    let NoteRow::Live { title, .. } = note_row(data, id)? else {
        return Ok(None);
    };
    Ok(Some((title, body_text(data, id, now_ms)?)))
}

/// A live note as the embedder plans it: its title and the sha256 of its
/// cached body text, `None` when no body has been cached yet.
pub(crate) struct LiveNote {
    pub(crate) note_id: String,
    pub(crate) title: String,
    pub(crate) text_sha256: Option<[u8; 32]>,
}

/// Every live note and journal, one per id, ordered by id.
pub(crate) fn live_notes(data: &Connection) -> Result<Vec<LiveNote>, StorageError> {
    let mut statement = data
        .prepare(
            "SELECT s.item_id, s.item_type, s.payload, b.text_sha256
             FROM sync_items s LEFT JOIN note_bodies b ON b.note_id = s.item_id
             WHERE s.item_type IN ('note', 'journal') AND s.deleted_at IS NULL
               AND s.corrupt_reason IS NULL AND s.payload IS NOT NULL
             ORDER BY s.item_id, s.item_type",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(failed)?;
    let mut notes: Vec<LiveNote> = Vec::new();
    for row in rows {
        let (note_id, item_type, payload, sha) = row.map_err(failed)?;
        if notes.last().is_some_and(|last| last.note_id == note_id) {
            continue;
        }
        let view = read_payload(&item_type, &note_id, &payload)?;
        notes.push(LiveNote {
            title: title(&view),
            text_sha256: sha.and_then(|sha| hex::decode(sha).ok()?.try_into().ok()),
            note_id,
        });
    }
    Ok(notes)
}

/// A journal's title is not projected anywhere, so it is read from the
/// payload like every other field here, and falls back to its calendar date.
fn title(view: &Object) -> String {
    text(view, "title")
        .filter(|title| !title.is_empty())
        .or_else(|| text(view, "date"))
        .unwrap_or_default()
}

/// The stored payload, read through the same reader the projectors use.
///
/// A row the apply path did not flag corrupt but that will not read back is a
/// bug in this build, and it stops the pass instead of quietly leaving a note
/// out of every search result for the life of the install.
pub(super) fn read_payload(
    item_type: &str,
    item_id: &str,
    payload: &str,
) -> Result<Object, StorageError> {
    let parsed = StoredPayload::parse(payload).map_err(|error| StorageError::Failed {
        what: format!("{item_type}/{item_id} will not parse for indexing: {error}"),
    })?;
    projectors::read(item_type, parsed.object()).map_err(|error| StorageError::Failed {
        what: format!("{item_type}/{item_id} will not read for indexing: {error}"),
    })
}
