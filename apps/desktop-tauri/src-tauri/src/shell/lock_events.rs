//! The lock events: [`VaultLocksChangedEvent`] at every open (Electron's `checkLockedFilesAtOpen`
//! sends the state), so the windows show the opened vault's locks, and
//! [`VaultLocksExternalEditRestoredEvent`] for each locked note's outside change the vault tier
//! wrote the locked text back over ([`Applied::LockRestored`]).

use memry_desktop::notes::read;
use memry_desktop::session::{OpenVault, Session};
use memry_desktop::vault::consumer::Applied;
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::RecvError;

use crate::commands::vault_locks::VaultLockStateView;
use crate::events::{VaultLocksChangedEvent, VaultLocksExternalEditRestoredEvent, broadcast};

const SCOPE: &str = "vault_locks";

/// Generic over the runtime so a test drives it on a mock app.
pub fn forward<R: Runtime>(app: AppHandle<R>, mut facts: Receiver<Applied>) {
    std::thread::spawn(move || {
        loop {
            match facts.blocking_recv() {
                Ok(Applied::LockRestored { note_id, path }) => restored(&app, note_id, path),
                Ok(_) => {}
                // A missed notice is only a toast: the version holds the outside text.
                Err(RecvError::Lagged(missed)) => {
                    tracing::warn!(scope = SCOPE, missed, "lock notices were dropped");
                }
                Err(RecvError::Closed) => return,
            }
        }
    });
}

fn restored<R: Runtime>(app: &AppHandle<R>, note_id: String, path: String) {
    let open = app.state::<Session>().current();
    let item = open.and_then(|open| read::list_item(&open, &note_id).ok().flatten());
    let title = match item {
        Some(note) => note.title,
        None => path.clone(),
    };
    broadcast(
        app,
        VaultLocksExternalEditRestoredEvent {
            note_id,
            path,
            title,
        },
    );
}

/// The open vault's locks, to every window.
pub fn opened<R: Runtime>(app: &AppHandle<R>, open: &OpenVault) {
    match open.vault.locks().list() {
        Ok(state) => broadcast(
            app,
            VaultLocksChangedEvent::from(VaultLockStateView::from(state)),
        ),
        Err(error) => tracing::warn!(scope = SCOPE, "the locks were not read: {error}"),
    }
}
