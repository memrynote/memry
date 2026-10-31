//! `vault:reindex`: measures every note of the open vault again
//! (`memry_desktop::notes::index`), with its progress as [`VaultIndexProgressEvent`].

use std::sync::Arc;

use memry_desktop::notes::index::{IndexError, NoteIndex};
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use crate::events::{VaultIndexProgressEvent, broadcast};

/// Measures every note of the open vault again; resolves once the last progress went out.
#[tauri::command]
#[specta::specta]
pub async fn vault_reindex(app: AppHandle<Wry>) -> Result<(), CommandError> {
    let index = app
        .try_state::<Arc<NoteIndex>>()
        .map(|state| state.inner().clone());
    blocking("vault_reindex", move || {
        let index = index.ok_or_else(not_open)?;
        index
            .reindex(move |step| broadcast(&app, VaultIndexProgressEvent::from(step)))
            .map(drop)
            .map_err(|error| match error {
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

fn not_open() -> CommandError {
    CommandError::new(ErrorKind::NotFound, "no_vault_open", "No vault is open")
}
