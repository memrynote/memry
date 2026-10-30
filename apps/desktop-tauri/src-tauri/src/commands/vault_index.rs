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
            .reindex(|step| {
                broadcast(
                    &app,
                    VaultIndexProgressEvent {
                        index_built: step.built as u32,
                        index_total: step.total as u32,
                    },
                );
            })
            .map(drop)
            .map_err(|error| match error {
                IndexError::NotOpen => not_open(),
                IndexError::Storage(error) => CommandError::from_core(&error),
            })
    })
    .await
}

fn not_open() -> CommandError {
    CommandError::new(ErrorKind::NotFound, "no_vault_open", "No vault is open")
}
