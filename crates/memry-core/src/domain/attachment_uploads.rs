//! A note's attachment that waits on this device for its upload (#5510, §14.7).
//!
//! Attaching keeps the bytes first and uploads second, so a phone without a
//! network still gets its picture. [`queue`] runs before the shell inserts the
//! block: the bytes are already under `images/<attachment_id>`, and one
//! transaction writes the `attachments` row that binds the block and the
//! `note_attachment_uploads` row that owes the upload. A relaunch keeps both.
//!
//! The upload reuses the attachment id minted here, so a retry never mints a
//! second one, and the note's `attachmentReferences` gains the id only once the
//! manifest is stored (see `VaultSync::upload_attachment`). Until then the row
//! binds this note's block through [`crate::domain::attachments::for_note`]
//! alone, and no other device hears of it.
//!
//! This module decides; it does no I/O beyond SQLite.

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;

/// One attachment owed an upload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingUpload {
    pub attachment_id: String,
    pub note_id: String,
    pub filename: String,
    pub mime_type: String,
    /// Relative to `images/`.
    pub local_path: String,
}

/// Records an attachment whose bytes are on disk at `local_path` and owes its
/// upload, in one transaction.
pub fn queue(conn: &Connection, upload: &PendingUpload, now_ms: i64) -> Result<(), StorageError> {
    let tx = crate::storage::nested_tx::begin(conn).map_err(failed)?;
    tx.execute(
        "INSERT INTO attachments \
           (attachment_id, filename, mime_type, local_path, downloaded_at, note_refs) \
         VALUES (?1, ?2, ?3, ?4, ?5, '[]')",
        params![
            upload.attachment_id,
            upload.filename,
            upload.mime_type,
            upload.local_path,
            now_ms
        ],
    )
    .map_err(failed)?;
    tx.execute(
        "INSERT INTO note_attachment_uploads (attachment_id, note_id, created_at) \
         VALUES (?1, ?2, ?3)",
        params![upload.attachment_id, upload.note_id, now_ms],
    )
    .map_err(failed)?;
    tx.commit().map_err(failed)
}

const SELECT: &str = "SELECT u.attachment_id, u.note_id, a.filename, a.mime_type, a.local_path \
                      FROM note_attachment_uploads u \
                      JOIN attachments a ON a.attachment_id = u.attachment_id";

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PendingUpload> {
    Ok(PendingUpload {
        attachment_id: row.get(0)?,
        note_id: row.get(1)?,
        filename: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        mime_type: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        local_path: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
    })
}

/// One pending upload, or `None` once it is uploaded or dropped.
pub fn get(conn: &Connection, attachment_id: &str) -> Result<Option<PendingUpload>, StorageError> {
    conn.query_row(
        &format!("{SELECT} WHERE u.attachment_id = ?1"),
        params![attachment_id],
        read_row,
    )
    .optional()
    .map_err(failed)
}

/// Every pending upload's id, oldest first.
pub fn pending_ids(conn: &Connection) -> Result<Vec<String>, StorageError> {
    conn.prepare(
        "SELECT attachment_id FROM note_attachment_uploads ORDER BY created_at, attachment_id",
    )
    .map_err(failed)?
    .query_map([], |row| row.get::<_, String>(0))
    .map_err(failed)?
    .collect::<Result<Vec<_>, _>>()
    .map_err(failed)
}

/// The ids still waiting for one note.
pub fn ids_for_note(conn: &Connection, note_id: &str) -> Result<Vec<String>, StorageError> {
    conn.prepare("SELECT attachment_id FROM note_attachment_uploads WHERE note_id = ?1")
        .map_err(failed)?
        .query_map(params![note_id], |row| row.get::<_, String>(0))
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)
}

/// Whether the note is live here. A deleted note's upload waits rather than
/// spends quota, and runs if the note comes back.
pub fn note_is_live(conn: &Connection, note_id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NULL)",
        params![note_id],
        |row| row.get(0),
    )
    .map_err(failed)
}

/// The note's title, empty when it has none, so a refusal can name it.
pub fn note_title(conn: &Connection, note_id: &str) -> Result<String, StorageError> {
    conn.query_row(
        "SELECT title FROM notes WHERE id = ?1",
        params![note_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|title| title.flatten().unwrap_or_default())
    .map_err(failed)
}

/// Compat: the `meta` key under which #5573 and #5604 builds dated the purge
/// of an owed upload's note. A #5573 build discards the upload 30 days after
/// that date, so this build writes none: a downgrade keeps the only copy of
/// the bytes (#5578). Nothing reads it; a key an older build left goes with
/// its upload.
const PURGED_KEY: &str = "attachment_upload.purged_at:";

fn forget_purge(conn: &Connection, attachment_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM meta WHERE key = ?1",
        params![format!("{PURGED_KEY}{attachment_id}")],
    )
    .map_err(failed)?;
    Ok(())
}

