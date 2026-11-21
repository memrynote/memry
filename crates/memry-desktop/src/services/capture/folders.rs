//! `/folders` and the folder routing of `/capture` (`apps/desktop/src/main/capture/folders.ts`).

use memry_core::domain::task_filter::locale_compare;
use sha2::{Digest, Sha256};

use super::CaptureFiler;
use crate::notes::error::NotesError;
use crate::notes::folders;
use crate::session::OpenVault;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderList {
    pub vault_id: String,
    pub vault_name: String,
    pub folders: Vec<String>,
}

/// The extension's opaque id of the vault at `path`: the first 32 hex characters of the
/// sha256 of the path string (`folders.ts:18-20`), so the absolute path never reaches extension
/// storage.
pub fn vault_id(path: &str) -> String {
    let mut hex = hex::encode(Sha256::digest(path.as_bytes()));
    hex.truncate(32);
    hex
}

/// `listCaptureFolders`: the notes tree's folders (`notes::folders::list`, the same visibility
/// filter as the sidebar), sorted as `localeCompare` sorts them.
pub fn list(open: &OpenVault) -> Result<FolderList, NotesError> {
    let mut folders: Vec<String> = folders::list(open)?
        .into_iter()
        .map(|folder| folder.path)
        .collect();
    folders.sort_by(|a, b| locale_compare(a, b));
    let path = open.path.to_string_lossy();
    Ok(FolderList {
        vault_id: vault_id(&path),
        vault_name: open
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        folders,
    })
}

/// Where a routed capture went: `filed_to` is the folder, or `None` with the reason it stayed
/// in the Inbox.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Routed {
    pub filed_to: Option<String>,
    pub reason: Option<&'static str>,
}

impl Routed {
    fn kept(reason: &'static str) -> Self {
        Self {
            filed_to: None,
            reason: Some(reason),
        }
    }
}

/// `routeCaptureToFolder`: files the capture only when `vault_id` is the open vault's and the
/// folder still exists, so a stale or foreign path never creates a folder. Any failure keeps
/// the capture in the Inbox. Blocking.
pub fn route(
    open: &OpenVault,
    filer: Option<&dyn CaptureFiler>,
    item_id: &str,
    folder: &str,
    vault_id: Option<&str>,
) -> Routed {
    let listed = match list(open) {
        Ok(listed) => listed,
        Err(error) => {
            tracing::warn!(
                scope = "Capture",
                item_id,
                "listing folders failed, kept in inbox: {error}"
            );
            return Routed::kept("file-failed");
        }
    };
    if Some(listed.vault_id.as_str()) != vault_id {
        return Routed::kept("vault-mismatch");
    }
    if !listed.folders.iter().any(|f| f == folder) {
        return Routed::kept("folder-missing");
    }
    let Some(filer) = filer else {
        tracing::warn!(
            scope = "Capture",
            item_id,
            "inbox filing is not available, kept in inbox"
        );
        return Routed::kept("file-failed");
    };
    match filer.file(open, item_id, folder) {
        Ok(()) => Routed {
            filed_to: Some(folder.to_owned()),
            reason: None,
        },
        Err(error) => {
            tracing::warn!(
                scope = "Capture",
                item_id,
                "filing capture failed, kept in inbox: {error}"
            );
            Routed::kept("file-failed")
        }
    }
}
