//! `canvas_folder`: a canvas folder's existence and icon
//! (`CanvasFolderSyncPayloadSchema`, `packages/contracts/src/sync-payloads.ts`,
//! migration `0027`).
//!
//! Six fields under a whole-row clock. Placement of a canvas lives on the
//! canvas, so this record carries only what a directory cannot: the icon and
//! the existence of an empty folder. Electron soft-deletes, so a payload whose
//! `deletedAt` is a number is a deleted folder here too, as is a tombstoned
//! record. The payload has no timestamps: `created_at` is when this device
//! first held the folder and survives later applies, and `updated_at` is the
//! last apply. An absent `path` is empty text, which names no folder.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{ItemContext, failed, number, text, text_or_default};

const CANVAS_FOLDER_FIELDS: &[Field] = &[
    Field::opt_null("id", Kind::Text),
    Field::opt_null("vaultId", Kind::Text),
    Field::opt_null("path", Kind::Text),
    Field::opt_null("icon", Kind::Text),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("deletedAt", Kind::Number),
];

pub fn read_canvas_folder(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("canvas_folder", parsed, CANVAS_FOLDER_FIELDS)
}

pub fn project_canvas_folder(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO canvas_folders (
             id, vault_id, path, icon, created_at, updated_at, deleted_at, synced_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?5)
         ON CONFLICT(id) DO UPDATE SET
             vault_id = excluded.vault_id,
             path = excluded.path,
             icon = excluded.icon,
             created_at = COALESCE(canvas_folders.created_at, excluded.created_at),
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             synced_at = excluded.synced_at",
        params![
            item.item_id,
            text(view, "vaultId"),
            text_or_default(view, "path", ""),
            text(view, "icon"),
            item.synced_at,
            item.deleted_at.or_else(|| number(view, "deletedAt")),
        ],
    )
    .map_err(failed)?;
    Ok(())
}
