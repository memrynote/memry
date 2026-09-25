//! The inbox: captures waiting to be filed, converted, snoozed or archived
//! (spec 006, the `inbox` sync type, `InboxSyncPayloadSchema`).
//!
//! Desktop is the reference (`apps/desktop/src/main/inbox/**`,
//! `apps/desktop/src/main/sync/item-handlers/inbox-handler.ts`):
//!
//! - one payload per capture, resolved **document-level** by its `clock`, and
//!   merged key by key on apply: an absent key keeps the local value, an
//!   explicit `null` clears it, and `title`/`type` never clear
//!   ([`merge::apply_remote`]);
//! - desktop pushes its whole row serialised, so a payload may carry the local
//!   columns (`viewedAt`, `transcription`, ...) too. They are read and written
//!   here the same way, and a peer that does not model them strips them;
//! - tags are device-local (`inbox_item_tags`), never on the wire.
//!
//! Instants in this module are epoch milliseconds; the payload carries them as
//! ISO strings, as desktop writes them.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::Value;

use crate::api::errors::StorageError;

use crate::storage::repositories::instants;

use super::notes::failed;

pub mod convert;
pub mod enrich;
pub mod filing;
pub mod merge;
pub mod panel;
pub mod queries;
pub mod states;
pub mod stats;
pub mod urls;
pub mod write;

pub use queries::*;

/// The `(type, _)` half of every key this module reads and writes.
pub const ITEM_TYPE: &str = "inbox";

/// The nine capture types desktop knows (`inboxItemType`,
/// `packages/db-schema/src/schema/inbox.ts`). A type a newer build adds is
/// carried verbatim; this list only orders the filter menu.
pub const ITEM_TYPES: [&str; 9] = [
    "link", "note", "image", "voice", "video", "clip", "pdf", "social", "reminder",
];

/// Types whose capture is a file (`isBinaryType`, `filing.ts`).
pub const BINARY_TYPES: [&str; 4] = ["image", "voice", "pdf", "video"];

/// Types that can only become a note (`isNoteOnlyType`, `filing.ts`): no
/// task, event or reminder.
pub const NOTE_ONLY_TYPES: [&str; 4] = ["image", "pdf", "video", "clip"];

/// One capture, read from the `inbox_items` projection.
#[derive(Debug, Clone, PartialEq)]
pub struct InboxItem {
    pub id: String,
    pub item_type: String,
    pub title: String,
    pub content: Option<String>,
    /// The payload's `metadata`, or `None` when absent or `null`.
    pub metadata: Option<Value>,
    pub filed_at: Option<i64>,
    pub filed_to: Option<String>,
    pub filed_action: Option<String>,
    pub snoozed_until: Option<i64>,
    pub snooze_reason: Option<String>,
    pub archived_at: Option<i64>,
    pub viewed_at: Option<i64>,
    pub source_url: Option<String>,
    pub source_title: Option<String>,
    pub capture_source: Option<String>,
    /// `pending | processing | complete | failed`; `None` reads as complete.
    pub processing_status: Option<String>,
    pub transcription: Option<String>,
    pub transcription_status: Option<String>,
    /// Vault-relative, as the capturing device stored it. The file exists only
    /// on that device until the capture is filed (inbox attachments do not
    /// sync, spec 006 §5 F3).
    pub attachment_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub created_at: i64,
    pub modified_at: Option<i64>,
    /// Device-local tags.
    pub tags: Vec<String>,
}

impl InboxItem {
    /// Not filed, not archived, not snoozed: what the inbox list shows.
    pub fn is_active(&self) -> bool {
        self.filed_at.is_none() && self.archived_at.is_none() && self.snoozed_until.is_none()
    }

    /// A number from `metadata`, for `duration` and `pageCount`.
    pub fn metadata_number(&self, key: &str) -> Option<f64> {
        self.metadata.as_ref()?.get(key)?.as_f64()
    }

    /// A string from `metadata`.
    pub fn metadata_text(&self, key: &str) -> Option<&str> {
        self.metadata.as_ref()?.get(key)?.as_str()
    }
}

