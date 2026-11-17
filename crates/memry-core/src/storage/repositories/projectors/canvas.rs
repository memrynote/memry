//! `canvas`: whiteboards (`CanvasSyncPayloadSchema`,
//! `packages/contracts/src/sync-payloads.ts`, migration `0033`).
//!
//! Every field but the scene, which stays in the payload so a list never reads
//! one ([`crate::domain::canvas::get`] reads it from `sync_items.payload`). The
//! payload has no timestamps, as in Electron's `canvases` row
//! (`apps/desktop/src/main/sync/item-handlers/canvas-handler.ts:214-218,318`):
//! `created_at` is when this device first held the canvas and survives later
//! applies, and `updated_at` is the last apply or local edit. `folder` is
//! cleaned up as Electron reads a stored one (`normalizeStoredFolder`), never
//! refused. An absent `vaultId` is empty text.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::canvas::folder_paths::normalize_stored_folder;

use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{ItemContext, clock_text, failed, number, text, text_or_default};

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

pub fn project_canvas(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO canvases (
             id, vault_id, title, folder, icon, owner_note_id, created_at, updated_at,
             deleted_at, clock, synced_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?7)
         ON CONFLICT(id) DO UPDATE SET
             vault_id = excluded.vault_id,
             title = excluded.title,
             folder = excluded.folder,
             icon = excluded.icon,
             owner_note_id = excluded.owner_note_id,
             created_at = COALESCE(canvases.created_at, excluded.created_at),
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             clock = excluded.clock,
             synced_at = excluded.synced_at",
        params![
            item.item_id,
            text_or_default(view, "vaultId", ""),
            text(view, "title"),
            normalize_stored_folder(text(view, "folder").as_deref()),
            text(view, "icon"),
            text(view, "ownerNoteId"),
            item.synced_at,
            item.deleted_at.or_else(|| number(view, "deletedAt")),
            clock_text(view),
        ],
    )
    .map_err(failed)?;
    Ok(())
}
