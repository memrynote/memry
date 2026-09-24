//! `filter`: saved task filters (`FilterSyncPayloadSchema`,
//! `packages/contracts/src/sync-payloads.ts`, migration `0003`).
//!
//! Five fields and no `modifiedAt`: desktop's `saved_filters` row has none,
//! and its push payload is that row serialised. `config` is `z.unknown()` on
//! the wire, so it is read as [`Kind::Any`] and cached as JSON text; its shape
//! (`{filters, sort?, starred?}`) is the domain's to interpret, through
//! [`crate::domain::task_filter::TaskFilters::from_json`], never the
//! projector's to refuse.
//!
//! Null tolerance in the field table below follows [`super`]'s rule: an
//! optional field is `opt_null`, because a projector substitutes and never
//! refuses (§13.3, §A.4, spec-defect 53).

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{ItemContext, clock_text, failed, instant, json, number_or_default, text_or_default};

const FILTER_FIELDS: &[Field] = &[
    Field::opt_null("name", Kind::Text),
    Field::opt_null("config", Kind::Any),
    Field::opt_null("position", Kind::Number),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("createdAt", Kind::Text),
];

pub fn read_filter(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("filter", parsed, FILTER_FIELDS)
}

/// Desktop's inbound defaults for a filter it has never seen
/// (`packages/sync-client/src/item-handlers/filter-handler.ts`): a missing
/// name reads as `Untitled Filter` and a missing position as 0.
pub fn project_filter(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO saved_filters (
             id, name, config, position, created_at, clock, synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             config = excluded.config,
             position = excluded.position,
             created_at = excluded.created_at,
             clock = excluded.clock,
             synced_at = excluded.synced_at,
             deleted_at = excluded.deleted_at",
        params![
            item.item_id,
            text_or_default(view, "name", "Untitled Filter"),
            json(view, "config"),
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
