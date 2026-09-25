//! Inbox writes that change one capture (spec 006 IB020, IB022-IB024):
//! capture, edit, snooze, archive, delete, mark filed.
//!
//! Every write is one transaction with its outbox row ([`outbox::commit`]),
//! ticks the document clock and stamps `modifiedAt`, as desktop's
//! `syncInboxCreate` / `syncInboxUpdate` do. The payload is desktop's shape: a
//! new capture carries **every** column desktop's row has (its push is
//! `JSON.stringify(row)`), unset ones as explicit `null`; an edit merges into
//! the stored payload, so a key this build does not model survives, and a
//! clear is an explicit `null` (unsnooze, unarchive, unfile).
//!
//! `title` and `type` are never written `null`: `InboxSyncPayloadSchema`
//! declares them `z.string().optional()` and desktop drops such a payload
//! whole.

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::crypto::sodium;
use crate::domain::notes::{insert_local, iso, next_clock, object, require_payload};
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox::{self, Durable};

use super::{ITEM_TYPE, InboxItem, queries, urls};

// The state and enrichment writes live beside this module (600-line ceiling)
// and are reached through it, so callers name one module.
pub use super::enrich::*;
pub use super::states::*;

/// Desktop's `MAX_INBOX_FILE_SIZE`: 50 MB, every type.
pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// Desktop's MIME allow-lists (`attachments.ts`), grouped by the capture type
/// each one becomes (`getInboxTypeFromMime`).
const IMAGE_TYPES: [&str; 5] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
];
const AUDIO_TYPES: [&str; 9] = [
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/ogg",
    "audio/mp4",
    "audio/x-m4a",
    "audio/flac",
    "audio/aac",
    "audio/webm",
];
const VIDEO_TYPES: [&str; 5] = [
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-msvideo",
    "video/x-matroska",
];

/// `getInboxTypeFromMime`, refusing what desktop's store refuses.
pub fn type_for_mime(mime: &str) -> Option<&'static str> {
    if IMAGE_TYPES.contains(&mime) {
        Some("image")
    } else if AUDIO_TYPES.contains(&mime) {
        Some("voice")
    } else if VIDEO_TYPES.contains(&mime) {
        Some("video")
    } else if mime == "application/pdf" {
        Some("pdf")
    } else {
        None
    }
}

/// `nanoid()` (desktop's `generateId`).
pub fn mint_id() -> String {
    const ALPHABET: &[u8; 64] = b"useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
    sodium::random_bytes(21)
        .into_iter()
        .map(|byte| char::from(ALPHABET[usize::from(byte & 63)]))
        .collect()
}

/// What a new capture carries. Unset fields are written as explicit `null`.
#[derive(Debug, Clone, Default)]
pub struct NewCapture {
    /// `None` mints one; the shell passes its own when it stored a file under
    /// `attachments/inbox/{id}/` first.
    pub id: Option<String>,
    pub item_type: String,
    pub title: String,
    pub content: Option<String>,
    pub metadata: Option<Value>,
    pub source_url: Option<String>,
    pub source_title: Option<String>,
    /// `inline` for the in-app composer, `quick-capture` for the Share
    /// extension (spec 006 §6).
    pub capture_source: Option<String>,
    /// `complete` unless enrichment is still to run (`pending`).
    pub processing_status: String,
    pub attachment_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub transcription_status: Option<String>,
    pub tags: Vec<String>,
}

/// A capture, or the live one it duplicates.
#[derive(Debug, Clone, PartialEq)]
pub enum Captured {
    Created(InboxItem),
    Duplicate(InboxItem),
}