/// Where an upload's chunk addresses wait in `meta` until a reference names
/// them (#5533). No migration: `meta` is the baseline key-value table, and an
/// older build ignores the key.
const CHUNKS_KEY: &str = "attachment_upload.chunks:";

/// Records the chunks an upload is about to put. The server counts each one
/// from its put (§14.8), and a crash before the reference would otherwise
/// leave them named by nothing on this device.
pub fn record_chunks(
    conn: &Connection,
    attachment_id: &str,
    hashes: &[String],
) -> Result<(), StorageError> {
    let value = serde_json::to_string(hashes).map_err(|error| StorageError::Failed {
        what: error.to_string(),
    })?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![format!("{CHUNKS_KEY}{attachment_id}"), value],
    )
    .map_err(failed)?;
    Ok(())
}

/// Every recorded chunk set, by attachment id, or `only`'s. A set that will
/// not parse is logged and skipped, so it never blocks another upload; its
/// chunks cannot be named, so their quota stays held.
pub fn recorded_chunks(
    conn: &Connection,
    only: Option<&str>,
) -> Result<Vec<(String, Vec<String>)>, StorageError> {
    let rows = conn
        .prepare(
            "SELECT substr(key, ?1), value FROM meta \
             WHERE substr(key, 1, ?2) = ?3 AND (?4 IS NULL OR key = ?3 || ?4)",
        )
        .map_err(failed)?
        .query_map(
            params![
                CHUNKS_KEY.len() as i64 + 1,
                CHUNKS_KEY.len() as i64,
                CHUNKS_KEY,
                only
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, value)| match serde_json::from_str(&value) {
            Ok(hashes) => Some((id, hashes)),
            Err(error) => {
                eprintln!(
                    "memry-core: attachment uploads: the recorded chunks of {id} do not parse, skipped: {error}"
                );
                None
            }
        })
        .collect())
}

/// The recorded chunks are referenced or released.
pub fn forget_chunks(conn: &Connection, attachment_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM meta WHERE key = ?1",
        params![format!("{CHUNKS_KEY}{attachment_id}")],
    )
    .map_err(failed)?;
    Ok(())
}

/// The upload is no longer owed: it landed, the server refused it for good,
/// or the user detached the picture. The `attachments` row and the bytes stay.
pub fn clear(conn: &Connection, attachment_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM note_attachment_uploads WHERE attachment_id = ?1",
        params![attachment_id],
    )
    .map_err(failed)?;
    forget_refusal(conn, attachment_id)?;
    forget_purge(conn, attachment_id)
}

/// The `meta` key holding the refusal status the shell was last told about
/// for one owed upload (#5532). A `meta` row rather than a table: the core's
/// numbered migrations stay frozen until the Tauri branch merges. An older
/// build never reads the key; a row it leaves behind once its upload lands
/// names a random id that no new attach reuses, so it is never read again.
fn refusal_key(attachment_id: &str) -> String {
    format!("attachment_upload.refusal_seen:{attachment_id}")
}

/// The refusal status the shell was last told about for this upload.
pub fn told_refusal(conn: &Connection, attachment_id: &str) -> Result<Option<u16>, StorageError> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![refusal_key(attachment_id)],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(stored.and_then(|status| status.parse().ok()))
}

/// Records that the shell was told the upload was refused with `status`.
/// An upload no longer owed records nothing.
pub fn remember_refusal(
    conn: &Connection,
    attachment_id: &str,
    status: u16,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO meta (key, value) \
         SELECT ?1, ?2 WHERE EXISTS \
           (SELECT 1 FROM note_attachment_uploads WHERE attachment_id = ?3) \
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![
            refusal_key(attachment_id),
            status.to_string(),
            attachment_id
        ],
    )
    .map_err(failed)?;
    Ok(())
}

fn forget_refusal(conn: &Connection, attachment_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM meta WHERE key = ?1",
        params![refusal_key(attachment_id)],
    )
    .map_err(failed)?;
    Ok(())
}

/// Takes back an attach the server refused at once, where no block was
/// inserted: nothing may keep the row.
pub fn discard(conn: &Connection, attachment_id: &str) -> Result<(), StorageError> {
    let tx = crate::storage::nested_tx::begin(conn).map_err(failed)?;
    tx.execute(
        "DELETE FROM note_attachment_uploads WHERE attachment_id = ?1",
        params![attachment_id],
    )
    .map_err(failed)?;
    tx.execute(
        "DELETE FROM attachments WHERE attachment_id = ?1",
        params![attachment_id],
    )
    .map_err(failed)?;
    forget_refusal(&tx, attachment_id)?;
    forget_purge(&tx, attachment_id)?;
    tx.commit().map_err(failed)
}
