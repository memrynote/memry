//! Split from `notes.rs` along its existing seams; see `mod.rs`.

#[allow(unused_imports)]
use super::*;

/// Adds an attachment id to a note's `attachmentReferences` (§14.7).
///
/// **A union, never a replace.** A note can embed several attachments and each
/// upload lands separately, so replacing the list drops every id but the last
/// — which is the bug desktop's own `recordUploadedAttachment` carries a
/// comment about. It is also what §13.4 asks for on a field whose absence
/// means "this sender does not know": a merge cannot lose what another device
/// knew and this one did not.
///
/// Returns without writing when the id is already there, so a retried upload
/// does not enqueue a second push of an unchanged note.
pub fn add_attachment_reference(
    conn: &Connection,
    note_id: &str,
    attachment_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<Durable<String>>, StorageError> {
    let existing: Vec<String> = read_attachment_references(conn, note_id)?;
    if existing.iter().any(|id| id == attachment_id) {
        return Ok(None);
    }
    let mut merged = existing;
    merged.push(attachment_id.to_owned());
    Ok(Some(edit(
        conn,
        ITEM_TYPE,
        note_id,
        vec![(
            "attachmentReferences",
            Change::Set(Value::Array(
                merged.into_iter().map(Value::String).collect(),
            )),
        )],
        device_id,
        now_ms,
    )?))
}

/// Removes an attachment id from a note's `attachmentReferences`.
///
/// The one place a **positive** removal is correct: the user deleted the
/// picture, so this device has evidence of absence rather than silence. That
/// is what makes it different from an absent key, which must never prune.
pub fn remove_attachment_reference(
    conn: &Connection,
    note_id: &str,
    attachment_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<Durable<String>>, StorageError> {
    let existing = read_attachment_references(conn, note_id)?;
    if !existing.iter().any(|id| id == attachment_id) {
        return Ok(None);
    }
    let remaining: Vec<Value> = existing
        .into_iter()
        .filter(|id| id != attachment_id)
        .map(Value::String)
        .collect();
    Ok(Some(edit(
        conn,
        ITEM_TYPE,
        note_id,
        vec![("attachmentReferences", Change::Set(Value::Array(remaining)))],
        device_id,
        now_ms,
    )?))
}

/// The note's current reference list, or empty when the column is null.
///
/// Empty here means "this row carries none", which is the local fact. It is
/// **not** the protocol's "the sender does not know" — that distinction lives
/// on the wire, and §14.7 keeps it there.
pub fn read_attachment_references(
    conn: &Connection,
    note_id: &str,
) -> Result<Vec<String>, StorageError> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT attachment_references FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            params![note_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })?
        .flatten();
    Ok(raw
        .as_deref()
        .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
        .unwrap_or_default())
}
