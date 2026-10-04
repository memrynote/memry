//! `canvas`: whiteboards (`CanvasSyncPayloadSchema`,
//! `packages/contracts/src/sync-payloads.ts`).
//!
//! A reader and no table, like `custom_icon`: the scene is the payload, and
//! every read goes to `sync_items.payload` ([`crate::domain::canvas::get`]).
//! The reader still runs, so a malformed canvas payload is recorded corrupt.

use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};

const CANVAS_FIELDS: &[Field] = &[
    Field::opt_null("id", Kind::Text),
    Field::opt_null("vaultId", Kind::Text),
    Field::opt_null("title", Kind::Text),
    Field::opt_null("scene", Kind::Text),
    Field::opt_null("folder", Kind::Text),
    Field::opt_null("icon", Kind::Text),
    Field::opt_null("ownerNoteId", Kind::Text),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("deletedAt", Kind::Number),
];

pub fn read_canvas(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("canvas", parsed, CANVAS_FIELDS)
}
