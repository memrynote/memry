//! The custom icon library (`ipc/custom-icon-handlers.ts`): images a person adds for notes,
//! folders and tags, by upload or by link.
//!
//! Three owners, one direction. The core's `custom_icon` record is the icon (its bytes ride in the
//! payload, no table: decided with Kaan, chapter 13 §13.7.11). `vault::icons::write_icon` is the
//! only writer of the `.memry/icons/<id>.<ext>` mirror the renderer loads, and it sanitizes every
//! SVG. This module orders the two and normalizes what comes in ([`normalize`]).
//!
//! - **Add**: normalize, then the record (the core mints the id), then the file. A file that fails
//!   to write is logged and left to [`Library::list`], because the record is already committed and queued.
//! - **List** writes the file of every icon that has none (an icon pulled from a peer, a deleted
//!   file), as Electron's `custom-icons:list` did: it is the one call every icon consumer makes
//!   before rendering. A write that fails is logged and the icon is still listed.
//! - **Delete** removes the record, then the file.
//!
//! Every function blocks (SQLite, decoding, files); an async caller runs it on a blocking thread.

mod normalize;
mod remote;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::{AuthError, StorageError};
use memry_core::domain::custom_icons::{CustomIcon, CustomIconStore, STORED_EXTENSIONS};
use memry_core::seams::secure_store::SecureStore;
use serde::Serialize;

use crate::session::OpenVault;

use crate::vault::icons::{icon_exists, icon_path, remove_icon, write_icon};

pub use normalize::{
    MAX_DECODED_BYTES, MAX_EDGE_PX, MAX_INPUT_BYTES, MAX_PIXELS, Normalized, normalize,
};
pub use remote::{DOWNLOAD_TIMEOUT, RemoteIcon, download, download_within, name_from_url};

/// Why an icon could not be added. Each variant but `Storage` has a user-facing text under
/// `errors:customIcon.*` ([`CustomIconError::message_key`]).
#[derive(Debug, thiserror::Error)]
pub enum CustomIconError {
    #[error("the image could not be read")]
    Unreadable,
    #[error("the image is empty or larger than {MAX_INPUT_BYTES} bytes")]
    TooLarge,
    #[error("the link is not an http or https address")]
    InvalidUrl,
    #[error("the image could not be downloaded")]
    Download { timed_out: bool },
    #[error("the link is not a PNG, JPG, GIF, WEBP or SVG image")]
    UnsupportedUrl,
    #[error(transparent)]
    Storage(#[from] StorageError),
}

impl CustomIconError {
    /// The `errors` namespace key of the text the picker shows.
    pub fn message_key(&self) -> Option<&'static str> {
        Some(match self {
            Self::Unreadable => "errors:customIcon.unreadableImage",
            Self::TooLarge => "errors:customIcon.tooLarge",
            Self::InvalidUrl => "errors:customIcon.invalidUrl",
            Self::Download { .. } => "errors:customIcon.downloadFailed",
            Self::UnsupportedUrl => "errors:customIcon.unsupportedUrl",
            Self::Storage(_) => return None,
        })
    }
}

/// One icon as the renderer sees it (`CustomIconSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CustomIconView {
    pub id: String,
    pub name: String,
    /// `png` or `svg`.
    pub ext: String,
    /// The absolute path of the file under `<vault>/.memry/icons`.
    pub path: String,
    /// Empty when a peer's record carries none.
    pub created_at: String,
}