/// Inserts one capture: its payload, projection, tags and outbox row.
pub fn capture(
    conn: &Connection,
    capture: &NewCapture,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    if capture.title.is_empty() && capture.item_type.is_empty() {
        return Err(StorageError::Invalid {
            what: "a capture needs a type and a title".to_owned(),
        });
    }
    let id = match &capture.id {
        Some(id) => super::super::tasks::valid_item_id(id)?.to_owned(),
        None => mint_id(),
    };
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &id),
        now_ms,
        |tx| {
            let at = iso(now_ms)?;
            let payload = object(json!({
                "id": id,
                "type": capture.item_type,
                "title": capture.title,
                "content": capture.content,
                "createdAt": at,
                "modifiedAt": at,
                "filedAt": null,
                "filedTo": null,
                "filedAction": null,
                "snoozedUntil": null,
                "snoozeReason": null,
                "viewedAt": null,
                "processingStatus": capture.processing_status,
                "processingError": null,
                "metadata": capture.metadata,
                "attachmentPath": capture.attachment_path,
                "thumbnailPath": capture.thumbnail_path,
                "transcription": null,
                "transcriptionStatus": capture.transcription_status,
                "sourceUrl": capture.source_url,
                "sourceTitle": capture.source_title,
                "captureSource": capture.capture_source,
                "archivedAt": null,
                "clock": next_clock(&Object::new(), device_id)?,
                "localOnly": false,
            }));
            insert_local(tx, ITEM_TYPE, &id, payload, now_ms)?;
            for tag in &capture.tags {
                insert_tag(tx, &id, tag, now_ms)?;
            }
            read_back(tx, &id)
        },
    )
}

/// `captureTextItem` behind `captureText`'s duplicate check.
pub fn capture_text(
    conn: &Connection,
    content: &str,
    title: Option<&str>,
    capture_source: Option<&str>,
    force: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<Captured, StorageError> {
    if content.trim().is_empty() {
        return Err(StorageError::Invalid {
            what: "a text capture needs content".to_owned(),
        });
    }
    if !force && let Some(existing) = queries::duplicate_by_content(conn, content)? {
        return Ok(Captured::Duplicate(existing));
    }
    let title = match title.filter(|t| !t.is_empty()) {
        Some(title) => title.to_owned(),
        None => text_title(content),
    };
    let item = capture(
        conn,
        &NewCapture {
            item_type: "note".to_owned(),
            title,
            content: Some(content.to_owned()),
            capture_source: capture_source.map(str::to_owned),
            processing_status: "complete".to_owned(),
            ..NewCapture::default()
        },
        device_id,
        now_ms,
    )?
    .acknowledge();
    Ok(Captured::Created(item))
}

/// `content.substring(0, 50) + (length > 50 ? '...' : '')`, in UTF-16 units.
pub fn text_title(content: &str) -> String {
    let units: Vec<u16> = content.encode_utf16().collect();
    if units.len() <= 50 {
        return content.to_owned();
    }
    format!("{}...", String::from_utf16_lossy(&units[..50]))
}

/// `captureLink`: a URL duplicate check, then a `link` or `social` capture
/// awaiting enrichment.
pub fn capture_link(
    conn: &Connection,
    url: &str,
    capture_source: Option<&str>,
    force: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<Captured, StorageError> {
    let url = url.trim();
    if !urls::is_url(url) {
        return Err(StorageError::Invalid {
            what: "that is not a web address".to_owned(),
        });
    }
    if !force && let Some(existing) = queries::duplicate_by_url(conn, url)? {
        return Ok(Captured::Duplicate(existing));
    }
    let social = urls::is_social_post(url);
    let (item_type, title, metadata, status) = if social {
        // `storeSocialMetadata` runs right after the insert on desktop.
        let handle = urls::social_handle(url);
        let title = if handle.is_empty() {
            "Tweet".to_owned()
        } else {
            format!("Tweet by {handle}")
        };
        let mut metadata = json!({
            "platform": "twitter", "postUrl": url, "authorName": "", "authorHandle": handle,
            "postContent": "", "mediaUrls": [], "extractionStatus": "partial",
        });
        if let Some(id) = urls::tweet_id(url) {
            metadata["tweetId"] = json!(id);
        }
        ("social", title, metadata, "complete")
    } else {
        let metadata = json!({ "url": url, "fetchStatus": "pending" });
        ("link", urls::title_from_url(url), metadata, "pending")
    };
    let item = capture(
        conn,
        &NewCapture {
            item_type: item_type.to_owned(),
            title,
            metadata: Some(metadata),
            source_url: Some(url.to_owned()),
            capture_source: capture_source.map(str::to_owned),
            processing_status: status.to_owned(),
            ..NewCapture::default()
        },
        device_id,
        now_ms,
    )?
    .acknowledge();
    Ok(Captured::Created(item))
}

/// Checks a file against desktop's limits before the shell stores it.
pub fn check_file(mime: &str, size: u64) -> Result<&'static str, StorageError> {
    let Some(kind) = type_for_mime(mime) else {
        return Err(StorageError::Invalid {
            what: format!("Unsupported file type: {mime}"),
        });
    };
    if size == 0 {
        return Err(StorageError::Invalid {
            what: "Empty file data".to_owned(),
        });
    }
    if size > MAX_FILE_BYTES {
        return Err(StorageError::Invalid {
            what: format!(
                "File too large: {}MB exceeds limit of 50MB",
                (size as f64 / 1_048_576.0).round()
            ),
        });
    }
    Ok(kind)
}

/// `Voice memo (m:ss)`.
pub fn voice_title(duration_seconds: f64) -> String {
    let total = duration_seconds.max(0.0);
    let minutes = (total / 60.0).floor() as i64;
    let seconds = (total % 60.0).round() as i64;
    format!("Voice memo ({minutes}:{seconds:02})")
}

/// One local edit: the changes plus the ticked clock and `modifiedAt`.
pub(crate) fn edit(
    conn: &Connection,
    item_id: &str,
    changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, item_id),
        now_ms,
        |tx| {
            edit_in(tx, item_id, changes, device_id, now_ms)?;
            read_back(tx, item_id)
        },
    )
}