/// The columns [`item_row`] reads, selected from `inbox_view` (the projection
/// plus desktop's local keys read from the verbatim payload).
pub(crate) const COLUMNS: &str = "id, type, title, content, metadata, filed_at, filed_to, \
     filed_action, snoozed_until, snooze_reason, archived_at, viewed_at_raw, source_url, \
     source_title, capture_source, processing_status, transcription, transcription_status, \
     attachment_path, thumbnail_path, created_at, modified_at";

/// A payload key outside the schema, read by `json_extract`: text, or `None`
/// for anything else.
fn loose_text(value: rusqlite::types::Value) -> Option<String> {
    match value {
        rusqlite::types::Value::Text(text) => Some(text),
        _ => None,
    }
}

/// `viewedAt` as desktop writes it (an ISO string), or epoch milliseconds.
fn loose_instant(value: rusqlite::types::Value) -> Option<i64> {
    match value {
        rusqlite::types::Value::Text(text) => instants::to_epoch_ms(&text),
        rusqlite::types::Value::Integer(ms) => Some(ms),
        rusqlite::types::Value::Real(ms) => Some(ms as i64),
        _ => None,
    }
}

pub(crate) fn item_row(row: &Row<'_>) -> rusqlite::Result<InboxItem> {
    let metadata: Option<String> = row.get(4)?;
    Ok(InboxItem {
        id: row.get(0)?,
        item_type: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        metadata: metadata.and_then(|text| serde_json::from_str(&text).ok()),
        filed_at: row.get(5)?,
        filed_to: row.get(6)?,
        filed_action: row.get(7)?,
        snoozed_until: row.get(8)?,
        snooze_reason: row.get(9)?,
        archived_at: row.get(10)?,
        viewed_at: loose_instant(row.get(11)?),
        source_url: row.get(12)?,
        source_title: row.get(13)?,
        capture_source: row.get(14)?,
        processing_status: loose_text(row.get(15)?),
        transcription: loose_text(row.get(16)?),
        transcription_status: loose_text(row.get(17)?),
        attachment_path: loose_text(row.get(18)?),
        thumbnail_path: loose_text(row.get(19)?),
        created_at: row.get::<_, Option<i64>>(20)?.unwrap_or(0),
        modified_at: row.get(21)?,
        tags: Vec::new(),
    })
}

/// One live capture by id, with its tags.
pub fn get(conn: &Connection, item_id: &str) -> Result<Option<InboxItem>, StorageError> {
    let item = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM inbox_view WHERE id = ?1 AND deleted_at IS NULL"),
            params![item_id],
            item_row,
        )
        .optional()
        .map_err(failed)?;
    item.map(|mut item| {
        item.tags = tags_of(conn, &item.id)?;
        Ok(item)
    })
    .transpose()
}

/// Runs `sql` (which selects [`COLUMNS`]) and attaches each row's tags.
pub(crate) fn select_items(
    conn: &Connection,
    sql: &str,
    args: &[&dyn rusqlite::ToSql],
) -> Result<Vec<InboxItem>, StorageError> {
    let mut statement = conn.prepare(sql).map_err(failed)?;
    let rows = statement.query_map(args, item_row).map_err(failed)?;
    let mut items = Vec::new();
    for row in rows {
        let mut item = row.map_err(failed)?;
        item.tags = tags_of(conn, &item.id)?;
        items.push(item);
    }
    Ok(items)
}

/// A capture's device-local tags, in the order they were added.
pub fn tags_of(conn: &Connection, item_id: &str) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare("SELECT tag FROM inbox_item_tags WHERE item_id = ?1 ORDER BY created_at, tag")
        .map_err(failed)?;
    let rows = statement
        .query_map(params![item_id], |row| row.get::<_, String>(0))
        .map_err(failed)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(failed)
}

/// Every tag on a live capture with its use count, most used first
/// (`handleGetTags`).
pub fn all_tags(conn: &Connection) -> Result<Vec<(String, i64)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT t.tag, count(*) FROM inbox_item_tags t
               JOIN inbox_items i ON i.id = t.item_id AND i.deleted_at IS NULL
              GROUP BY t.tag COLLATE NOCASE
              ORDER BY count(*) DESC, t.tag",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(failed)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(failed)
}
