//! `Canvases`: whiteboard reads and writes for one opened vault.
//!
//! One object for both, like [`crate::api::tasks::Tasks`], because every write
//! ticks this device's clock and a canvas carries the vault's id
//! ([`crate::domain::canvas`]). The rules live in the domain; this file is the
//! FFI shape.

use std::sync::Arc;

use crate::api::errors::{AuthError, StorageError};
use crate::crypto::keys;
use crate::domain::canvas::{self, NewCanvas};
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
}

impl From<canvas::Canvas> for CanvasRecord {
    fn from(canvas: canvas::Canvas) -> Self {
        Self {
            id: canvas.id,
            title: canvas.title,
            owner_note_id: canvas.owner_note_id,
            scene: canvas.scene,
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
            };
            Ok(
                canvas::create(conn, &canvas, &vault_id, &device_id, now_ms())?
                    .acknowledge()
                    .into(),
            )
        })
    }

    /// Replaces a canvas's scene. Fails with `NotFound` for a deleted canvas.
    pub fn set_scene(&self, id: String, scene: String) -> Result<CanvasRecord, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            Ok(canvas::set_scene(conn, &id, &scene, &device_id, now_ms())?
                .acknowledge()
                .into())
        })
    }

    /// One live canvas, or `nil` when it is deleted or has not synced yet.
    pub fn canvas(&self, id: String) -> Result<Option<CanvasRecord>, StorageError> {
        self.db
            .call_blocking(move |conn| Ok(canvas::get(conn, &id)?.map(CanvasRecord::from)))
    }
}

/// Wall clock, in epoch milliseconds (data-model §A.6).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}
