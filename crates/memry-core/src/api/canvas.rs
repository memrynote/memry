//! `Canvases`: whiteboard reads and writes for one opened vault.
//!
//! One object for both, like [`crate::api::tasks::Tasks`], because every write
//! ticks this device's clock and a canvas carries the vault's id
//! ([`crate::domain::canvas`]). The rules live in the domain; this file is the
//! FFI shape.

use std::sync::Arc;

use crate::api::errors::{AuthError, StorageError};
use crate::crypto::keys;
use crate::domain::canvas::{self, CanvasEdit, NewCanvas, Updated};
use crate::seams::secure_store::{SecureStore, SecureStoreKey};
use crate::storage::Db;

/// One live canvas.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CanvasRecord {
    pub id: String,
    pub title: Option<String>,
    /// The note whose whiteboard block embeds this canvas.
    pub owner_note_id: Option<String>,
    /// Excalidraw JSON in desktop's canonical form.
    pub scene: String,
    /// The scene's size in bytes when it is over the sync cap: the canvas is
    /// saved on this device and held back from sync until it shrinks. `nil`
    /// when it syncs.
    #[uniffi(default = None)]
    pub sync_held_bytes: Option<u64>,
}

impl From<canvas::Canvas> for CanvasRecord {
    fn from(canvas: canvas::Canvas) -> Self {
        let sync_held_bytes = match canvas::sync_hold(&canvas.scene) {
            canvas::SyncHold::Queued => None,
            canvas::SyncHold::TooLarge { bytes } => Some(bytes as u64),
        };
        Self {
            id: canvas.id,
            title: canvas.title,
            owner_note_id: canvas.owner_note_id,
            scene: canvas.scene,
            sync_held_bytes,
        }
    }
}

/// The canvas surface over one opened vault.
#[derive(uniffi::Object)]
pub struct Canvases {
    db: Db,
    vault_id: String,
    device_id: String,
}

impl Canvases {
    /// Built by [`crate::api::vault::Vault::canvases`]. The device id is
    /// derived from the keychain's signing key exactly as `NotesWriter` does.
    pub(crate) fn over(
        db: Db,
        vault_id: String,
        store: &Arc<dyn SecureStore>,
    ) -> Result<Self, AuthError> {
        let secret =
            store
                .get(SecureStoreKey::DeviceSigningKey)?
                .ok_or(AuthError::MalformedToken {
                    what: "this device has no signing key, so it has no identity to write under"
                        .to_string(),
                })?;
        let public = secret.get(32..64).ok_or(AuthError::MalformedToken {
            what: "device signing key is not 64 bytes".to_string(),
        })?;
        Ok(Self {
            db,
            vault_id,
            device_id: keys::local_device_id_hex(public)?,
        })
    }
}

/// Desktop's file service writes through [`crate::domain::canvas`] with these,
/// so the `.excalidraw` file and the record change in one writer call.
impl Canvases {
    pub fn db(&self) -> &Db {
        &self.db
    }

    pub fn vault_id(&self) -> &str {
        &self.vault_id
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }
}

#[uniffi::export]
impl Canvases {
    /// Creates a canvas and returns it. `scene` is Excalidraw JSON, or `nil`
    /// for an empty board; it is stored in desktop's canonical form.
    pub fn create(
        &self,
        title: Option<String>,
        owner_note_id: Option<String>,
        scene: Option<String>,
    ) -> Result<CanvasRecord, StorageError> {
        let vault_id = self.vault_id.clone();
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let canvas = NewCanvas {
                title: title.as_deref(),
                owner_note_id: owner_note_id.as_deref(),
                scene: scene.as_deref(),
                ..NewCanvas::default()
            };
            Ok(
                canvas::create(conn, &canvas, &vault_id, &device_id, now_ms())?
                    .canvas
                    .into(),
            )
        })
    }

    /// Replaces a canvas's scene. Fails with `NotFound` for a deleted canvas.
    /// A scene over the sync cap is saved here and held back from sync, and
    /// the record names its size (`sync_held_bytes`).
    pub fn set_scene(&self, id: String, scene: String) -> Result<CanvasRecord, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let edit = CanvasEdit {
                scene: Some(&scene),
                ..CanvasEdit::default()
            };
            match canvas::update(conn, &id, &edit, &device_id, now_ms())? {
                Updated::Saved(saved) => Ok(saved.canvas.into()),
                // Unreachable: the edit names no `expected_updated_at`.
                Updated::Conflict => Err(StorageError::Failed {
                    what: format!("canvas {id} reported a conflict it was not asked to check"),
                }),
            }
        })
    }

    /// One live canvas, or `nil` when it is deleted or has not synced yet.
    pub fn canvas(&self, id: String) -> Result<Option<CanvasRecord>, StorageError> {
        self.db
            .read_blocking(move |conn| Ok(canvas::get(conn, &id)?.map(CanvasRecord::from)))
    }
}

/// Wall clock, in epoch milliseconds (data-model §A.6).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::canvas::CANVAS_SCENE_SYNC_CAP_BYTES;

    fn record(scene_len: usize) -> CanvasRecord {
        CanvasRecord::from(canvas::Canvas {
            id: "c1".to_owned(),
            title: None,
            folder: None,
            icon: None,
            owner_note_id: None,
            created_at: 0,
            updated_at: 0,
            scene: "x".repeat(scene_len),
        })
    }

    /// The shell learns a canvas stopped syncing from the record it gets back.
    #[test]
    fn a_record_names_the_size_of_a_scene_held_back_from_sync() {
        assert_eq!(record(CANVAS_SCENE_SYNC_CAP_BYTES).sync_held_bytes, None);
        assert_eq!(
            record(CANVAS_SCENE_SYNC_CAP_BYTES + 1).sync_held_bytes,
            Some(CANVAS_SCENE_SYNC_CAP_BYTES as u64 + 1)
        );
    }
}
