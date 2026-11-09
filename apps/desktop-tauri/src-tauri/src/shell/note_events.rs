//! The note events (`notes:created`, `notes:updated`, `notes:deleted`, `notes:renamed`,
//! `notes:moved`), from the vault tier's row facts: the one place they are emitted. A fact
//! names who caused it, so the app's create and delete and the watcher's reports go out the
//! same way with their `source`. Two kinds of fact emit nothing:
//! - the app's own writes of a body (`Changed` by the app): Electron's write-back is `sync`,
//!   which the renderer ignores. The user's save (`Changed` by [`ChangeSource::Save`]) sends an
//!   `internal` `notes:updated`, as Electron's `updateNote` does; an edit the app makes for the
//!   user outside the editor (`ChangeSource::AppEdit`, a template's apply, and
//!   `ChangeSource::LinkRewrite`, the links to a renamed note) goes out as an outside edit does;
//! - what the open walk found (`ChangeSource::Walk`): Electron's open-time index sends no note
//!   events either, and the index pass after the walk reports progress, on which the renderer
//!   refetches its lists (`use-notes-query.ts`). A first open of a large vault would otherwise
//!   send one event, and one read, per file.
//!
//! A write-back that replaced an outside edit typing won over (`OutsideEditKept`, after the
//! write's own `Changed`) sends [`NoteOutsideEditKeptEvent`], on which the note page tells the
//! user the outside text is a version.
//!
//! A created note is read for its list item, an outside edit for the fields it may have changed
//! ([`NoteView::changes`]). Facts missed because this thread fell behind are made up for with
//! one [`NoteEventsDroppedEvent`], on which the renderer refetches what it shows.
//!
//! A `Renamed` fact sends by its [`MoveKind`]: the app's rename and a file moved outside the
//! app send `notes:renamed` (Electron's watcher sends an outside move so), read for the title
//! the note has now; the app's move to another folder sends `notes:moved` (`moveNote`); and a
//! journal day renamed by a date format change sends nothing, as Electron's
//! `journal-format-migration` sends nothing (one event per day would refetch the lists once
//! per file).

use memry_desktop::notes::read;
use memry_desktop::notes::view::NoteView;
use memry_desktop::session::Session;
use memry_desktop::vault::consumer::{Applied, ChangeSource, MoveKind};
use serde_json::json;
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::RecvError;

use crate::events::{
    NoteCreatedEvent, NoteDeletedEvent, NoteEventSource, NoteEventsDroppedEvent, NoteMovedEvent,
    NoteOutsideEditKeptEvent, NoteRenamedEvent, NoteUpdatedEvent, broadcast,
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
        source: NoteEventSource,
    },
    Deleted(NoteDeletedEvent),
    Moved(NoteMovedEvent),
    Renamed {
        note_id: String,
        old_path: String,
        new_path: String,
    },
    OutsideEditKept {
        note_id: String,
    },
}

fn emit<R: Runtime>(app: &AppHandle<R>, fact: Applied) {
    let Some(outgoing) = outgoing(fact) else {
        return;
    };
    let outgoing = match outgoing {
        Outgoing::Deleted(event) => return broadcast(app, event),
        Outgoing::Moved(event) => return broadcast(app, event),
        outgoing => outgoing,
    };
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
        Outgoing::Updated { note_id, source } => match read::get(&open, &note_id, None) {
            Ok(Some(note)) => broadcast(app, updated(&note, source)),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(
                    scope = "notes",
                    note_id,
                    "an edited note was not read: {error}"
                );
            }
        },
        Outgoing::OutsideEditKept { note_id } => {
            broadcast(app, NoteOutsideEditKeptEvent { id: note_id });
        }
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
        Outgoing::Deleted(_) | Outgoing::Moved(_) => {}
    }
}

/// `path.basename(path, '.md')`.
fn file_title(path: &str) -> &str {
    let name = path.rsplit_once('/').map_or(path, |(_, name)| name);
    name.strip_suffix(".md").unwrap_or(name)
}

