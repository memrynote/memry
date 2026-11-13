//! An Inbox capture's file between devices (#4157, chapter 14 §14.7.2).
//!
//! A capture with a file is marked **upload pending** in the capture's own
//! transaction, so the mark is durable before the shell is acknowledged. The
//! sync pass (`VaultSync::sync_inbox_attachments`) uploads pending files,
//! writes the resulting `attachmentId` into the capture through the ordinary
//! local edit (clock bump and outbox row), and clears the mark. Only a capture
//! made by a build that has the `inbox_attachment_uploads` table has a mark, so
//! captures from before it never upload.
//!
//! A permanent delete of an unfiled capture that has an id leaves a release
//! row. Thirty days later the pass dereferences the file's chunks unless a live
//! note references the id (filing reuses the upload, so the note then owns the
//! bytes), the same grace as desktop's deleted-asset release (§14.8).
//!
//! This module decides; it does no I/O beyond SQLite. The file reads, the
//! network and the clock live with the caller.

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::storage::repositories::Change;

use super::write::edit;
use super::{COLUMNS, InboxItem, select_items};

/// §14.8's grace before a deleted capture's chunks are dereferenced
/// (desktop's `ASSET_RELEASE_GRACE_MS`).
pub const RELEASE_GRACE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

const CAPTURE_DIR: &str = "attachments/inbox/";

/// The file name of `path` when it is exactly
/// `attachments/inbox/<item_id>/<file>` with plain segments, else `None`.
///
/// A receiver writes downloaded bytes here and the sender reads its own file
/// from here, so a path that names anything else is refused rather than
/// followed (§14.7.2, as §14.7.1 refuses a cover `ref` outside its folder).
pub fn capture_file_name<'a>(item_id: &str, path: &'a str) -> Option<&'a str> {
    let (dir, file) = path.strip_prefix(CAPTURE_DIR)?.split_once('/')?;
    (dir == item_id && is_plain(dir) && is_plain(file)).then_some(file)
}

fn is_plain(segment: &str) -> bool {
    !segment.is_empty() && segment != "." && segment != ".." && !segment.contains(['/', '\\', '\0'])
}

/// What to upload for one pending capture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadTarget {
    pub path: String,
    pub filename: String,
    pub mime_type: String,
}

/// What the pass does with one pending mark.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadPlan {
    Upload(UploadTarget),
    /// Clear the mark without an id: the capture is gone, filed, already has
    /// an id, or its path is not one the pass will read.
    Drop,
}

/// What to do with a capture's upload mark: upload an unfiled capture that has
/// no id and a path the pass will read, drop the mark otherwise.
pub fn plan_upload(item: Option<&InboxItem>) -> UploadPlan {
    let Some(item) = item else {
        return UploadPlan::Drop;
    };
    let target = item
        .attachment_path
        .as_deref()
        .and_then(|path| Some((path, capture_file_name(&item.id, path)?)));
    match target {
        Some((path, filename)) if item.filed_at.is_none() && item.attachment_id.is_none() => {
            UploadPlan::Upload(UploadTarget {
                path: path.to_owned(),
                filename: filename.to_owned(),
                mime_type: mime_type(item),
            })
        }
        _ => UploadPlan::Drop,
    }
}

/// `metadata.mimeType` (a file capture), else the voice memo's `format`.
fn mime_type(item: &InboxItem) -> String {
    if let Some(mime) = item.metadata_text("mimeType") {
        return mime.to_owned();
    }
    match item.metadata_text("format") {
        Some("m4a" | "mp4") => "audio/mp4",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("aac") => "audio/aac",
        Some("caf") => "audio/x-caf",
        _ => "application/octet-stream",
    }
    .to_owned()
}

/// The id and path of a capture whose file this device should download, when
/// the file is not on disk: unfiled, with an id and a path the pass will write.
/// A filed capture's bytes belong to its note.
pub fn download_target(item: &InboxItem) -> Option<(&str, &str)> {
    let id = item.attachment_id.as_deref().filter(|id| !id.is_empty())?;
    let path = item.attachment_path.as_deref()?;
    capture_file_name(&item.id, path)?;
    item.filed_at.is_none().then_some((id, path))
}

/// Unfiled captures that name an upload: the candidates for a download.
pub fn unfiled_with_upload(conn: &Connection) -> Result<Vec<InboxItem>, StorageError> {
    select_items(
        conn,
        &format!(
            "SELECT {COLUMNS} FROM inbox_view
              WHERE deleted_at IS NULL AND filed_at IS NULL AND attachment_id IS NOT NULL
              ORDER BY created_at DESC, id"
        ),
        &[],
    )
}

