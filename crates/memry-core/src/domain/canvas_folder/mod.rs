//! Canvas folders: the `canvas_folder` sync type
//! (`CanvasFolderSyncPayloadSchema`, `packages/contracts/src/sync-payloads.ts`;
//! chapter 13 §13.7.23), the index half of desktop's `canvas/folder-store.ts`.
//! Step 30 (#3547) owns the directories on disk and calls these functions.
//!
//! The record carries only what a directory cannot: an empty folder's
//! existence and the folder's icon. Its id is derived from the path
//! ([`sync_id`]), so two devices that create one folder offline make one
//! record. The payload is Electron's `toPayload`
//! (`apps/desktop/src/main/sync/item-handlers/canvas-folder-handler.ts:20-31`),
//! `{id, vaultId, path, icon, clock, deletedAt}`, never `syncedAt`; [`merge`]
//! applies a peer's. A delete tombstones the record and states `deletedAt`, as
//! Electron's soft delete does.

pub mod merge;

use rusqlite::{Connection, Row, params};
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;

use crate::api::errors::StorageError;
use crate::domain::desktop_records::{self, live};
use crate::domain::notes::{failed, object};
use crate::domain::recreate::write_over_tombstone;
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox;

/// The sync type of a folder record.
pub const ITEM_TYPE: &str = "canvas_folder";

/// One live folder. Instants are epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasFolder {
    pub id: String,
    /// Forward-slashed, relative to `canvases/`.
    pub path: String,
    pub icon: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// `canvasFolderSyncId` (`packages/contracts/src/canvas-folder-types.ts:24-26`):
/// `cvf_` and the path in NFC, lowercased, so `Work` and `work` are one folder
/// on every platform.
pub fn sync_id(path: &str) -> String {
    let normalized: String = path.nfc().collect();
    format!("cvf_{}", normalized.to_lowercase())
}

/// Makes the folder at `path` live and queues it when anything changed: a new
/// folder, a deleted one revived, or a live one whose icon changes. `icon`
/// `None` keeps a live folder's icon (a new one has none) and `Some(None)`
/// clears it. A live folder keeps the spelling it was stored with.
///
/// `path` is the on-disk-canonical path, which this function does not make:
/// Electron stores `portableCanvasFolder(requested)`
/// (`apps/desktop/src/main/canvas/scene-file.ts:559-570`,
/// `apps/desktop/src/main/canvas/folder-store.ts:16-19`), so `Work/` is stored
/// as `Work` (`cvf_work`), and a reserved name such as `CON` as the directory
/// it lives in. Step 30 (#3547), which owns the directories, canonicalises
/// before it calls here; a raw path would mint a second record for one folder.
pub fn upsert(
    conn: &Connection,
    vault_id: &str,
    path: &str,
    icon: Option<Option<&str>>,
    device_id: &str,
    now_ms: i64,
) -> Result<CanvasFolder, StorageError> {
    if path.is_empty() {
        return Err(StorageError::Invalid {
            what: "a canvas folder needs a path".to_owned(),
        });
    }
    let id = sync_id(path);
    let current = get_any(conn, &id)?;
    if let Some(folder) = current.as_ref().filter(|(_, deleted)| !deleted) {
        let folder = &folder.0;
        if icon.is_none_or(|icon| icon == folder.icon.as_deref()) {
            return Ok(folder.clone());
        }
    }
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &id),
        now_ms,
        |tx| {
            let record = sync_items::load(tx, ITEM_TYPE, &id)?;
            if record.is_some_and(|row| row.deleted_at.is_none()) {
                // Live, or a peer's soft delete stated in the payload.
                let stored = live(tx, ITEM_TYPE, &id, "canvas folder")?;
                let mut changes = vec![("deletedAt", Change::Set(Value::Null))];
                if let Some(icon) = icon {
                    changes.push(("icon", Change::Set(json!(icon))));
                }
                desktop_records::edit(tx, ITEM_TYPE, &id, &stored, changes, device_id, now_ms)?;
            } else {
                let payload = object(json!({
                    "id": id,
                    "vaultId": vault_id,
                    "path": path,
                    "icon": icon.flatten(),
                    "clock": Value::Null,
                    "deletedAt": null,
                }));
                write_over_tombstone(tx, ITEM_TYPE, &id, payload, device_id, now_ms)?;
            }
            read_back(tx, &id)
        },
    )
    .map(outbox::Durable::acknowledge)
}

/// Deletes the folder at `path` and queues the delete. `false` when there was
/// none. The folder's canvases are their own records.
pub fn delete(
    conn: &Connection,
    path: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let id = sync_id(path);
    if get_any(conn, &id)?.is_none_or(|(_, deleted)| deleted) {
        return Ok(false);
    }
    outbox::commit(
        conn,
        &outbox::Change::delete(ITEM_TYPE, &id),
        now_ms,
        |tx| {
            let stored = live(tx, ITEM_TYPE, &id, "canvas folder")?;
            let changes = vec![("deletedAt", Change::set(now_ms))];
            desktop_records::tombstone(tx, ITEM_TYPE, &id, &stored, changes, device_id, now_ms)
        },
    )?;
    Ok(true)
}

/// Every live folder, by path.
pub fn list(conn: &Connection) -> Result<Vec<CanvasFolder>, StorageError> {
    let mut statement = conn
        .prepare_cached(&format!(
            "{SELECT} WHERE deleted_at IS NULL ORDER BY path, id"
        ))
        .map_err(failed)?;
    statement
        .query_map([], |row| read_row(row).map(|(folder, _)| folder))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

const SELECT: &str =
    "SELECT id, path, icon, created_at, updated_at, deleted_at IS NOT NULL FROM canvas_folders";

/// The folder's projection row and whether it is deleted.
fn get_any(conn: &Connection, id: &str) -> Result<Option<(CanvasFolder, bool)>, StorageError> {
    let mut statement = conn
        .prepare_cached(&format!("{SELECT} WHERE id = ?1"))
        .map_err(failed)?;
    let mut rows = statement.query(params![id]).map_err(failed)?;
    rows.next()
        .map_err(failed)?
        .map(read_row)
        .transpose()
        .map_err(failed)
}

fn read_row(row: &Row<'_>) -> rusqlite::Result<(CanvasFolder, bool)> {
    Ok((
        CanvasFolder {
            id: row.get(0)?,
            path: row.get(1)?,
            icon: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        },
        row.get(5)?,
    ))
}

fn read_back(tx: &Connection, id: &str) -> Result<CanvasFolder, StorageError> {
    match get_any(tx, id)? {
        Some((folder, false)) => Ok(folder),
        _ => Err(StorageError::Failed {
            what: format!("canvas folder {id} did not project"),
        }),
    }
}

#[cfg(test)]
mod tests;
