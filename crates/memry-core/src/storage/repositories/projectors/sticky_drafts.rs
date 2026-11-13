//! `sticky_draft`: unsent sticky text (`StickyDraftSyncPayloadSchema`,
//! `packages/contracts/src/sync-payloads.ts`, migration `0027`).
//!
//! Five fields under a whole-row clock. `createdAt` and `modifiedAt` are ISO
//! strings on the wire and epoch milliseconds in the table (§A.6). Electron
//! pushes its whole `sticky_drafts` row, so `id` and `syncedAt` can arrive as
//! unmodelled keys and are preserved. `kind` is stored as sent: a kind this
//! build does not know reads as `note` in [`crate::domain::sticky_draft`]. An
//! absent `content` is empty text and an absent instant the apply time, as
//! Electron's `?? now`.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{ItemContext, failed, instant, text_or_default};

const STICKY_DRAFT_FIELDS: &[Field] = &[
    Field::opt_null("content", Kind::Text),
    Field::opt_null("kind", Kind::Text),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("createdAt", Kind::Text),
    Field::opt_null("modifiedAt", Kind::Text),
];

pub fn read_sticky_draft(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("sticky_draft", parsed, STICKY_DRAFT_FIELDS)
}

pub fn project_sticky_draft(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO sticky_drafts (
             id, content, kind, created_at, modified_at, deleted_at, synced_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
             content = excluded.content,
             kind = excluded.kind,
             created_at = excluded.created_at,
             modified_at = excluded.modified_at,
             deleted_at = excluded.deleted_at,
             synced_at = excluded.synced_at",
        params![
            item.item_id,
            text_or_default(view, "content", ""),
            text_or_default(view, "kind", "note"),
            instant(view, "createdAt").unwrap_or(item.synced_at),
            instant(view, "modifiedAt").unwrap_or(item.synced_at),
            item.deleted_at,
            item.synced_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}
