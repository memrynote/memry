//! Read-only locks (`vault-locks:list`, `vault-locks:set` of `ipc/vault-lock-handlers.ts`), each
//! one call of `memry_desktop::locks`. A lock change that wrote something sends
//! [`VaultLocksChangedEvent`], as every open does; a field rename the lock held that resumed
//! after an unlock sends [`NoteTagsChangedEvent`].

use memry_desktop::locks::{self, LockState, TargetKind};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use super::blocking;
use super::error::CommandError;
use super::notes::{failed, open_vault, service};
use crate::events::{NoteTagsChangedEvent, VaultLocksChangedEvent, broadcast};

/// What a lock covers (`VaultLockTargetKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum VaultLockKind {
    Note,
    Folder,
}

/// `VaultLockSetInput`: a note by id or a folder by vault-relative path.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultLockSetInput {
    pub kind: VaultLockKind,
    pub target: String,
    pub locked: bool,
}

/// `VaultLockState`: every locked note id and folder path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultLockStateView {
    pub notes: Vec<String>,
    pub folders: Vec<String>,
}

impl From<LockState> for VaultLockStateView {
    fn from(state: LockState) -> Self {
        Self {
            notes: state.notes,
            folders: state.folders,
        }
    }
}

/// `vault-locks:list`.
#[tauri::command]
#[specta::specta]
pub async fn vault_locks_list<R: Runtime>(
    app: AppHandle<R>,
) -> Result<VaultLockStateView, CommandError> {
    blocking("vault_locks_list", move || {
        let open = open_vault(&app)?;
        let state = open
            .vault
            .locks()
            .list()
            .map_err(|error| CommandError::from_core(&error))?;
        Ok(state.into())
    })
    .await
}

/// `vault-locks:set`: locks or unlocks, brings the files in line, and tells every window.
// Generic over the runtime so a test drives it on a mock app (`tests/vault_locks.rs`).
#[tauri::command]
#[specta::specta]
pub async fn vault_locks_set<R: Runtime>(
    app: AppHandle<R>,
    input: VaultLockSetInput,
) -> Result<VaultLockStateView, CommandError> {
    blocking("vault_locks_set", move || {
        let open = open_vault(&app)?;
        let kind = match input.kind {
            VaultLockKind::Note => TargetKind::Note,
            VaultLockKind::Folder => TargetKind::Folder,
        };
        let renamed = app.clone();
        let set = locks::set(
            &open,
            &service(&app)?,
            kind,
            &input.target,
            input.locked,
            move || broadcast(&renamed, NoteTagsChangedEvent),
        )
        .map_err(|error| failed(&error))?;
        let state = VaultLockStateView::from(set.state);
        if set.changed {
            broadcast(&app, VaultLocksChangedEvent::from(state.clone()));
        }
        Ok(state)
    })
    .await
}
