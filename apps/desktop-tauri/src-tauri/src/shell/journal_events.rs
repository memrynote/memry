//! The journal events of a day file changed outside the app (Step 13m-5, #3530), from the vault
//! tier's row facts, as Electron's watcher and ingest send them (`vault/watcher.ts`,
//! `vault/ingest-backfill.ts`): a day file that appeared sends `journal:entryCreated`, an edit
//! `journal:entryUpdated`, both with the entry and `source: 'external'`, and a removal
//! `journal:entryDeleted`. A path is a day's when the vault's journal config names one for it
//! (`extractJournalDate`).
//!
//! Only the watcher's facts send: the app's own saves send their events from their commands
//! (`commands/journal.rs`), and an `external` update drops what an open editor has not saved,
//! so the app's writes must never look like one. What the open walk found sends nothing, as for
//! notes (`note_events`).
//!
//! A found or edited day is measured by the note index before its event goes out, as Electron
//! syncs its cache first, so the calendar's refetch reads the file's counts. A day the index
//! leaves to a pass gets `journal:externalChange` once that pass writes its row ([`landed`]),
//! and a save whose measure timed out gets the same.

use std::sync::Arc;

use memry_desktop::journal::{self, JournalEntryView};
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::service::NotesService;
use memry_desktop::session::{OpenVault, Session};
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::RecvError;

use crate::events::{
    JournalEntryCreatedEvent, JournalEntryDeletedEvent, JournalEntryUpdatedEvent,
    JournalExternalChange, JournalExternalChangeEvent, NoteEventSource, broadcast,
};

const SCOPE: &str = "journal";

/// Generic over the runtime so a test drives it on a mock app.
pub fn forward<R: Runtime>(app: AppHandle<R>, mut facts: Receiver<Applied>) {
    std::thread::spawn(move || {
        loop {
            match facts.blocking_recv() {
                Ok(fact) => emit(&app, fact),
                // The note events' `NoteEventsDroppedEvent` makes the renderer refetch.
                Err(RecvError::Lagged(missed)) => {
                    tracing::warn!(scope = SCOPE, missed, "journal events were dropped");
                }
                Err(RecvError::Closed) => return,
            }
        }
    });
}

/// What a watcher fact did to its file.
enum Change {
    Appeared,
    Edited,
    Removed,
}

fn emit<R: Runtime>(app: &AppHandle<R>, fact: Applied) {
    let (note_id, path, change) = match fact {
        Applied::Added {
            note_id,
            path,
            source: ChangeSource::Watcher,
            ..
        } => (note_id, path, Change::Appeared),
        Applied::Changed {
            note_id,
            path,
            source: ChangeSource::Watcher,
            ..
        } => (note_id, path, Change::Edited),
        Applied::Removed {
            note_id,
            path,
            source: ChangeSource::Watcher,
        } => (note_id, path, Change::Removed),
        _ => return,
    };
    let Some(open) = app.state::<Session>().current() else {
        return;
    };
    let Some(date) = journal::day_of_file(&open.path, &path) else {
        return;
    };
    let source = Some(NoteEventSource::External);
    if matches!(change, Change::Removed) {
        return broadcast(app, JournalEntryDeletedEvent { date, source });
    }
    measure(app, &note_id, &date);
    let Some(entry) = read(app, &open, &date) else {
        return;
    };
    match change {
        Change::Appeared => broadcast(
            app,
            JournalEntryCreatedEvent {
                date,
                entry,
                source,
            },
        ),
        Change::Edited | Change::Removed => broadcast(
            app,
            JournalEntryUpdatedEvent {
                date,
                entry,
                source,
            },
        ),
    }
}

/// The day's file measured into its index row before its event goes out; one the index leaves
/// to a pass sends [`landed`]'s event later. Shared with the app's saves.
pub fn measure<R: Runtime>(app: &AppHandle<R>, note_id: &str, date: &str) {
    let Some(index) = app.try_state::<Arc<NoteIndex>>() else {
        tracing::warn!(
            scope = SCOPE,
            date,
            "no note index: the day's counts lag its change"
        );
        return;
    };
    match index.measure(note_id) {
        Ok(true) => {}
        Ok(false) => tracing::debug!(scope = SCOPE, date, "measured by a later pass"),
        Err(error) => tracing::warn!(
            scope = SCOPE,
            date,
            "the day's counts lag its change: {error}"
        ),
    }
}

/// The day's entry as the event carries it; `None`, logged, when it does not read (gone again,
/// or another day holds the path).
fn read<R: Runtime>(app: &AppHandle<R>, open: &OpenVault, date: &str) -> Option<JournalEntryView> {
    let service = app.try_state::<Arc<NotesService>>()?;
    let read = service
        .journal(open)
        .and_then(|day| journal::entry(open, &day, date));
    match read {
        Ok(entry) => entry,
        Err(error) => {
            tracing::warn!(scope = SCOPE, date, "a changed day was not read: {error}");
            None
        }
    }
}

/// A note [`NoteIndex::measure`] left to a pass has its row now: a day's reads are refetched
/// (`journal:externalChange`), its date the one the index stored with the row.
pub fn landed<R: Runtime>(app: &AppHandle<R>, note_id: &str) {
    let Some(open) = app.state::<Session>().current() else {
        return;
    };
    match open.search.note_stats(note_id) {
        Ok(Some(row)) => {
            if let Some(date) = row.date {
                broadcast(
                    app,
                    JournalExternalChangeEvent {
                        date,
                        kind: JournalExternalChange::Modified,
                    },
                );
            }
        }
        Ok(None) => {}
        Err(error) => tracing::warn!(
            scope = SCOPE,
            note_id,
            "a measured row did not read: {error}"
        ),
    }
}
