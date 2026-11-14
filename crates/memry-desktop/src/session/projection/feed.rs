//! The vault tier's facts as projection events, on the open vault's runtime: the Tauri
//! publisher Electron's write paths were (`publishProjectionEvent` after each note write).
//! Every note the tier writes, whoever wrote it (the app, the watcher, sync), reaches the
//! projectors this way. A fact that lands while no vault is open, or after the vault it named
//! closed, goes to no runtime or to one whose notes do not hold its id; projectors read the
//! note by id, so it changes nothing there.

use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::RecvError;

use super::ProjectionEvent;
use crate::session::Session;
use crate::vault::consumer::Applied;

/// The event a fact owes the projectors, if any.
pub fn event(fact: Applied) -> Option<ProjectionEvent> {
    match fact {
        Applied::Added { note_id, .. }
        | Applied::Changed { note_id, .. }
        | Applied::Renamed { note_id, .. }
        | Applied::LockRestored { note_id, .. } => {
            Some(ProjectionEvent::NoteFileChanged { note_id })
        }
        Applied::Removed { note_id, path, .. } => Some(ProjectionEvent::NoteDeleted {
            note_id,
            path: Some(path),
        }),
        Applied::Indexed { .. }
        | Applied::Vault(_)
        | Applied::JournalFollowed
        | Applied::OutsideEditKept { .. } => None,
    }
}

/// `event` on the open vault's runtime. Nothing when no vault is open: what the event owed is
/// still owed (the embedding lane's stored hashes), and the next open's reconcile pays it.
pub fn publish(session: &Session, event: ProjectionEvent) {
    if let Some(runtime) = session.projections() {
        runtime.publish(event);
    }
}

/// [`publish`]es each fact of `facts`, on its own thread, until the tier goes away. Missed
/// facts (a lagged subscription) make every lane reconcile, which recovers what a lane's
/// reconcile can see: the embedding lane's finds every note whose content hash moved.
pub fn watch(session: &Session, mut facts: Receiver<Applied>) -> std::io::Result<()> {
    let session = session.clone();
    std::thread::Builder::new()
        .name("projection-feed".into())
        .spawn(move || {
            loop {
                match facts.blocking_recv() {
                    Ok(fact) => {
                        if let Some(event) = event(fact) {
                            publish(&session, event);
                        }
                    }
                    Err(RecvError::Lagged(missed)) => {
                        tracing::warn!(missed, "projection feed missed vault facts; reconciling");
                        if let Some(runtime) = session.projections() {
                            runtime.repair();
                        }
                    }
                    Err(RecvError::Closed) => return,
                }
            }
        })
        .map(drop)
}