/// [`edit`] inside the caller's transaction, for bulk writes.
pub(crate) fn edit_in(
    tx: &Connection,
    item_id: &str,
    mut changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let stored = live_payload(tx, item_id)?;
    changes.push((
        "clock",
        Change::Set(next_clock(stored.object(), device_id)?),
    ));
    changes.push(("modifiedAt", Change::set(iso(now_ms)?)));
    sync_items::apply_local_edit_in(tx, ITEM_TYPE, item_id, &changes, now_ms)?;
    Ok(())
}

fn live_payload(
    tx: &Connection,
    item_id: &str,
) -> Result<crate::storage::repositories::StoredPayload, StorageError> {
    let row = sync_items::load(tx, ITEM_TYPE, item_id)?;
    if row.as_ref().is_none_or(|row| row.deleted_at.is_some()) {
        return Err(StorageError::NotFound {
            what: format!("no capture {item_id}"),
        });
    }
    require_payload(tx, ITEM_TYPE, item_id)
}

pub(crate) fn read_back(tx: &Connection, item_id: &str) -> Result<InboxItem, StorageError> {
    super::get(tx, item_id)?.ok_or_else(|| StorageError::Failed {
        what: format!("capture {item_id} did not project"),
    })
}

pub(crate) fn require_live(conn: &Connection, item_id: &str) -> Result<InboxItem, StorageError> {
    super::get(conn, item_id)?.ok_or_else(|| StorageError::NotFound {
        what: format!("no capture {item_id}"),
    })
}

/// `handleUpdate`: title and/or content. `Some(None)` content clears it.
pub fn update(
    conn: &Connection,
    item_id: &str,
    title: Option<&str>,
    content: Option<Option<&str>>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    let mut changes = Vec::new();
    if let Some(title) = title {
        if title.trim().is_empty() {
            return Err(StorageError::Invalid {
                what: "a capture's title cannot be empty".to_owned(),
            });
        }
        changes.push(("title", Change::set(title)));
    }
    if let Some(content) = content {
        changes.push((
            "content",
            Change::Set(content.map_or(Value::Null, Value::from)),
        ));
    }
    edit(conn, item_id, changes, device_id, now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_follow_desktops_rules() {
        assert_eq!(text_title("short"), "short");
        assert_eq!(
            text_title(&"a".repeat(60)),
            format!("{}...", "a".repeat(50))
        );
        assert_eq!(voice_title(42.0), "Voice memo (0:42)");
        assert_eq!(voice_title(125.4), "Voice memo (2:05)");
    }

    #[test]
    fn files_are_checked_against_desktops_limits() {
        assert_eq!(check_file("image/png", 10).ok(), Some("image"));
        assert_eq!(check_file("audio/mp4", 10).ok(), Some("voice"));
        assert!(check_file("image/heic", 10).is_err());
        assert!(check_file("application/pdf", MAX_FILE_BYTES + 1).is_err());
        assert!(check_file("application/pdf", 0).is_err());
    }
}
