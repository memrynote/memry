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
//! The writes live in [`store`]: each is one transaction with its outbox row,
//! and a scene over [`CANVAS_SCENE_SYNC_CAP_BYTES`] saves without one. The
//! `canvases` table (migration `0036`) indexes every field but the scene, which
//! stays in the payload; [`edges`] indexes what each scene points at, and
//! [`folder_paths`] and [`scene_refs`] are the pure rules both build on.

pub mod edges;
/// Desktop writes the files, and links the JavaScript JSON helpers this uses.
#[cfg(feature = "markdown")]
pub mod file_format;
pub mod folder_paths;
pub mod folders;
pub mod merge;
pub mod scene_refs;
mod store;

use serde_json::{Map, Value, json};

use crate::api::errors::StorageError;

pub use store::{
    CanvasCopy, CanvasEdit, Saved, SyncHold, Updated, create, delete, duplicate, get, list, new_id,
    sync_hold, update,
};

/// The `(type, _)` half of every key this module writes.
pub const ITEM_TYPE: &str = "canvas";

/// What desktop pushes for a canvas nobody has drawn on: `EMPTY_SCENE` in
/// `scene-file.ts`, canonicalized.
pub const EMPTY_SCENE: &str =
    r#"{"type":"excalidraw","version":2,"source":"memry","elements":[],"appState":{},"files":{}}"#;

/// Largest scene a canvas push may carry, in UTF-8 bytes
/// (`CANVAS_SCENE_SYNC_CAP_BYTES`, `apps/desktop/src/main/canvas/sync-bridge.ts:35`).
/// The payload embeds the scene as an escaped JSON string and the envelope
/// check multiplies by 1.37, so this keeps a capped scene under the 5 MB item
/// limit. A bigger scene saves locally and is held back from sync.
pub const CANVAS_SCENE_SYNC_CAP_BYTES: usize = 3_000_000;

/// Desktop's sidecar inside the `.excalidraw` file. Never part of a scene.
const FILE_META_KEY: &str = "memry";

/// One live canvas: its `canvases` row and the scene from its payload.
/// Instants are epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Canvas {
    pub id: String,
    pub title: Option<String>,
    /// Forward-slashed, relative to `canvases/`; `None` is the root.
    pub folder: Option<String>,
    pub icon: Option<String>,
    /// The note whose whiteboard block embeds this canvas, or `None` for a
    /// free-standing one.
    pub owner_note_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Excalidraw JSON, as stored. Empty when the payload carries no scene.
    pub scene: String,
}

/// What a new canvas carries.
#[derive(Debug, Clone, Copy, Default)]
pub struct NewCanvas<'a> {
    /// The id to create it under; `None` mints one. Desktop names the
    /// `.excalidraw` file, which carries the id, before the record exists.
    pub id: Option<&'a str>,
    pub title: Option<&'a str>,
    pub owner_note_id: Option<&'a str>,
    /// `None` or blank is an empty board.
    pub scene: Option<&'a str>,
    /// Where it is filed, already the on-disk spelling; refused past the depth
    /// cap ([`folder_paths::normalize_folder`]).
    pub folder: Option<&'a str>,
    pub icon: Option<&'a str>,
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

#[cfg(test)]
mod tests;
