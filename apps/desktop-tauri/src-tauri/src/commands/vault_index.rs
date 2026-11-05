//! `vault:reindex`: measures every note of the open vault again
//! (`memry_desktop::notes::index`), with its progress as [`VaultIndexProgressEvent`] and the
//! vault status indexing until it answers, as Electron's `reindex` reports it.

use std::sync::Arc;

use memry_desktop::notes::index::{IndexError, NoteIndex};
use memry_desktop::session::response::VaultStatus;
use memry_desktop::session::{Session, SessionStatus};
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use crate::events::{VaultIndexProgressEvent, VaultStatusChangedEvent, broadcast};

/// Measures every note of the open vault again; resolves once the last progress went out.
/// Each step and the answer also send the vault status, which says whether it is indexing.
#[tauri::command]
#[specta::specta]
pub async fn vault_reindex(app: AppHandle<Wry>) -> Result<(), CommandError> {
    let index = app
        .try_state::<Arc<NoteIndex>>()
        .map(|state| state.inner().clone());
    blocking("vault_reindex", move || {
        let index = index.ok_or_else(not_open)?;
        let reporter = app.clone();
        let reindexed = index.reindex(move |step| {
            broadcast(&reporter, VaultIndexProgressEvent::from(step));
            broadcast(
                &reporter,
                VaultStatusChangedEvent(current_status(&reporter)),
            );
        });
        broadcast(&app, VaultStatusChangedEvent(current_status(&app)));
        reindexed.map(drop).map_err(|error| match error {
            IndexError::NotOpen => not_open(),
            IndexError::NotRunning => CommandError::new(
                ErrorKind::Internal,
                "note_index_not_running",
                "The note index is not running for this vault. Reopen the vault to start it",
            ),
            IndexError::Storage(error) => CommandError::from_core(&error),
        })
    })
    .await
}

/// `status` as the renderer reads it: indexing while a reindex runs.
pub fn vault_status(app: &AppHandle<Wry>, status: SessionStatus) -> VaultStatus {
    let reindexing = app
        .try_state::<Arc<NoteIndex>>()
        .and_then(|index| index.reindexing());
    VaultStatus::from(status).with_indexing(reindexing)
}

fn current_status(app: &AppHandle<Wry>) -> VaultStatus {
    vault_status(app, app.state::<Session>().status())
}

fn not_open() -> CommandError {
    CommandError::new(ErrorKind::NotFound, "no_vault_open", "No vault is open")
}