fn view(vault: &Path, icon: CustomIcon) -> Option<CustomIconView> {
    // A record can come from a peer: an extension this build does not render, or an id that is
    // not a plain file name, is skipped and its record left for a build that understands it.
    if !STORED_EXTENSIONS.contains(&icon.ext.as_str()) {
        tracing::warn!(scope = "CustomIcons", id = %icon.id, ext = %icon.ext, "skipped a custom icon with an unsupported extension");
        return None;
    }
    let path = match icon_path(vault, &icon.id, &icon.ext) {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!(scope = "CustomIcons", "skipped a custom icon: {error}");
            return None;
        }
    };
    if !icon_exists(vault, &icon.id, &icon.ext) {
        let written = STANDARD
            .decode(&icon.data)
            .map_err(|error| error.to_string())
            .and_then(|bytes| {
                write_icon(vault, &icon.id, &icon.ext, &bytes).map_err(|e| e.to_string())
            });
        if let Err(error) = written {
            tracing::warn!(scope = "CustomIcons", id = %icon.id, "a custom icon's file could not be rebuilt: {error}");
        }
    }
    Some(CustomIconView {
        path: path.to_string_lossy().into_owned(),
        created_at: icon.created_at.unwrap_or_default(),
        id: icon.id,
        name: icon.name,
        ext: icon.ext,
    })
}

/// The icon library of one open vault.
pub struct Library {
    vault: PathBuf,
    icons: CustomIconStore,
}

impl Library {
    pub fn new(vault: PathBuf, icons: CustomIconStore) -> Self {
        Self { vault, icons }
    }

    /// The library of `open`, written under the device identity in `store` (minted on the first
    /// synced write of a profile; sign-in reuses it).
    pub fn open(open: &OpenVault, store: Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        ensure_device_identity(store.clone())?;
        Ok(Self::new(
            open.path.clone(),
            open.vault.custom_icons(store)?,
        ))
    }

    /// Every icon, oldest first, each with its file on disk.
    pub fn list(&self) -> Result<Vec<CustomIconView>, StorageError> {
        let found = self.icons.list()?;
        if !found.skipped.is_empty() {
            tracing::warn!(scope = "CustomIcons", skipped = ?found.skipped, "custom icon records that could not be read were skipped");
        }
        Ok(found
            .icons
            .into_iter()
            .filter_map(|icon| view(&self.vault, icon))
            .collect())
    }

    fn listed(&self, id: &str) -> Result<CustomIconView, StorageError> {
        self.list()?
            .into_iter()
            .find(|icon| icon.id == id)
            .ok_or_else(|| StorageError::NotFound {
                what: format!("custom icon {id}"),
            })
    }

    /// Adds the icon `bytes` hold, sent as `ext` (an input extension), under `name`.
    pub fn add(
        &self,
        bytes: &[u8],
        ext: &str,
        name: &str,
        now_ms: i64,
    ) -> Result<CustomIconView, CustomIconError> {
        let normalized = normalize(bytes, ext)?;
        let data = STANDARD.encode(&normalized.bytes);
        let id = self.icons.create(name, normalized.ext, &data, now_ms)?;
        if let Err(error) = write_icon(&self.vault, &id, normalized.ext, &normalized.bytes) {
            tracing::warn!(scope = "CustomIcons", id = %id, "a new custom icon's file could not be written: {error}");
        }
        Ok(self.listed(&id)?)
    }

    /// Renames a live icon.
    pub fn rename(
        &self,
        id: &str,
        name: &str,
        now_ms: i64,
    ) -> Result<CustomIconView, StorageError> {
        self.icons.rename(id, name, now_ms)?;
        self.listed(id)
    }

    /// Deletes an icon and its file. `false` when there was no live icon `id` (`{ success: false }`).
    pub fn delete(&self, id: &str, now_ms: i64) -> Result<bool, StorageError> {
        let ext = self
            .icons
            .list()?
            .icons
            .into_iter()
            .find(|icon| icon.id == id)
            .map(|icon| icon.ext);
        match self.icons.delete(id, now_ms) {
            Err(StorageError::NotFound { .. }) => return Ok(false),
            other => other?,
        }
        if let Some(ext) = ext
            && let Err(error) = remove_icon(&self.vault, id, &ext)
        {
            tracing::warn!(scope = "CustomIcons", id = %id, "a deleted custom icon's file could not be removed: {error}");
        }
        Ok(true)
    }
}
