//! The note embedding projector: the `embedding` lane, a port of Electron's
//! `apps/desktop/src/main/projections/projectors/embedding-projector.ts` over the
//! [`EmbeddingService`] and the core's note vector store ([`Search`]'s `*_note_embeddings`).
//!
//! - **What is owed lives in `index.db`.** An event marks its note dirty (input version `0`)
//!   before anything else (`markDirty`, :188-203), so a note whose embed is skipped (AI off,
//!   indexing, a failed load, a close) stays owed across restarts, and the reconcile finds it.
//! - **Deferred while indexing** (:376-378, 446-448): an event during the open's build or a
//!   `vault_reindex` only marks its note; [`drain_deferred`] runs the reconcile once the index
//!   stops indexing (`drainDeferredEmbeddings`, `vault/index.ts:996-1015`, and the build's tail,
//!   :586-599).
//! - **Gated before every inference** (`canContinue`, :216-218): the session's cancel token
//!   (set when the vault closes, before its close hooks stop the model), the vault still being
//!   the one the work started on, the AI setting, and no newer event on the note. An event the
//!   close drains therefore embeds nothing and starts no model thread (REVIEW-4548).
//! - **Markdown notes only.** File notes and the attachment text Electron appends
//!   (`withAttachmentText`, :128-133) come with the extracted-text tables (Step 25, #3542).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use memry_core::api::errors::StorageError;
use memry_core::domain::embedding_input::{
    EmbeddingTask, build_embedding_chunks, build_embedding_input,
};
use memry_core::domain::note_embeddings::EmbeddableNote;
use memry_core::markdown::frontmatter::split_frontmatter_block;

use super::service::EmbeddingService;
use crate::session::projection::{CancelToken, ProjectionEvent, Projector};
use crate::session::{OpenVault, Session};
use crate::vault::note_file::read_note_lossy;

/// The lane's name (`embedding::PROJECTORS[0]`).
pub const NAME: &str = "embedding";

/// `EMBEDDING_PROGRESS`: `current` of `total` notes, in `phase` (`embedding`, `complete`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddingProgress {
    pub current: usize,
    pub total: usize,
    pub phase: &'static str,
}

/// Whether local AI is on for the open vault (`isAIEnabled`); `false` when it cannot be read.
pub type AiEnabled = Arc<dyn Fn(&OpenVault) -> bool + Send + Sync>;
/// Whether the open vault's index is building or reindexing (`getStatus().isIndexing`).
pub type Indexing = Arc<dyn Fn() -> bool + Send + Sync>;
pub type ProgressSink = Arc<dyn Fn(EmbeddingProgress) + Send + Sync>;

pub struct NoteEmbeddingProjector {
    session: Session,
    service: Arc<EmbeddingService>,
    ai_enabled: AiEnabled,
    indexing: Indexing,
    progress: ProgressSink,
    /// `revisions`: guards a computation against a newer event on its note. Not a queue: the
    /// dirty rows are.
    revisions: Mutex<HashMap<String, u64>>,
    next_revision: AtomicU64,
}

/// One pass's view: the vault it started on and the close token of its runtime.
struct Work<'a> {
    open: OpenVault,
    cancel: &'a CancelToken,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn text(error: StorageError) -> String {
    error.to_string()
}

impl NoteEmbeddingProjector {
    pub fn new(
        session: &Session,
        service: Arc<EmbeddingService>,
        ai_enabled: AiEnabled,
        indexing: Indexing,
        progress: ProgressSink,
    ) -> Arc<Self> {
        Arc::new(Self {
            session: session.clone(),
            service,
            ai_enabled,
            indexing,
            progress,
            revisions: Mutex::default(),
            next_revision: AtomicU64::new(1),
        })
    }

