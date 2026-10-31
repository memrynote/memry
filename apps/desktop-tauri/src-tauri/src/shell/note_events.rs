//! The note events (`notes:created`, `notes:updated`, `notes:deleted`), from the vault tier's
//! row facts: the one place they are emitted. A fact names who caused it, so the app's create
//! and delete and the watcher's reports go out the same way with their `source`. Two kinds of
//! fact emit nothing:
//! - the app's own writes of a body (`Changed` by the app): Electron's write-back is `sync`,
//!   which the renderer ignores;
//! - what the open walk found (`ChangeSource::Walk`): Electron's open-time index sends no note
//!   events either, and the index pass after the walk reports progress, on which the renderer
//!   refetches its lists (`use-notes-query.ts`). A first open of a large vault would otherwise
//!   send one event, and one read, per file.
//!
//! Renames and moves are Step 13g's.

use memry_desktop::notes::read;
use memry_desktop::session::Session;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use tauri::{AppHandle, Manager, Wry};
use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::RecvError;

use crate::events::{
    NoteCreatedEvent, NoteDeletedEvent, NoteEventSource, NoteUpdatedEvent, broadcast,
};

pub fn forward(app: AppHandle<Wry>, mut facts: Receiver<Applied>) {
    std::thread::spawn(move || {
        loop {
            match facts.blocking_recv() {
                Ok(fact) => emit(&app, fact),
                // The lists refetch on the next event; nothing replays the missed ones.
                Err(RecvError::Lagged(missed)) => {
                    tracing::warn!(scope = "notes", missed, "note events were dropped");
                }
                Err(RecvError::Closed) => return,
            }
        }
    });
}

/// What a fact sends; a new note is read for its list item first.
#[derive(Debug, PartialEq, Eq)]
enum Outgoing {
    Created {
        note_id: String,
        source: NoteEventSource,
    },
    Updated(NoteUpdatedEvent),
    Deleted(NoteDeletedEvent),
}

fn emit(app: &AppHandle<Wry>, fact: Applied) {
    match outgoing(fact) {
        Some(Outgoing::Created { note_id, source }) => {
            let Some(open) = app.state::<Session>().current() else {
                return;
            };
            match read::list_item(&open, &note_id) {
                Ok(Some(note)) => broadcast(app, NoteCreatedEvent { note, source }),
                // Gone again before it could be read: its removal follows.
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(scope = "notes", note_id, "a new note was not read: {error}");
                }
            }
        }
        Some(Outgoing::Updated(event)) => broadcast(app, event),
        Some(Outgoing::Deleted(event)) => broadcast(app, event),
        None => {}
    }
}

fn outgoing(fact: Applied) -> Option<Outgoing> {
    match fact {
        Applied::Added {
            note_id, source, ..
        } if source != ChangeSource::Walk => Some(Outgoing::Created {
            note_id,
            source: source_of(source),
        }),
        Applied::Changed {
            note_id,
            source: ChangeSource::Watcher,
            ..
        } => Some(Outgoing::Updated(NoteUpdatedEvent {
            id: note_id,
            changes: serde_json::Map::new(),
            source: NoteEventSource::External,
        })),
        Applied::Removed {
            note_id,
            path,
            source,
        } if source != ChangeSource::Walk => Some(Outgoing::Deleted(NoteDeletedEvent {
            id: note_id,
            path,
            source: source_of(source),
        })),
        _ => None,
    }
}

fn source_of(source: ChangeSource) -> NoteEventSource {
    match source {
        ChangeSource::App => NoteEventSource::Internal,
        ChangeSource::Watcher | ChangeSource::Walk => NoteEventSource::External,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn added(source: ChangeSource) -> Applied {
        Applied::Added {
            note_id: "n".into(),
            path: "a.md".into(),
            created: true,
            source,
        }
    }

    fn changed(source: ChangeSource) -> Applied {
        Applied::Changed {
            note_id: "n".into(),
            path: "a.md".into(),
            content_hash: None,
            source,
        }
    }

    fn removed(source: ChangeSource) -> Applied {
        Applied::Removed {
            note_id: "n".into(),
            path: "a.md".into(),
            source,
        }
    }

    #[test]
    fn the_app_and_the_watcher_send_note_events_and_the_open_walk_sends_none() {
        let created = |source| {
            Some(Outgoing::Created {
                note_id: "n".into(),
                source,
            })
        };
        let deleted = |source| {
            Some(Outgoing::Deleted(NoteDeletedEvent {
                id: "n".into(),
                path: "a.md".into(),
                source,
            }))
        };
        assert_eq!(
            outgoing(added(ChangeSource::App)),
            created(NoteEventSource::Internal)
        );
        assert_eq!(
            outgoing(added(ChangeSource::Watcher)),
            created(NoteEventSource::External)
        );
        assert_eq!(
            outgoing(removed(ChangeSource::App)),
            deleted(NoteEventSource::Internal)
        );
        assert_eq!(
            outgoing(removed(ChangeSource::Watcher)),
            deleted(NoteEventSource::External)
        );
        assert_eq!(
            outgoing(changed(ChangeSource::Watcher)),
            Some(Outgoing::Updated(NoteUpdatedEvent {
                id: "n".into(),
                changes: serde_json::Map::new(),
                source: NoteEventSource::External,
            }))
        );
        // The app's own write-back is `sync` in Electron, which the renderer ignores.
        assert_eq!(outgoing(changed(ChangeSource::App)), None);
        // The open walk's notes reach the lists through the index's progress instead.
        assert_eq!(outgoing(added(ChangeSource::Walk)), None);
        assert_eq!(outgoing(changed(ChangeSource::Walk)), None);
        assert_eq!(outgoing(removed(ChangeSource::Walk)), None);
    }
}
