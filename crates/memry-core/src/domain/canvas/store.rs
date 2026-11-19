//! Canvas reads and writes: the record half of Electron's `canvas/store.ts`
//! with its sync calls from `canvas/sync-bridge.ts` and
//! `ipc/canvas-handlers.ts:80-215`. The file half (`.excalidraw` documents,
//! paths, trash) is the shell's, which writes the file before it calls here.
//!
//! **The sync cap.** Electron saves every scene locally and enqueues a push
//! only when the scene fits [`CANVAS_SCENE_SYNC_CAP_BYTES`]; an update over it
//! still ticks the clock (`bumpCanvasClockLocalOnly`), so a later remote edit
//! resolves as concurrent instead of overwriting the unsynced drawing. Here the
//! payload is the local copy (iOS has no file), so a write over the cap commits
//! the payload, clock tick included, with no outbox row, and reports
//! [`SyncHold::TooLarge`]. The cap is measured on the scene the payload holds
//! after the write, the one a push would carry: a title edit to an over-cap
//! canvas is held back too, where Electron would push it and fail.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::desktop_records::{live, tombstone};
use crate::domain::notes::{failed, insert_local, next_clock, object};
use crate::domain::saved_filters::mint_id;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{Change, StoredPayload, sync_items};
use crate::sync::outbox;

use super::folder_paths::normalize_folder;
use super::{CANVAS_SCENE_SYNC_CAP_BYTES, Canvas, ITEM_TYPE, NewCanvas, canonical_scene};

/// Whether a saved canvas was queued for push.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncHold {
    Queued,
    /// Saved locally and held back from sync: its scene is `bytes` long, over
    /// the cap. The shell tells the user (`canvas:too-large`).
    TooLarge {
        bytes: usize,
    },
}

/// Whether a canvas whose payload holds `scene` is pushed: the one rule every
/// write and every record follows.
pub fn sync_hold(scene: &str) -> SyncHold {
    if scene.len() > CANVAS_SCENE_SYNC_CAP_BYTES {
        SyncHold::TooLarge { bytes: scene.len() }
    } else {
        SyncHold::Queued
    }
}

/// A committed canvas write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Saved {
    pub canvas: Canvas,
    pub sync: SyncHold,
}

/// An edit of a live canvas. `None` leaves a field as it is; `Some(None)`
/// clears it.
#[derive(Debug, Clone, Copy, Default)]
pub struct CanvasEdit<'a> {
    pub title: Option<Option<&'a str>>,
    /// The on-disk spelling, refused past the depth cap. `Some(None)` is the
    /// root.
    pub folder: Option<Option<&'a str>>,
    pub icon: Option<Option<&'a str>>,
    pub scene: Option<&'a str>,
    /// Refuse the edit when the canvas changed since this `updated_at` was read.
    pub expected_updated_at: Option<i64>,
}

/// The outcome of [`update`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Updated {
    Saved(Saved),
    /// `expected_updated_at` no longer matches; nothing was written.
    Conflict,
}

/// One live canvas by id.
pub fn get(conn: &Connection, canvas_id: &str) -> Result<Option<Canvas>, StorageError> {
    let row = conn
        .query_row(
            &format!(
                "SELECT {COLUMNS}, s.payload FROM canvases c
                 JOIN sync_items s ON s.item_type = ?1 AND s.item_id = c.id
                 WHERE c.id = ?2 AND c.deleted_at IS NULL AND s.deleted_at IS NULL"
            ),
            params![ITEM_TYPE, canvas_id],
            |row| Ok((read_row(row)?, row.get::<_, Option<String>>(7)?)),
        )
        .optional()
        .map_err(failed)?;
    let Some((mut canvas, payload)) = row else {
        return Ok(None);
    };
    let stored = StoredPayload::parse(payload.as_deref().unwrap_or_default()).map_err(|error| {
        StorageError::Failed {
            what: format!("canvas {canvas_id}: {error}"),
        }
    })?;
    canvas.scene = scene_of(stored.object()).to_owned();
    Ok(Some(canvas))
}