/// Marks a capture's file as waiting for upload, inside the capture's
/// transaction.
pub(crate) fn mark_pending(
    tx: &Connection,
    item_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    tx.execute(
        "INSERT OR IGNORE INTO inbox_attachment_uploads (item_id, created_at) VALUES (?1, ?2)",
        params![item_id, now_ms],
    )
    .map_err(failed)?;
    Ok(())
}

pub fn clear_pending(conn: &Connection, item_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM inbox_attachment_uploads WHERE item_id = ?1",
        params![item_id],
    )
    .map_err(failed)?;
    Ok(())
}

/// Captures waiting for upload, oldest first.
pub fn pending_ids(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare("SELECT item_id FROM inbox_attachment_uploads ORDER BY created_at, item_id")
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(failed)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(failed)
}

/// Writes the upload's id into the capture: a normal local edit, so the clock
/// ticks and the capture is pushed with its `attachmentId`.
pub fn set_attachment_id(
    conn: &Connection,
    item_id: &str,
    attachment_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    edit(
        conn,
        item_id,
        vec![("attachmentId", Change::Set(Value::from(attachment_id)))],
        device_id,
        now_ms,
    )?
    .acknowledge();
    Ok(())
}

/// A permanent delete, inside its transaction: the mark goes, and an unfiled
/// capture's uploaded file is recorded for release.
pub(crate) fn forget_deleted(
    tx: &Connection,
    item: &InboxItem,
    now_ms: i64,
) -> Result<(), StorageError> {
    clear_pending(tx, &item.id)?;
    if let (None, Some(attachment_id)) = (item.filed_at, item.attachment_id.as_deref()) {
        tx.execute(
            "INSERT OR REPLACE INTO inbox_attachment_releases (item_id, attachment_id, deleted_at)
             VALUES (?1, ?2, ?3)",
            params![item.id, attachment_id, now_ms],
        )
        .map_err(failed)?;
    }
    Ok(())
}

/// A deleted capture's uploaded file, past its grace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub item_id: String,
    pub attachment_id: String,
}

pub fn due_releases(conn: &Connection, now_ms: i64) -> Result<Vec<Release>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT item_id, attachment_id FROM inbox_attachment_releases
              WHERE deleted_at <= ?1 ORDER BY deleted_at, item_id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![now_ms - RELEASE_GRACE_MS], |row| {
            Ok(Release {
                item_id: row.get(0)?,
                attachment_id: row.get(1)?,
            })
        })
        .map_err(failed)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(failed)
}

pub fn drop_release(conn: &Connection, item_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM inbox_attachment_releases WHERE item_id = ?1",
        params![item_id],
    )
    .map_err(failed)?;
    Ok(())
}

/// Whether a live note lists `attachment_id`: filing reuses a capture's upload,
/// and the note then owns the bytes.
pub fn referenced_by_live_note(
    conn: &Connection,
    attachment_id: &str,
) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS (
           SELECT 1 FROM notes n,
                json_each(CASE WHEN json_valid(n.attachment_references)
                               THEN n.attachment_references ELSE '[]' END) j
            WHERE n.deleted_at IS NULL AND j.value = ?1)",
        params![attachment_id],
        |row| row.get::<_, bool>(0),
    )
    .map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_captures_own_folder_and_a_plain_name_are_a_capture_file() {
        let ok = "attachments/inbox/abc/photo.png";
        assert_eq!(capture_file_name("abc", ok), Some("photo.png"));
        for bad in [
            "attachments/inbox/other/photo.png",
            "attachments/inbox/abc/../photo.png",
            "attachments/inbox/abc/..",
            "attachments/inbox/abc/.",
            "attachments/inbox/abc/",
            "attachments/inbox/abc/a/b.png",
            "attachments/inbox/abc/a\\b.png",
            "attachments/inbox/abc",
            "attachments/abc/photo.png",
            "/attachments/inbox/abc/photo.png",
            "../attachments/inbox/abc/photo.png",
            "attachments/inbox//photo.png",
        ] {
            assert_eq!(capture_file_name("abc", bad), None, "{bad}");
        }
        assert_eq!(capture_file_name("..", "attachments/inbox/../x"), None);
    }
}
