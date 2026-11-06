//! `FoldService` (Electron's `fold-service.ts` and `note-fold/index.ts`, the local levels):
//! folds the open vault's notes and journal days. It binds to every
//! vault open (`note-fold-start`) and lets go of the vault when it closes (`note-fold-stop`).
//!
//! The Brief is picked again on every run and never cached, as in Electron, where
//! `note_fold_chunks` holds only what a model wrote. Picking it costs about 1 ms per 10,000
//! words, less than a cache read, and a fold that wrote a row would wait behind a reindex
//! holding `index.db`'s writer.

use std::sync::{Arc, Mutex};

use super::engine::{assemble, local_brief, prepare};
use super::tokens::Zone;
use super::{FoldLayers, FoldLevel};
use crate::journal;
use crate::notes::error::NotesError;
use crate::notes::read;
use crate::notes::service::NotesService;
use crate::session::{OpenStage, OpenVault, Session, lock};

const SCOPE: &str = "NoteFold";

pub struct FoldService {
    notes: Arc<NotesService>,
    open: Mutex<Option<OpenVault>>,
}

impl FoldService {
    pub fn new(notes: Arc<NotesService>) -> Arc<Self> {
        Arc::new(Self {
            notes,
            open: Mutex::new(None),
        })
    }

    /// Starts with every open, after the watcher; stops with every close.
    pub fn register(self: &Arc<Self>, session: &Session) {
        let service = self.clone();
        session.on_open(
            "note-fold-start",
            OpenStage::Defaults,
            Arc::new(move |vault| {
                service.start(vault);
                Ok(())
            }),
        );
        let service = self.clone();
        session.on_close("note-fold-stop", Arc::new(move |_| service.stop()));
    }

    /// Binds the service to `vault`.
    pub fn start(&self, vault: &OpenVault) {
        *lock(&self.open) = Some(vault.clone());
    }

    /// Lets go of the vault, so its databases close with it.
    pub fn stop(&self) {
        *lock(&self.open) = None;
    }

    /// The note or journal day folded for a reader who asked for `level`. Brief is part of
    /// every snapshot of a note long enough to fold; `level` goes into the failure log. A note
    /// or day that does not exist (yet) reads as empty, so it does not fold.
    pub fn run(&self, note_id: &str, level: FoldLevel) -> Result<FoldLayers, NotesError> {
        let open = lock(&self.open).clone().ok_or(NotesError::Closed)?;
        let outcome = self.fold(&open, note_id);
        if let Err(error) = &outcome {
            tracing::warn!(scope = SCOPE, note_id, ?level, "fold failed: {error}");
        }
        outcome
    }

    fn fold(&self, open: &OpenVault, note_id: &str) -> Result<FoldLayers, NotesError> {
        let source = self.source(open, note_id)?.unwrap_or_default();
        let prepared = prepare(&source, Zone::Local);
        let language = prepared.language.clone();
        Ok(assemble(note_id, &prepared, |chunk| {
            local_brief(chunk, &language)
        }))
    }

    /// The Markdown body of the note or live journal day; `None` when there is none. A deleted
    /// day's id names no day, as Electron's lookup of live days answers, so it does not fold
    /// the file at its date.
    fn source(&self, open: &OpenVault, note_id: &str) -> Result<Option<String>, NotesError> {
        if let Some(note) = read::get(open, note_id, None)? {
            return Ok(Some(note.content));
        }
        let writer = open.vault.notes_writer(self.notes.store.clone())?;
        let Some(date) = writer.journal_date(note_id)? else {
            return Ok(None);
        };
        let days = self.notes.journal(open)?;
        if days.stamp(&date)?.is_none_or(|stamp| stamp.id != note_id) {
            return Ok(None);
        }
        Ok(journal::entry(open, &days, &date)?.map(|entry| entry.content))
    }
}
