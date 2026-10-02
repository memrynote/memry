//! `bookmark`: the sidebar's bookmarks (`BookmarkSyncPayloadSchema`,
//! `packages/contracts/src/sync-payloads.ts`, migration `0009`).
//!
//! Five fields, a whole-row clock, no `modifiedAt`: desktop's `bookmarks` row
//! has none, and its push payload is that row serialised, so its local columns
//! (`id`, `syncedAt`) ride along as unknown keys in the verbatim payload.
//!
//! `itemType` and `itemId` name what is bookmarked. Desktop refuses to insert
//! a bookmark missing either (`bookmark-handler.ts`); here they substitute to
//! empty text instead (§13.3, §A.4), and the read side drops a row with
//! nothing to point at, so a malformed row is never shown and never refused.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{ItemContext, clock_text, failed, instant, number_or_default, text_or_default};

const BOOKMARK_FIELDS: &[Field] = &[
    Field::opt_null("itemType", Kind::Text),
    Field::opt_null("itemId", Kind::Text),
    Field::opt_null("position", Kind::Number),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("createdAt", Kind::Text),
];

pub fn read_bookmark(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("bookmark", parsed, BOOKMARK_FIELDS)
}

/// Desktop's inbound default for a missing position is 0.
pub fn project_bookmark(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO bookmarks (
             id, item_type, item_id, position, created_at, clock, synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
             item_type = excluded.item_type,
             item_id = excluded.item_id,
             position = excluded.position,
             created_at = excluded.created_at,
             clock = excluded.clock,
             synced_at = excluded.synced_at,
             deleted_at = excluded.deleted_at",
        params![
            item.item_id,
            text_or_default(view, "itemType", ""),
            text_or_default(view, "itemId", ""),
            number_or_default(view, "position", 0),
            instant(view, "createdAt"),
            clock_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}
