//! `inbox`: captures waiting to be processed (`InboxSyncPayloadSchema`,
//! `packages/contracts/src/sync-payloads.ts`, migration `0004`).
//!
//! The thirteen schema keys. Desktop's push also carries its local columns
//! (`viewedAt`, `processingStatus`, `transcription`, ...) because it serialises
//! its whole `inbox_items` row (`inbox-handler.ts`, `buildPushPayload`); the
//! schema strips them, so this reader does too, and `inbox_view` (migration
//! `0004`) reads them from the verbatim payload instead.
//!
//! Every field is `opt_null` ([`super`]'s rule): a projector substitutes and
//! never refuses. The merge rule — absent keeps, explicit `null` clears — is
//! the write path's ([`crate::domain::inbox::merge`]), resolved against the
//! verbatim payload before anything reaches a column.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{ItemContext, clock_text, failed, instant, json, text, text_or_default};

const INBOX_FIELDS: &[Field] = &[
    Field::opt_null("title", Kind::Text),
    Field::opt_null("content", Kind::Text),
    Field::opt_null("type", Kind::Text),
    Field::opt_null("metadata", Kind::Any),
    Field::opt_null("filedAt", Kind::Text),
    Field::opt_null("filedTo", Kind::Text),
    Field::opt_null("filedAction", Kind::Text),
    Field::opt_null("snoozedUntil", Kind::Text),
    Field::opt_null("snoozeReason", Kind::Text),
    Field::opt_null("archivedAt", Kind::Text),
    Field::opt_null("sourceUrl", Kind::Text),
    Field::opt_null("sourceTitle", Kind::Text),
    Field::opt_null("captureSource", Kind::Text),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("createdAt", Kind::SyncTimestamp),
    Field::opt_null("modifiedAt", Kind::SyncTimestamp),
];

pub fn read_inbox(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("inbox", parsed, INBOX_FIELDS)
}

/// Desktop's insert defaults for a row it has never seen
/// (`inbox-handler.ts`): a missing title reads `Untitled`, a missing type
/// `note`.
pub fn project_inbox(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO inbox_items (
             id, type, title, content, metadata, filed_at, filed_to, filed_action,
             snoozed_until, snooze_reason, archived_at, source_url, source_title,
             capture_source, created_at, modified_at, clock, synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                   ?15, ?16, ?17, ?18, ?19)
         ON CONFLICT(id) DO UPDATE SET
             type = excluded.type,
             title = excluded.title,
             content = excluded.content,
             metadata = excluded.metadata,
             filed_at = excluded.filed_at,
             filed_to = excluded.filed_to,
             filed_action = excluded.filed_action,
             snoozed_until = excluded.snoozed_until,
             snooze_reason = excluded.snooze_reason,
             archived_at = excluded.archived_at,
             source_url = excluded.source_url,
             source_title = excluded.source_title,
             capture_source = excluded.capture_source,
             created_at = excluded.created_at,
             modified_at = excluded.modified_at,
             clock = excluded.clock,
             synced_at = excluded.synced_at,
             deleted_at = excluded.deleted_at",
        params![
            item.item_id,
            text_or_default(view, "type", "note"),
            text_or_default(view, "title", "Untitled"),
            text(view, "content"),
            json(view, "metadata"),
            instant(view, "filedAt"),
            text(view, "filedTo"),
            text(view, "filedAction"),
            instant(view, "snoozedUntil"),
            text(view, "snoozeReason"),
            instant(view, "archivedAt"),
            text(view, "sourceUrl"),
            text(view, "sourceTitle"),
            text(view, "captureSource"),
            instant(view, "createdAt"),
            instant(view, "modifiedAt"),
            clock_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}