    /// The open vault, unless the runtime this call came from has stopped.
    fn work<'a>(&self, cancel: &'a CancelToken) -> Option<Work<'a>> {
        if cancel.is_cancelled() {
            return None;
        }
        Some(Work {
            open: self.session.current()?,
            cancel,
        })
    }

    /// `ownsDatabase() && !signal.aborted`: the vault the work started on is still open.
    fn live(&self, work: &Work<'_>) -> bool {
        !work.cancel.is_cancelled()
            && self
                .session
                .current()
                .is_some_and(|open| Arc::ptr_eq(&open.vault, &work.open.vault))
    }

    fn may_embed(&self, work: &Work<'_>) -> bool {
        self.live(work) && (self.ai_enabled)(&work.open)
    }

    fn revision(&self, note_id: &str) -> Option<u64> {
        lock(&self.revisions).get(note_id).copied()
    }

    /// A new revision for the note: any computation in flight for it stops before it writes.
    fn bump(&self, note_id: &str) -> u64 {
        let revision = self.next_revision.fetch_add(1, Ordering::SeqCst);
        lock(&self.revisions).insert(note_id.to_owned(), revision);
        revision
    }

    fn mark_dirty(&self, work: &Work<'_>, note_id: &str) -> Result<u64, String> {
        let revision = self.bump(note_id);
        work.open
            .search
            .mark_embedding_dirty(note_id)
            .map_err(text)?;
        Ok(revision)
    }

    /// The note's body as Electron reads it (`readVaultFile` and `parseNote(..).content`).
    fn content(&self, work: &Work<'_>, note: &EmbeddableNote) -> Result<String, String> {
        match read_note_lossy(&work.open.path, &note.path) {
            Ok(Some(file)) => Ok(split_frontmatter_block(&file.raw).body.to_owned()),
            Ok(None) => Err(format!("Note file is missing: {}", note.path)),
            Err(error) => Err(format!("{}: {error}", note.path)),
        }
    }

    /// `updateEmbedding` (:209-249): `Ok(true)` once the note's vectors match `revision`.
    fn update(
        &self,
        work: &Work<'_>,
        note: &EmbeddableNote,
        content: &str,
        revision: Option<u64>,
    ) -> Result<bool, String> {
        let current = || self.may_embed(work) && self.revision(&note.note_id) == revision;
        if !current() {
            return Ok(false);
        }
        let windows = build_embedding_chunks(Some(&note.title), Some(content));
        if windows.is_empty() {
            work.open
                .search
                .delete_note_embedding(&note.note_id)
                .map_err(text)?;
            return Ok(true);
        }
        let mut vectors = Vec::with_capacity(windows.len());
        for window in &windows {
            if !current() {
                return Ok(false);
            }
            let Some(vector) = self.service.embed(window) else {
                tracing::warn!(
                    note_id = note.note_id,
                    "note embedding remains owed after inference failed"
                );
                return Ok(false);
            };
            vectors.push(vector);
        }
        if !current() {
            return Ok(false);
        }
        let similar_input =
            build_embedding_input(Some(&note.title), Some(content), EmbeddingTask::Similarity);
        let Some(similar) = self.service.embed(&similar_input) else {
            tracing::warn!(
                note_id = note.note_id,
                "note similarity embedding remains owed after inference failed"
            );
            return Ok(false);
        };
        if !current() {
            return Ok(false);
        }
        work.open
            .search
            .store_note_embeddings(&note.note_id, vectors, similar)
            .map_err(text)?;
        Ok(true)
    }

    /// `embedNotes` (:251-283): the notes in order, each against the revision it was listed
    /// with; stops when the vault closes or AI turns off. The number embedded.
    fn embed_all(&self, work: &Work<'_>, notes: &[(EmbeddableNote, Option<u64>)]) -> usize {
        let mut computed = 0;
        for (i, (note, revision)) in notes.iter().enumerate() {
            if !self.may_embed(work) {
                break;
            }
            if self.revision(&note.note_id) == *revision {
                let embedded = self
                    .content(work, note)
                    .and_then(|content| self.update(work, note, &content, *revision));
                match embedded {
                    Ok(true) => computed += 1,
                    Ok(false) => {}
                    Err(error) => {
                        tracing::warn!(note_id = note.note_id, %error, "failed to rebuild note embedding");
                    }
                }
            }
            if !self.live(work) {
                break;
            }
            if (i + 1) % 5 == 0 || i + 1 == notes.len() {
                self.report(i + 1, notes.len(), "embedding");
            }
        }
        computed
    }

    fn report(&self, current: usize, total: usize, phase: &'static str) {
        (self.progress)(EmbeddingProgress {
            current,
            total,
            phase,
        });
    }

    /// The model is loaded, or loads now (`isModelLoaded() || initEmbeddingModel()`).
    fn model_ready(&self) -> bool {
        self.service.status().loaded || self.service.load()
    }

    /// `note.text-extracted` for a markdown note and the tier's note writes (:400-425,
    /// 436-456): mark it, then embed it unless the index is building.
    fn note_changed(&self, work: &Work<'_>, note_id: &str) -> Result<(), String> {
        let Some(note) = work.open.search.embeddable_note(note_id).map_err(text)? else {
            return Ok(());
        };
        let revision = self.mark_dirty(work, note_id)?;
        if (self.indexing)() || !self.may_embed(work) {
            return Ok(());
        }
        let content = self.content(work, &note)?;
        self.update(work, &note, &content, Some(revision)).map(drop)
    }
}

