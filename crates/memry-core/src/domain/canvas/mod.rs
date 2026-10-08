//! Whiteboards: the `canvas` sync type (`CanvasSyncPayloadSchema`,
//! `packages/contracts/src/sync-payloads.ts`).
//!
//! Desktop is the reference (`apps/desktop/src/main/sync/item-handlers/canvas-handler.ts`,
//! `apps/desktop/src/main/canvas/scene-file.ts`):
//!
//! - the payload is desktop's push shape, every key stated:
//!   `{id, vaultId, title, scene, folder, icon, ownerNoteId, clock, deletedAt}`.
//!   `vaultId` is required, because desktop skips a remote create without one;
//! - `scene` is Excalidraw JSON text in desktop's canonical form
//!   ([`canonical_scene`]). Desktop decides a conflict by comparing scene
//!   **text**, so a scene this core writes in any other form mints a spurious
//!   "(conflict copy)" on both sides;
//! - `canvas` is resolved document-level: a local edit ticks the document clock
//!   and only that. The inbound rule is [`merge`].
//!
//! Every write is one transaction with its outbox row, through
//! [`outbox::commit`].

pub mod merge;

use rusqlite::Connection;
use serde_json::{Map, Value, json};

use crate::api::errors::StorageError;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{Change, StoredPayload, sync_items};
use crate::sync::outbox::{self, Durable};

use super::notes::{insert_local, next_clock, object, require_payload};
use super::saved_filters::mint_id;

/// The `(type, _)` half of every key this module writes.
pub const ITEM_TYPE: &str = "canvas";

/// What desktop pushes for a canvas nobody has drawn on: `EMPTY_SCENE` in
/// `scene-file.ts`, canonicalized.
pub const EMPTY_SCENE: &str =
    r#"{"type":"excalidraw","version":2,"source":"memry","elements":[],"appState":{},"files":{}}"#;

/// Desktop's sidecar inside the `.excalidraw` file. Never part of a scene.
const FILE_META_KEY: &str = "memry";

/// One live canvas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Canvas {
    pub id: String,
    pub title: Option<String>,
    /// The note whose whiteboard block embeds this canvas, or `None` for a
    /// free-standing one.
    pub owner_note_id: Option<String>,
    /// Excalidraw JSON, as stored. Empty when the payload carries no scene.
    pub scene: String,
}

/// What a new canvas carries.
#[derive(Debug, Clone, Copy)]
pub struct NewCanvas<'a> {
    pub title: Option<&'a str>,
    pub owner_note_id: Option<&'a str>,
    /// `None` or blank is an empty board.
    pub scene: Option<&'a str>,
}

/// Desktop's `JSON.stringify(canonicalize(JSON.parse(scene), null))`: the head
/// keys in order with their defaults, the `memry` sidecar dropped, every other
/// top-level key sorted, compact. Nested values keep their order.
///
/// A blank scene is [`EMPTY_SCENE`]. Text that is not a JSON object is
/// refused rather than written as an empty board, which is what desktop does
/// with it and which would erase the drawing.
pub fn canonical_scene(scene: &str) -> Result<String, StorageError> {
    if scene.trim().is_empty() {
        return Ok(EMPTY_SCENE.to_owned());
    }
    let Ok(Value::Object(mut parsed)) = serde_json::from_str::<Value>(scene) else {
        return Err(StorageError::Invalid {
            what: "a canvas scene is a JSON object".to_owned(),
        });
    };
    // `canonicalize`'s head keys, in order, each with the value `??` gives it.
    let head = [
        ("type", json!("excalidraw")),
        ("version", json!(2)),
        ("source", json!("memry")),
        ("elements", json!([])),
        ("appState", json!({})),
        ("files", json!({})),
    ];
    let mut canonical = Map::new();
    for (key, default) in head {
        let value = parsed.remove(key).filter(|value| !value.is_null());
        canonical.insert(key.to_owned(), value.unwrap_or(default));
    }
    parsed.remove(FILE_META_KEY);
    let mut rest: Vec<(String, Value)> = parsed.into_iter().collect();
    // `Array.prototype.sort` orders by UTF-16 code unit, not by byte.
    rest.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    canonical.extend(rest);
    Ok(Value::Object(canonical).to_string())
}

/// One live canvas by id.
pub fn get(conn: &Connection, canvas_id: &str) -> Result<Option<Canvas>, StorageError> {
    let Some(row) = sync_items::load(conn, ITEM_TYPE, canvas_id)? else {
        return Ok(None);
    };
    let Some(raw) = row.payload.filter(|_| row.deleted_at.is_none()) else {
        return Ok(None);
    };
    let stored = StoredPayload::parse(&raw).map_err(|error| StorageError::Failed {
        what: format!("canvas {canvas_id}: {error}"),
    })?;
    Ok(Some(read(canvas_id, stored.object())))
}

/// Creates a canvas and queues it for push.
pub fn create(
    conn: &Connection,
    canvas: &NewCanvas<'_>,
    vault_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<Canvas>, StorageError> {
    if canvas.owner_note_id == Some("") {
        return Err(StorageError::Invalid {
            what: "a canvas owner is a note id, not an empty string".to_owned(),
        });
    }
    let scene = canonical_scene(canvas.scene.unwrap_or(""))?;
    let id = mint_id();
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &id),
        now_ms,
        |tx| {
            let payload = object(json!({
                "id": id,
                "vaultId": vault_id,
                "title": canvas.title,
                "scene": scene,
                "folder": null,
                "icon": null,
                "ownerNoteId": canvas.owner_note_id,
                "clock": next_clock(&Object::new(), device_id)?,
                "deletedAt": null,
            }));
            insert_local(tx, ITEM_TYPE, &id, payload, now_ms)?;
            read_back(tx, &id)
        },
    )
}

/// Replaces a canvas's scene and ticks its clock.
pub fn set_scene(
    conn: &Connection,
    canvas_id: &str,
    scene: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<Canvas>, StorageError> {
    let scene = canonical_scene(scene)?;
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, canvas_id),
        now_ms,
        |tx| {
            let stored = live_payload(tx, canvas_id)?;
            let changes = [
                ("scene", Change::set(scene)),
                (
                    "clock",
                    Change::Set(next_clock(stored.object(), device_id)?),
                ),
            ];
            sync_items::apply_local_edit_in(tx, ITEM_TYPE, canvas_id, &changes, now_ms)?;
            read_back(tx, canvas_id)
        },
    )
}

fn read(canvas_id: &str, payload: &Object) -> Canvas {
    let text = |key: &str| payload.get(key).and_then(Value::as_str).map(str::to_owned);
    Canvas {
        id: canvas_id.to_owned(),
        title: text("title"),
        owner_note_id: text("ownerNoteId"),
        scene: text("scene").unwrap_or_default(),
    }
}

fn live_payload(tx: &Connection, canvas_id: &str) -> Result<StoredPayload, StorageError> {
    let row = sync_items::load(tx, ITEM_TYPE, canvas_id)?;
    if row.as_ref().is_none_or(|row| row.deleted_at.is_some()) {
        return Err(StorageError::NotFound {
            what: format!("no canvas {canvas_id}"),
        });
    }
    require_payload(tx, ITEM_TYPE, canvas_id)
}

fn read_back(tx: &Connection, canvas_id: &str) -> Result<Canvas, StorageError> {
    get(tx, canvas_id)?.ok_or_else(|| StorageError::Failed {
        what: format!("canvas {canvas_id} did not read back"),
    })
}

#[cfg(test)]
mod tests;