/// An edit in the app also says the header tags and the icon, as Electron's `updateNote` does.
fn updated(note: &NoteView, source: NoteEventSource) -> NoteUpdatedEvent {
    let mut changes = note.changes();
    if source == NoteEventSource::Internal {
        changes.insert("headerTags".into(), json!(note.header_tags));
        changes.insert("emoji".into(), json!(note.emoji));
    }
    NoteUpdatedEvent {
        id: note.id.clone(),
        changes,
        source,
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
            source:
                source @ (ChangeSource::Watcher
                | ChangeSource::AppEdit
                | ChangeSource::LinkRewrite
                | ChangeSource::Save),
            ..
        } => Some(Outgoing::Updated {
            note_id,
            source: source_of(source),
        }),
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
            kind,
        } => match kind {
            MoveKind::Renamed => Some(Outgoing::Renamed {
                note_id,
                old_path,
                new_path,
            }),
            MoveKind::Moved => Some(Outgoing::Moved(NoteMovedEvent {
                id: note_id,
                old_path,
                new_path,
            })),
            MoveKind::JournalFormat => None,
        },
        Applied::OutsideEditKept { note_id, .. } => Some(Outgoing::OutsideEditKept { note_id }),
        _ => None,
    }
}

fn source_of(source: ChangeSource) -> NoteEventSource {
    match source {
        ChangeSource::App | ChangeSource::Save => NoteEventSource::Internal,
        ChangeSource::Watcher
        | ChangeSource::Walk
        | ChangeSource::AppEdit
        | ChangeSource::LinkRewrite => NoteEventSource::External,
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
                note_id: "n".into(),
                source: NoteEventSource::External,
            })
        );
        // The user's edit in the app, as Electron's `updateNote` sends it.
        assert_eq!(
            outgoing(changed(ChangeSource::Save)),
            Some(Outgoing::Updated {
                note_id: "n".into(),
                source: NoteEventSource::Internal,
            })
        );
        // The app's own write-back is `sync` in Electron, which the renderer ignores; its edit
        // for the user (a renamed note's links) is `external`, as `landSourceRewrite` sends it.
        assert_eq!(outgoing(changed(ChangeSource::App)), None);
        for source in [ChangeSource::AppEdit, ChangeSource::LinkRewrite] {
            assert_eq!(
                outgoing(changed(source)),
                Some(Outgoing::Updated {
                    note_id: "n".into(),
                    source: NoteEventSource::External,
                })
            );
        }
        let kept = Applied::OutsideEditKept {
            note_id: "n".into(),
            path: "a.md".into(),
        };
        assert_eq!(
            outgoing(kept),
            Some(Outgoing::OutsideEditKept {
                note_id: "n".into()
            })
        );
        // The open walk's notes reach the lists through the index's progress instead.
        assert_eq!(outgoing(added(ChangeSource::Walk)), None);
        assert_eq!(outgoing(changed(ChangeSource::Walk)), None);
        assert_eq!(outgoing(removed(ChangeSource::Walk)), None);
    }

    fn renamed(kind: MoveKind) -> Applied {
        Applied::Renamed {
            note_id: "n".into(),
            old_path: "a.md".into(),
            new_path: "b/a.md".into(),
            kind,
        }
    }

    #[test]
    fn a_path_change_sends_by_what_moved_the_file() {
        assert_eq!(
            outgoing(renamed(MoveKind::Renamed)),
            Some(Outgoing::Renamed {
                note_id: "n".into(),
                old_path: "a.md".into(),
                new_path: "b/a.md".into(),
            })
        );
        assert_eq!(
            outgoing(renamed(MoveKind::Moved)),
            Some(Outgoing::Moved(NoteMovedEvent {
                id: "n".into(),
                old_path: "a.md".into(),
                new_path: "b/a.md".into(),
            }))
        );
        // Electron's journal format migration sends no note event.
        assert_eq!(outgoing(renamed(MoveKind::JournalFormat)), None);
    }
}
