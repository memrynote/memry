//! A binary note's own file (#5668, chapter 14 §14.7.3).
//!
//! A PDF, image, audio or video note has no CRDT body (§13.7.1): its content
//! is one attachment the `note` record names by `attachmentId`, not by
//! `attachmentReferences`. The bytes follow chapter 14's chain like any
//! attachment and land at `images/<attachment_id>`, so a peer replacement,
//! which mints a new attachment id (#5626), lands beside the old bytes rather
//! than over them.

use rusqlite::{Connection, OptionalExtension as _};

use crate::api::errors::StorageError;
use crate::domain::attachments::{self, CachedAttachment};

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
