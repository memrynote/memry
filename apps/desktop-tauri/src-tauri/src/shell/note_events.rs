//! The note events (`notes:created`, `notes:updated`, `notes:deleted`, `notes:renamed`), from the vault tier's
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
//! A created note is read for its list item, an outside edit for the fields it may have changed
//! ([`NoteView::changes`]). Facts missed because this thread fell behind are made up for with
//! one [`NoteEventsDroppedEvent`], on which the renderer refetches what it shows.
//!
//! A renamed or moved note is read for the title it has now. The app's move to another folder
//! sends `notes:moved` instead once `notes:move` is exposed (Step 13g-3); until then every
//! `Renamed` fact is a rename, the app's or an outside move, which Electron's watcher also
//! sends as `notes:renamed`.

use memry_desktop::notes::read;
use memry_desktop::notes::view::NoteView;
use memry_desktop::session::Session;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::RecvError;

use crate::events::{
    NoteCreatedEvent, NoteDeletedEvent, NoteEventSource, NoteEventsDroppedEvent, NoteRenamedEvent,
    NoteUpdatedEvent, broadcast,
};

/// Generic over the runtime so a test drives it on a mock app.
pub fn forward<R: Runtime>(app: AppHandle<R>, mut facts: Receiver<Applied>) {
    std::thread::spawn(move || {
        loop {
            match facts.blocking_recv() {
                Ok(fact) => emit(&app, fact),
                // Nothing replays the missed facts: the renderer refetches instead.
                Err(RecvError::Lagged(missed)) => {
                    tracing::warn!(scope = "notes", missed, "note events were dropped");
                    broadcast(&app, NoteEventsDroppedEvent);
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
    Updated {
        note_id: String,
    },
    Deleted(NoteDeletedEvent),
    Renamed {
        note_id: String,
        old_path: String,
        new_path: String,
    },
}

fn emit<R: Runtime>(app: &AppHandle<R>, fact: Applied) {
    let Some(outgoing) = outgoing(fact) else {
        return;
    };
    if let Outgoing::Deleted(event) = outgoing {
        return broadcast(app, event);
    }
    let Some(open) = app.state::<Session>().current() else {
        return;
    };
    match outgoing {
        Outgoing::Created { note_id, source } => match read::list_item(&open, &note_id) {
            Ok(Some(note)) => broadcast(app, NoteCreatedEvent { note, source }),
            // Gone again before it could be read: its removal follows.
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(scope = "notes", note_id, "a new note was not read: {error}");
            }
        },
        Outgoing::Updated { note_id } => match read::get(&open, &note_id, None) {
            Ok(Some(note)) => broadcast(app, updated(&note)),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(
                    scope = "notes",
                    note_id,
                    "an edited note was not read: {error}"
                );
            }
        },
        Outgoing::Renamed {
            note_id,
            old_path,
            new_path,
        } => match read::list_item(&open, &note_id) {
            Ok(Some(note)) => broadcast(
                app,
                NoteRenamedEvent {
                    old_title: file_title(&old_path).to_owned(),
                    id: note_id,
                    old_path,
                    new_path,
                    new_title: note.title,
                },
            ),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(
                    scope = "notes",
                    note_id,
                    "a renamed note was not read: {error}"
                );
            }
        },
        Outgoing::Deleted(_) => {}
    }
}

/// `path.basename(path, '.md')`.
fn file_title(path: &str) -> &str {
    let name = path.rsplit_once('/').map_or(path, |(_, name)| name);
    name.strip_suffix(".md").unwrap_or(name)
}

fn updated(note: &NoteView) -> NoteUpdatedEvent {
    NoteUpdatedEvent {
        id: note.id.clone(),
        changes: note.changes(),
        source: NoteEventSource::External,
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
        } => Some(Outgoing::Updated { note_id }),
        Applied::Removed {
            note_id,
            path,
            source,
        } if source != ChangeSource::Walk => Some(Outgoing::Deleted(NoteDeletedEvent {
            id: note_id,
            path,
            source: source_of(source),
        })),
        Applied::Renamed {
            note_id,
            old_path,
            new_path,
        } => Some(Outgoing::Renamed {
            note_id,
            old_path,
            new_path,
        }),
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
            Some(Outgoing::Updated {
                note_id: "n".into()
            })
        );
        // The app's own write-back is `sync` in Electron, which the renderer ignores.
        assert_eq!(outgoing(changed(ChangeSource::App)), None);
        // The open walk's notes reach the lists through the index's progress instead.
        assert_eq!(outgoing(added(ChangeSource::Walk)), None);
        assert_eq!(outgoing(changed(ChangeSource::Walk)), None);
        assert_eq!(outgoing(removed(ChangeSource::Walk)), None);
    }
}