impl Projector for NoteEmbeddingProjector {
    fn name(&self) -> &str {
        NAME
    }

    /// Nothing reads embeddings back in the same turn, and a project can wait on a model load.
    fn background(&self) -> bool {
        true
    }

    fn handles(&self, event: &ProjectionEvent) -> bool {
        matches!(
            event,
            ProjectionEvent::NoteDeleted { .. }
                | ProjectionEvent::NoteFileChanged { .. }
                | ProjectionEvent::NoteTextExtracted { .. }
        )
    }

    fn project(&self, event: &ProjectionEvent, cancel: &CancelToken) -> Result<(), String> {
        let Some(work) = self.work(cancel) else {
            return Ok(());
        };
        match event {
            ProjectionEvent::NoteDeleted { note_id, .. } => {
                self.bump(note_id);
                work.open
                    .search
                    .delete_note_embedding(note_id)
                    .map_err(text)
            }
            ProjectionEvent::NoteFileChanged { note_id }
            | ProjectionEvent::NoteTextExtracted { note_id } => self.note_changed(&work, note_id),
            _ => Ok(()),
        }
    }

    /// `runRebuild` (:285-358): every note owed, embedded again; old vectors stay until each
    /// note's new ones replace them.
    fn rebuild(&self, cancel: &CancelToken) -> Result<(), String> {
        let Some(work) = self.work(cancel) else {
            return Ok(());
        };
        if !(self.ai_enabled)(&work.open) {
            return Err("AI is disabled".into());
        }
        let notes = work.open.search.embeddable_notes().map_err(text)?;
        if notes.is_empty() {
            work.open.search.clear_note_embeddings().map_err(text)?;
            self.report(0, 0, "complete");
            return Ok(());
        }
        let mut listed = Vec::with_capacity(notes.len());
        for note in notes {
            let revision = self.mark_dirty(&work, &note.note_id)?;
            listed.push((note, Some(revision)));
        }
        if !self.model_ready() {
            return Err("Failed to load embedding model".into());
        }
        if !self.may_embed(&work) {
            return Err("Embedding pass stopped".into());
        }
        self.report(0, listed.len(), "embedding");
        if self.embed_all(&work, &listed) != listed.len() || !self.may_embed(&work) {
            return Err("Embedding pass incomplete".into());
        }
        self.report(listed.len(), listed.len(), "complete");
        Ok(())
    }

    /// `reconcile` (:483-583): drop the vectors of gone notes, then embed the notes with no
    /// vector, an older input version or a dirty mark. Left to [`drain_deferred`] while the
    /// index builds; a failed model load leaves the work owed.
    fn reconcile(&self, cancel: &CancelToken) -> Result<(), String> {
        let Some(work) = self.work(cancel) else {
            return Ok(());
        };
        work.open.search.prune_note_embeddings().map_err(text)?;
        if (self.indexing)() || !self.may_embed(&work) {
            return Ok(());
        }
        let owed = work.open.search.owed_note_embeddings().map_err(text)?;
        if owed.is_empty() {
            return Ok(());
        }
        let listed: Vec<_> = owed
            .into_iter()
            .map(|note| {
                let revision = self.revision(&note.note_id);
                (note, revision)
            })
            .collect();
        if !self.model_ready() {
            tracing::warn!(
                remaining = listed.len(),
                "embedding backfill remains owed after model load failed"
            );
            return Ok(());
        }
        if !self.may_embed(&work) {
            return Ok(());
        }
        self.report(0, listed.len(), "embedding");
        if self.embed_all(&work, &listed) == listed.len() && self.may_embed(&work) {
            self.report(listed.len(), listed.len(), "complete");
        }
        Ok(())
    }
}

/// `drainDeferredEmbeddings`: the notes the index build deferred are embedded now, in the
/// background. Call it when the open vault's index stops indexing. Nothing when no vault is
/// open or no embedding lane runs.
pub fn drain_deferred(session: &Session) {
    if let Some(runtime) = session.projections()
        && let Err(error) = runtime.reconcile_named(&[NAME])
    {
        tracing::error!(%error, "deferred embedding drain did not start");
    }
}