/// Every live canvas of the vault, most recently changed first, without
/// scenes (`listCanvases`). A payload that named no vault lists in every one.
pub fn list(conn: &Connection, vault_id: &str) -> Result<Vec<Canvas>, StorageError> {
    let mut statement = conn
        .prepare_cached(&format!(
            "SELECT {COLUMNS} FROM canvases c
             WHERE c.vault_id IN (?1, '') AND c.deleted_at IS NULL
             ORDER BY c.updated_at DESC, c.id"
        ))
        .map_err(failed)?;
    statement
        .query_map([vault_id], read_row)
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// Creates a canvas, queued for push unless its scene is over the cap.
pub fn create(
    conn: &Connection,
    canvas: &NewCanvas<'_>,
    vault_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Saved, StorageError> {
    if canvas.owner_note_id == Some("") {
        return Err(StorageError::Invalid {
            what: "a canvas owner is a note id, not an empty string".to_owned(),
        });
    }
    let folder = normalize_folder(canvas.folder)?;
    let scene = canonical_scene(canvas.scene.unwrap_or(""))?;
    let id = mint_id();
    let payload = object(json!({
        "id": id,
        "vaultId": vault_id,
        "title": canvas.title,
        "scene": scene,
        "folder": folder,
        "icon": canvas.icon,
        "ownerNoteId": canvas.owner_note_id,
        "clock": next_clock(&Object::new(), device_id)?,
        "deletedAt": null,
    }));
    let tx = conn.unchecked_transaction().map_err(failed)?;
    insert_local(&tx, ITEM_TYPE, &id, payload, now_ms)?;
    commit(tx, &id, &scene, now_ms)
}

/// Edits a live canvas and ticks its clock; `NotFound` for a deleted one.
pub fn update(
    conn: &Connection,
    canvas_id: &str,
    edit: &CanvasEdit<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Updated, StorageError> {
    let folder = edit.folder.map(normalize_folder).transpose()?;
    let scene = edit.scene.map(canonical_scene).transpose()?;
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let stored = live(&tx, ITEM_TYPE, canvas_id, "canvas")?;
    if let Some(expected) = edit.expected_updated_at {
        let updated_at: Option<i64> = tx
            .query_row(
                "SELECT updated_at FROM canvases WHERE id = ?1",
                [canvas_id],
                |row| row.get(0),
            )
            .map_err(failed)?;
        if updated_at != Some(expected) {
            return Ok(Updated::Conflict);
        }
    }
    let mut changes: Vec<(&str, Change)> = Vec::new();
    if let Some(title) = edit.title {
        changes.push(("title", Change::Set(json!(title))));
    }
    if let Some(folder) = folder {
        changes.push(("folder", Change::Set(json!(folder))));
    }
    if let Some(icon) = edit.icon {
        changes.push(("icon", Change::Set(json!(icon))));
    }
    if let Some(scene) = &scene {
        changes.push(("scene", Change::set(scene.clone())));
    }
    changes.push((
        "clock",
        Change::Set(next_clock(stored.object(), device_id)?),
    ));
    sync_items::apply_local_edit_in(&tx, ITEM_TYPE, canvas_id, &changes, now_ms)?;
    let final_scene = scene.unwrap_or_else(|| scene_of(stored.object()).to_owned());
    commit(tx, canvas_id, &final_scene, now_ms).map(Updated::Saved)
}

/// Tombstones a live canvas and queues the delete; `false` when there was
/// none. Its asset rows and file record stay: the shell releases the file once
/// it is gone from disk, and asset GC decides the rest.
///
/// The tombstone drops the scene. No peer reads a deleted canvas's scene
/// (Electron's `applyDelete` takes only the clock, and a revive carries its
/// own), and a scene over the item limit would fail to seal, so the push would
/// retire the delete unsent and the next remote edit would revive the canvas
/// here.
pub fn delete(
    conn: &Connection,
    canvas_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    if get(conn, canvas_id)?.is_none() {
        return Ok(false);
    }
    let tx = conn.unchecked_transaction().map_err(failed)?;
    tombstone_in(&tx, canvas_id, device_id, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(true)
}

/// Copies a live canvas beside the original (`duplicateCanvas`): same scene,
/// folder and icon, never owned by a note, titled `title` (the shell names it
/// after the file it allocates). Its `canvas_assets` rows are copied in the
/// same transaction: asset GC frees content no other canvas references, so a
/// copy without them would lose its images when the original next saves.
/// `None` when the source is gone.
pub fn duplicate(
    conn: &Connection,
    source_id: &str,
    title: Option<&str>,
    vault_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<Saved>, StorageError> {
    let Some(source) = get(conn, source_id)? else {
        return Ok(None);
    };
    let id = mint_id();
    let payload = object(json!({
        "id": id,
        "vaultId": vault_id,
        "title": title,
        "scene": source.scene,
        "folder": source.folder,
        "icon": source.icon,
        "ownerNoteId": null,
        "clock": next_clock(&Object::new(), device_id)?,
        "deletedAt": null,
    }));
    let tx = conn.unchecked_transaction().map_err(failed)?;
    insert_local(&tx, ITEM_TYPE, &id, payload, now_ms)?;
    tx.execute(
        "INSERT OR IGNORE INTO canvas_assets (
             vault_id, canvas_id, content_hash, attachment_id, file_id, filename, mime_type,
             size_bytes, chunk_hashes, created_at
         )
         SELECT vault_id, ?2, content_hash, attachment_id, file_id, filename, mime_type,
                size_bytes, chunk_hashes, created_at
         FROM canvas_assets WHERE canvas_id = ?1",
        params![source_id, id],
    )
    .map_err(failed)?;
    commit(tx, &id, &source.scene, now_ms).map(Some)
}

/// Files a live canvas under `folder` (already canonical, `None` the root)
/// inside a transaction the caller holds: ticks its clock and queues it
/// unless its scene is over the cap. A folder move or rename does this for
/// each canvas it carries (`relocateFolder`).
pub(crate) fn set_folder_in(
    tx: &Connection,
    canvas_id: &str,
    folder: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<SyncHold, StorageError> {
    let stored = live(tx, ITEM_TYPE, canvas_id, "canvas")?;
    let changes = [
        ("folder", Change::Set(json!(folder))),
        (
            "clock",
            Change::Set(next_clock(stored.object(), device_id)?),
        ),
    ];
    sync_items::apply_local_edit_in(tx, ITEM_TYPE, canvas_id, &changes, now_ms)?;
    let sync = sync_hold(scene_of(stored.object()));
    if sync == SyncHold::Queued {
        outbox::enqueue(tx, &outbox::Change::upsert(ITEM_TYPE, canvas_id), now_ms)?;
    }
    Ok(sync)
}

/// [`delete`] of a canvas known to be live, inside a transaction the caller
/// holds, with its outbox row.
pub(crate) fn tombstone_in(
    tx: &Connection,
    canvas_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let stored = live(tx, ITEM_TYPE, canvas_id, "canvas")?;
    let changes = vec![
        ("deletedAt", Change::set(now_ms)),
        ("scene", Change::Remove),
    ];
    tombstone(
        tx, ITEM_TYPE, canvas_id, &stored, changes, device_id, now_ms,
    )?;
    outbox::enqueue(tx, &outbox::Change::delete(ITEM_TYPE, canvas_id), now_ms)?;
    Ok(())
}

/// The id and folder of every live canvas of the vault, read without scenes.
pub(crate) fn placements(
    conn: &Connection,
    vault_id: &str,
) -> Result<Vec<(String, Option<String>)>, StorageError> {
    let mut statement = conn
        .prepare_cached(
            "SELECT id, folder FROM canvases
             WHERE vault_id IN (?1, '') AND deleted_at IS NULL ORDER BY id",
        )
        .map_err(failed)?;
    statement
        .query_map([vault_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// Queues the canvas when `scene` fits the cap, commits, and reads it back.
fn commit(
    tx: rusqlite::Transaction<'_>,
    canvas_id: &str,
    scene: &str,
    now_ms: i64,
) -> Result<Saved, StorageError> {
    let sync = sync_hold(scene);
    if sync == SyncHold::Queued {
        outbox::enqueue(&tx, &outbox::Change::upsert(ITEM_TYPE, canvas_id), now_ms)?;
    }
    let canvas = get(&tx, canvas_id)?.ok_or_else(|| StorageError::Failed {
        what: format!("canvas {canvas_id} did not read back"),
    })?;
    tx.commit().map_err(failed)?;
    Ok(Saved { canvas, sync })
}

const COLUMNS: &str = "c.id, c.title, c.folder, c.icon, c.owner_note_id,
     COALESCE(c.created_at, 0), COALESCE(c.updated_at, 0)";

fn read_row(row: &Row<'_>) -> rusqlite::Result<Canvas> {
    Ok(Canvas {
        id: row.get(0)?,
        title: row.get(1)?,
        folder: row.get(2)?,
        icon: row.get(3)?,
        owner_note_id: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        scene: String::new(),
    })
}

fn scene_of(payload: &Object) -> &str {
    payload
        .get("scene")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;
