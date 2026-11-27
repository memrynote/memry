//! A binary note's own file (#5668, chapter 14 §14.7.3).
//!
//! A PDF, image, audio or video note has no CRDT body (§13.7.1): its content
//! is one attachment the `note` record names by `attachmentId`, not by
//! `attachmentReferences`. The bytes follow chapter 14's chain like any
//! attachment and land at `images/<attachment_id>`, so a peer replacement,
//! which mints a new attachment id (#5626), lands beside the old bytes rather
//! than over them.

use rusqlite::{Connection, OptionalExtension as _};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::attachments::{self, CachedAttachment};
use crate::domain::notes;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::storage::repositories::{Change, StoredPayload};

/// The keys that make a note a file, as desktop's `binaryRecordFields` pushes
/// them beside `attachmentId`.
const FILE_KEYS: [&str; 3] = ["attachmentId", "fileType", "mimeType"];

/// What a shell needs to open a binary note.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NoteFile {
    /// The payload's `fileType`, as stored: `pdf`, `image`, `audio` or `video`.
    pub file_type: String,
    pub mime_type: Option<String>,
    pub attachment_id: String,
    /// The cache row, `None` until a manifest or a download writes one. Its
    /// `local_path` is set once the bytes are on disk.
    pub attachment: Option<CachedAttachment>,
}

/// One live note's own file, or `None` when the note names no attachment.
///
/// Keyed on `attachmentId` alone, as desktop's pull and restore are
/// (`note-handler.ts:750`, `binary-note-restore.ts:139`): only a binary note
/// carries one, and whatever names a file gets its file.
pub fn for_note(conn: &Connection, note_id: &str) -> Result<Option<NoteFile>, StorageError> {
    let row = conn
        .query_row(
            "SELECT COALESCE(file_type, 'markdown'), mime_type, attachment_id FROM notes \
             WHERE id = ?1 AND deleted_at IS NULL \
               AND attachment_id IS NOT NULL AND attachment_id != ''",
            rusqlite::params![note_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })?;
    let Some((file_type, mime_type, attachment_id)) = row else {
        return Ok(None);
    };
    Ok(Some(NoteFile {
        file_type,
        mime_type,
        attachment: attachments::get(conn, &attachment_id)?,
        attachment_id,
    }))
}

/// An inbound `note` record that names no file, with this device's file keys
/// laid back over it, or `None` to apply the record as it came.
///
/// Shipped desktops pushed a markdown record with no attachment for a binary
/// note whose row their write-back had retyped (#5419). Desktop's pull keeps
/// its own file over such a record (`note-handler.ts:288`, `:387`). Applied as
/// sent, it would clear `notes.attachment_id`, and the note would open as an
/// empty body with its file no longer downloaded. A record that names another
/// id is a peer replacement (#5626) and applies as sent.
pub(crate) fn keep_own_file(
    conn: &Connection,
    record: &InboundRecord,
) -> Result<Option<InboundRecord>, StorageError> {
    if record.item_type != notes::ITEM_TYPE || record.deleted_at.is_some() {
        return Ok(None);
    }
    let Ok(remote) = StoredPayload::parse(&record.payload_json) else {
        return Ok(None);
    };
    if names_file(remote.object()) {
        return Ok(None);
    }
    let Some(row) = sync_items::load(conn, &record.item_type, &record.item_id)? else {
        return Ok(None);
    };
    let local = match (row.deleted_at, row.payload.as_deref()) {
        (None, Some(raw)) => StoredPayload::parse(raw).ok(),
        _ => None,
    };
    let Some(local) = local.filter(|local| names_file(local.object())) else {
        return Ok(None);
    };
    let kept = FILE_KEYS.map(|key| {
        let value = local.object().get(key).cloned();
        (key, value.map_or(Change::Remove, Change::Set))
    });
    Ok(Some(InboundRecord {
        payload_json: remote.merge(&kept),
        ..record.clone()
    }))
}

fn names_file(payload: &Object) -> bool {
    payload
        .get("attachmentId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty())
}
