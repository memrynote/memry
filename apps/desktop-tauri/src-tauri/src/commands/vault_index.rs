//! `vault:reindex`: measures every note of the open vault again
//! (`memry_desktop::notes::index`), with its progress as [`VaultIndexProgressEvent`]. The vault
//! status says indexing while it runs, as during an open's build, through [`vault_status`] and
//! the index's report ([`send_indexing_status`]).

use std::sync::{Arc, Mutex, PoisonError};

use memry_desktop::notes::index::{IndexError, IndexProgress, NoteIndex};
use memry_desktop::session::response::VaultStatus;
use memry_desktop::session::{Session, SessionStatus};
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use crate::events::{VaultIndexProgressEvent, VaultStatusChangedEvent, broadcast};

/// Measures every note of the open vault again; resolves once the last progress went out.
/// The index sends the vault status, indexing, from the request to the answer.
#[tauri::command]
#[specta::specta]
pub async fn vault_reindex(app: AppHandle<Wry>) -> Result<(), CommandError> {
    let index = app
        .try_state::<Arc<NoteIndex>>()
        .map(|state| state.inner().clone());
    blocking("vault_reindex", move || {
        let index = index.ok_or_else(not_open)?;
        let reindexed =
            index.reindex(move |step| broadcast(&app, VaultIndexProgressEvent::from(step)));
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

/// `status` as the renderer reads it: indexing while an open's build or a reindex runs.
pub fn vault_status(app: &AppHandle<Wry>, status: SessionStatus) -> VaultStatus {
    VaultStatus::from(status).with_indexing(indexing(app))
}

/// Every status send reads the index and broadcasts under this lock. The session's forwarder,
/// the index task and a reindex's asker send from their own threads: without it, one that read
/// "indexing" could broadcast after one that read it cleared, and the window keeps the stale one.
static SENDING: Mutex<()> = Mutex::new(());

/// The session's `StatusChanged`, with what the index does.
pub fn send_status(app: &AppHandle<Wry>, status: SessionStatus) {
    let _sending = SENDING.lock().unwrap_or_else(PoisonError::into_inner);
    broadcast(app, VaultStatusChangedEvent(vault_status(app, status)));
}

/// The note index's [`IndexReport::Indexing`](memry_desktop::notes::index::IndexReport): the
/// vault status again, unless no vault is open or the app quits ([`VaultStatus::resend`]).
pub fn send_indexing_status(app: &AppHandle<Wry>) {
    let Some(session) = app.try_state::<Session>() else {
        return;
    };
    let _sending = SENDING.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(status) = VaultStatus::resend(&session, indexing(app)) {
        broadcast(app, VaultStatusChangedEvent(status));
    }
}

fn indexing(app: &AppHandle<Wry>) -> Option<IndexProgress> {
    app.try_state::<Arc<NoteIndex>>()
        .and_then(|index| index.indexing())
}

fn not_open() -> CommandError {
    CommandError::new(ErrorKind::NotFound, "no_vault_open", "No vault is open")
}
