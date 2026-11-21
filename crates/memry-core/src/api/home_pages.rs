//! Desktop's Home boards (`home-pages:*`), Step 30c (#3547): one object for
//! reads and writes, because every write ticks this device's clock. The rules
//! are [`crate::domain::home_page`]'s. Not on the FFI surface: the phone has
//! no Home boards.

use std::sync::Arc;

use serde_json::Value;

use crate::api::errors::{AuthError, StorageError};
use crate::crypto::keys;
use crate::domain::home_page::cover::{self, FramingChanges};
use crate::domain::home_page::{self, HomePage, HomePagePatch, NewHomePage};
use crate::seams::secure_store::{SecureStore, SecureStoreKey};
use crate::storage::Db;

/// What [`HomePages::update`] changes; `None` keeps a field. `cover:
/// Some(None)` removes the cover.
#[derive(Debug, Clone, Default)]
pub struct BoardChanges {
    pub name: Option<String>,
    pub icon: Option<String>,
    pub position: Option<f64>,
    /// JSON array text.
    pub widgets: Option<String>,
    pub cover: Option<Option<Value>>,
}

/// Home board reads and writes over one opened vault.
pub struct HomePages {
    db: Db,
    device_id: String,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

impl HomePages {
    /// Built by [`crate::api::vault::Vault::home_pages`]. The device id is
    /// derived from the keychain's signing key exactly as `NotesWriter` does.
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
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
            device_id: keys::local_device_id_hex(public)?,
        })
    }

    /// Every live board in the order every device agrees on.
    pub fn list(&self) -> Result<Vec<HomePage>, StorageError> {
        self.db.read_blocking(home_page::list)
    }

    pub fn get(&self, id: String) -> Result<Option<HomePage>, StorageError> {
        self.db.read_blocking(move |conn| home_page::get(conn, &id))
    }

    /// Creates a board with no cover.
    pub fn create(
        &self,
        name: String,
        icon: Option<String>,
        position: f64,
        widgets: String,
    ) -> Result<HomePage, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let board = NewHomePage {
                name: &name,
                icon: icon.as_deref(),
                position,
                widgets: &widgets,
                cover: None,
            };
            home_page::create(conn, &board, &device_id, now_ms())
        })
    }

    pub fn update(&self, id: String, changes: BoardChanges) -> Result<HomePage, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let patch = HomePagePatch {
                name: changes.name.as_deref(),
                icon: changes.icon.as_deref().map(Some),
                position: changes.position,
                widgets: changes.widgets.as_deref(),
                cover: changes.cover.as_ref().map(Option::as_ref),
            };
            home_page::update(conn, &id, &patch, &device_id, now_ms())
        })
    }

    /// `false` when no live board had the id.
    pub fn delete(&self, id: String) -> Result<bool, StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| home_page::delete(conn, &id, &device_id, now_ms()))
    }

    /// The ids of the boards that moved.
    pub fn reorder(&self, ids: Vec<String>) -> Result<Vec<String>, StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| home_page::reorder(conn, &ids, &device_id, now_ms()))
    }

    pub fn set_cover_framing(
        &self,
        id: String,
        changes: FramingChanges,
    ) -> Result<HomePage, StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| cover::set_framing(conn, &id, changes, &device_id, now_ms()))
    }
}
