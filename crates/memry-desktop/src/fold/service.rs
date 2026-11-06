//! `FoldService` (Electron's `fold-service.ts` and `note-fold/index.ts`, the local levels):
//! folds the open vault's notes and journal days, keeps each chunk's Brief in `index.db`'s
//! `note_fold_chunks` under the writer `local`, and records the last run. It starts with every
//! vault open (`note-fold-start`, which drops rows past the retention window) and lets go of
//! the vault when it closes (`note-fold-stop`).

use std::sync::{Arc, Mutex};

use memry_core::api::search::Search;
use memry_core::domain::fold_chunks::ChunkKey;
use memry_core::domain::related_items::date_from_journal_id;
use serde::{Deserialize, Serialize};

use super::engine::{assemble, local_brief, prepare};
use super::sections::ParsedChunk;
use super::tokens::Zone;
use super::{FoldLayers, FoldLevel};
use crate::journal;
use crate::notes::error::NotesError;
use crate::notes::read;
use crate::notes::service::NotesService;
use crate::session::{OpenStage, OpenVault, Session, lock};
use crate::telemetry::time::now_ms;

/// The writer of the Brief the app picks from the note's own sentences.
pub const LOCAL_MODEL_ID: &str = "local";
/// Rows older than this are dropped when a vault opens; a chunk still wanted is written again.
pub const CHUNK_RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1000;

const SCOPE: &str = "NoteFold";

/// The most recent run, for `fold_get_last_run`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FoldRunState {
    pub note_id: String,
    pub level: FoldLevel,
    pub ok: bool,
    /// Why it failed; null when it did not.
    pub error: Option<String>,
}

/// A `local` row's payload: the Brief pick of each paragraph of the chunk, in order.
#[derive(Serialize, Deserialize)]
struct LocalChunk {
    paragraphs: Vec<LocalParagraph>,
}

#[derive(Serialize, Deserialize)]
struct LocalParagraph {
    brief: Vec<u32>,
}

pub struct FoldService {
    notes: Arc<NotesService>,
    open: Mutex<Option<OpenVault>>,
    last_run: Mutex<Option<FoldRunState>>,
}

impl FoldService {
    pub fn new(notes: Arc<NotesService>) -> Arc<Self> {
        Arc::new(Self {
            notes,
            open: Mutex::new(None),
            last_run: Mutex::new(None),
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

    /// Binds the service to `vault` and drops its old rows. A failed prune is logged: the
    /// rows stay until the next open.
    pub fn start(&self, vault: &OpenVault) {
        *lock(&self.last_run) = None;
        *lock(&self.open) = Some(vault.clone());
        let cutoff = now_ms() as i64 - CHUNK_RETENTION_MS;
        match vault.search.prune_fold_chunks(cutoff) {
            Ok(removed) => tracing::debug!(scope = SCOPE, removed, "pruned old fold chunks"),
            Err(error) => tracing::warn!(scope = SCOPE, "pruning fold chunks failed: {error}"),
        }
    }

    /// Lets go of the vault, so its databases close with it.
    pub fn stop(&self) {
        *lock(&self.open) = None;
        *lock(&self.last_run) = None;
    }

    pub fn last_run(&self) -> Option<FoldRunState> {
        lock(&self.last_run).clone()
    }

    /// The note or journal day folded for a reader who asked for `level`. Brief is part of
    /// every snapshot of a note long enough to fold; `level` is what the run records. A note
    /// that does not exist (yet) reads as empty, so it does not fold.
    pub fn run(&self, note_id: &str, level: FoldLevel) -> Result<FoldLayers, NotesError> {
        let open = lock(&self.open).clone().ok_or(NotesError::Closed)?;
        let outcome = self.fold(&open, note_id);
        if let Err(error) = &outcome {
            tracing::warn!(scope = SCOPE, note_id, ?level, "fold failed: {error}");
        }
        *lock(&self.last_run) = Some(FoldRunState {
            note_id: note_id.to_owned(),
            level,
            ok: outcome.is_ok(),
            error: outcome.as_ref().err().map(ToString::to_string),
        });
        outcome
    }

    fn fold(&self, open: &OpenVault, note_id: &str) -> Result<FoldLayers, NotesError> {
        let source = self.source(open, note_id)?.unwrap_or_default();
        let prepared = prepare(&source, Zone::Local);
        let language = prepared.language.clone();
        Ok(assemble(note_id, &prepared, |chunk| {
            cached_brief(&open.search, chunk, &language)
        }))
    }

    /// The Markdown body of the note or journal day; `None` when there is none.
    fn source(&self, open: &OpenVault, note_id: &str) -> Result<Option<String>, NotesError> {
        if let Some(note) = read::get(open, note_id, None)? {
            return Ok(Some(note.content));
        }
        let Some(date) = date_from_journal_id(note_id) else {
            return Ok(None);
        };
        let days = self.notes.journal(open)?;
        Ok(journal::entry(open, &days, date)?.map(|entry| entry.content))
    }
}

/// The chunk's Brief from its `local` row, written when missing. A row that does not fit the
/// chunk is replaced. The cache is derived: a failed read or write is logged and the Brief is
/// picked again from the sentences.
fn cached_brief(search: &Search, chunk: &ParsedChunk, language: &str) -> Vec<Vec<u32>> {
    let key = ChunkKey {
        chunk_hash: chunk.hash.clone(),
        language: language.to_owned(),
        model_id: LOCAL_MODEL_ID.to_owned(),
    };
    match search.fold_chunk(&key) {
        Ok(Some(payload)) => {
            if let Some(brief) = fitting(&payload, chunk) {
                return brief;
            }
            tracing::warn!(
                scope = SCOPE,
                chunk_hash = key.chunk_hash,
                "dropping an unreadable fold row"
            );
            if let Err(error) = search.forget_fold_chunk(&key) {
                tracing::warn!(scope = SCOPE, "dropping a fold row failed: {error}");
            }
        }
        Ok(None) => {}
        Err(error) => tracing::warn!(scope = SCOPE, "reading a fold row failed: {error}"),
    }
    let brief = local_brief(chunk, language);
    let payload = LocalChunk {
        paragraphs: brief
            .iter()
            .map(|picks| LocalParagraph {
                brief: picks.clone(),
            })
            .collect(),
    };
    let written = serde_json::to_string(&payload)
        .map_err(|error| error.to_string())
        .and_then(|json| {
            search
                .put_fold_chunk(&key, &json, now_ms() as i64)
                .map_err(|error| error.to_string())
        });
    if let Err(error) = written {
        tracing::warn!(scope = SCOPE, "writing a fold row failed: {error}");
    }
    brief
}

/// The row's picks when they fit the chunk: one entry per paragraph, every index a sentence.
fn fitting(payload: &str, chunk: &ParsedChunk) -> Option<Vec<Vec<u32>>> {
    let row: LocalChunk = serde_json::from_str(payload).ok()?;
    let fits = row.paragraphs.len() == chunk.paragraphs.len()
        && row
            .paragraphs
            .iter()
            .zip(&chunk.paragraphs)
            .all(|(row, p)| row.brief.iter().all(|&i| (i as usize) < p.sentences.len()));
    fits.then(|| row.paragraphs.into_iter().map(|p| p.brief).collect())
}
