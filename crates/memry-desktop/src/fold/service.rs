//! `FoldService` (Electron's `fold-service.ts` and `note-fold/index.ts`): folds the open vault's
//! notes and journal days, and has a model write the Key, Takeaway and Topic lines of the
//! chunks it has not written yet. It binds to every vault open (`note-fold-start`) and lets go
//! of the vault when it closes (`note-fold-stop`), as Electron builds a service per open.
//!
//! The Brief is picked again on every run and never cached; `note_fold_chunks` holds only what
//! a model wrote, keyed by chunk hash, language and model, and rows older than 90 days go at
//! every open. A note the renderer opened regenerates its changed chunks 30 s after its last
//! change.
//!
//! One divergence: closing the vault aborts the runs in flight, where Electron lets them finish
//! and write into whichever index is open by then.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use memry_core::api::errors::StorageError;
use memry_core::domain::fold_chunks::ChunkKey;
use tokio::runtime::Handle;
use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::RecvError;
use tokio::task::AbortHandle;

use super::engine::{assemble, prepare};
use super::model::{ChunkAi, chunk_ai};
use super::queue::{FoldBackend, FoldLastRun, FoldWriter, Queue, execute, job_key};
use super::sections::ParsedChunk;
use super::tokens::Zone;
use super::{FoldLayers, FoldLevel, FoldStatus};
use crate::ai::features;
use crate::journal;
use crate::notes::error::NotesError;
use crate::notes::read;
use crate::notes::service::NotesService;
use crate::session::{OpenStage, OpenVault, Session, lock};
use crate::settings::SettingsService;
use crate::vault::consumer::Applied;

const SCOPE: &str = "NoteFold";

/// How long a note rests after a change before its changed chunks regenerate (`FOLD_IDLE_MS`).
pub const FOLD_IDLE: Duration = Duration::from_secs(30);
/// Cached chunks older than this go at every open (`CHUNK_RETENTION_MS`).
pub const CHUNK_RETENTION: Duration = Duration::from_secs(90 * 24 * 60 * 60);

/// Tells the windows a note's fold changed (`note-fold:updated`); they fetch it again.
pub type OnUpdated = Arc<dyn Fn(&str) + Send + Sync>;

pub struct FoldService {
    notes: Arc<NotesService>,
    settings: SettingsService,
    backend: Arc<dyn FoldBackend>,
    runtime: Handle,
    on_updated: OnUpdated,
    idle: Duration,
    state: Mutex<State>,
}

/// What one vault open holds; a new open or a close starts over.
#[derive(Default)]
struct State {
    /// Bumped by every open and close: a run or timer of an earlier one changes nothing.
    generation: u64,
    open: Option<OpenVault>,
    /// Every note the renderer fetched; [`State::opened`] holds those being summarized.
    seen: HashSet<String>,
    /// Fetched before the index knew them; refetched once they are indexed.
    unindexed: HashSet<String>,
    /// Notes the renderer opened this session; only these regenerate on a change.
    opened: HashSet<String>,
    timers: HashMap<String, AbortHandle>,
    queue: Queue,
}

/// A note read and folded before its status is known.
struct Folded {
    layers: FoldLayers,
    missing: Vec<ParsedChunk>,
    language: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

impl FoldService {
    pub fn new(
        notes: Arc<NotesService>,
        settings: SettingsService,
        backend: Arc<dyn FoldBackend>,
        runtime: Handle,
        on_updated: OnUpdated,
    ) -> Arc<Self> {
        Self::with_idle(notes, settings, backend, runtime, on_updated, FOLD_IDLE)
    }

    /// [`Self::new`] with another idle window, for tests.
    pub fn with_idle(
        notes: Arc<NotesService>,
        settings: SettingsService,
        backend: Arc<dyn FoldBackend>,
        runtime: Handle,
        on_updated: OnUpdated,
        idle: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            notes,
            settings,
            backend,
            runtime,
            on_updated,
            idle,
            state: Mutex::new(State::default()),
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

    /// `startNoteFold`: binds the service to `vault`, forgets the agent detection and drops the
    /// cached chunks older than [`CHUNK_RETENTION`].
    pub fn start(&self, vault: &OpenVault) {
        self.reset(Some(vault.clone()));
        self.backend.forget();
        let cutoff = now_ms() - CHUNK_RETENTION.as_millis() as i64;
        match vault.search.prune_fold_chunks(cutoff) {
            Ok(removed) => tracing::debug!(scope = SCOPE, removed, "pruned old fold chunks"),
            Err(error) => tracing::warn!(scope = SCOPE, "pruning fold chunks failed: {error}"),
        }
    }

    /// `stopNoteFold`: lets go of the vault, so its databases close with it.
    pub fn stop(&self) {
        self.reset(None);
    }

    fn reset(&self, open: Option<OpenVault>) {
        let mut state = lock(&self.state);
        state.queue.clear();
        for timer in state.timers.values() {
            timer.abort();
        }
        let generation = state.generation + 1;
        *state = State {
            generation,
            open,
            ..State::default()
        };
    }

    /// `note-fold:get` for a reader who asked for `level`, which only goes into the failure log.
    pub async fn run(
        self: &Arc<Self>,
        note_id: &str,
        level: FoldLevel,
    ) -> Result<FoldLayers, NotesError> {
        let outcome = self.get(note_id).await;
        if let Err(error) = &outcome {
            tracing::warn!(scope = SCOPE, note_id, ?level, "fold failed: {error}");
        }
        outcome
    }

    /// `get`: the snapshot, with the local fallback where no model wrote yet, and the missing
    /// chunks queued. A note or day that does not exist (yet) reads as empty, so it does not fold.
    pub async fn get(self: &Arc<Self>, note_id: &str) -> Result<FoldLayers, NotesError> {
        let (open, generation) = {
            let mut state = lock(&self.state);
            let open = state.open.clone().ok_or(NotesError::Closed)?;
            state.seen.insert(note_id.to_owned());
            (open, state.generation)
        };
        let this = self.clone();
        let (id, vault) = (note_id.to_owned(), open.clone());
        let (fetched, ai, prepared) = blocking(move || {
            let fetched = this.source(&vault, &id)?;
            let ai = features::read(&this.settings, Some(&vault))
                .map_err(|error| NotesError::SettingsUnreadable(error.to_string()))?;
            let prepared = prepare(fetched.as_deref().unwrap_or_default(), Zone::Local);
            Ok((fetched.is_some(), ai, prepared))
        })
        .await?;
        {
            let mut state = lock(&self.state);
            if state.generation == generation {
                if fetched {
                    state.unindexed.remove(note_id);
                } else {
                    state.unindexed.insert(note_id.to_owned());
                }
            }
        }
        let foldable = !prepared.sections.is_empty();
        let enabled = foldable && ai.enabled && ai.summarize_long_notes;
        let writer = match enabled {
            true => self.backend.writer(ai.summarize_agent).await,
            false => None,
        };
        let (id, lookup_writer) = (note_id.to_owned(), writer.clone());
        let Folded {
            mut layers,
            missing,
            language,
        } = blocking(move || fold(&id, &open, &prepared, lookup_writer.as_ref())).await?;
        layers.status = if !foldable {
            FoldStatus::Short
        } else if !enabled {
            FoldStatus::Off
        } else if let Some(writer) = &writer {
            self.queue_missing(note_id, generation, &missing, &language, writer)
        } else {
            FoldStatus::NoAgent
        };
        layers.agent = writer.map(|writer| writer.label);
        Ok(layers)
    }

    /// The status of a note whose chunks `writer` writes, the missing ones queued.
    fn queue_missing(
        self: &Arc<Self>,
        note_id: &str,
        generation: u64,
        missing: &[ParsedChunk],
        language: &str,
        writer: &FoldWriter,
    ) -> FoldStatus {
        let mut state = lock(&self.state);
        if state.generation != generation {
            return FoldStatus::Writing;
        }
        state.opened.insert(note_id.to_owned());
        if missing.is_empty() {
            return FoldStatus::Ready;
        }
        let Some(search) = state.open.as_ref().map(|open| open.search.clone()) else {
            return FoldStatus::Writing;
        };
        for chunk in missing {
            state
                .queue
                .enqueue(note_id, chunk, language, writer, &search);
        }
        let keys: Vec<String> = missing
            .iter()
            .map(|chunk| {
                job_key(&ChunkKey {
                    chunk_hash: chunk.hash.clone(),
                    language: language.to_owned(),
                    model_id: writer.model_id.clone(),
                })
            })
            .collect();
        let in_flight = keys.iter().any(|key| state.queue.jobs.contains_key(key));
        let failed = keys.iter().any(|key| state.queue.failed.contains_key(key));
        self.pump(&mut state);
        if !in_flight && failed {
            FoldStatus::Failed
        } else {
            FoldStatus::Writing
        }
    }

    /// `pump`: starts queued jobs while a run slot is free.
    fn pump(self: &Arc<Self>, state: &mut State) {
        let generation = state.generation;
        while let Some(job) = state.queue.start_next() {
            let this = self.clone();
            let key = job.key.clone();
            let task = self.runtime.spawn(async move {
                let outcome = execute(this.backend.as_ref(), &job, now_ms()).await;
                let note_ids = {
                    let mut state = lock(&this.state);
                    if state.generation != generation {
                        return;
                    }
                    let note_ids = state.queue.finish(&job.key, &outcome);
                    this.pump(&mut state);
                    note_ids
                };
                for note_id in note_ids.iter() {
                    (this.on_updated)(note_id);
                }
            });
            state.queue.tasks.insert(key, task.abort_handle());
        }
    }

    /// `retry`: the chunks `note_id` asked for (no `note_id`: the last failed note's) may run
    /// again, and the note folds. `None` when there is no note to retry.
    pub async fn retry(
        self: &Arc<Self>,
        note_id: Option<String>,
    ) -> Result<Option<FoldLayers>, NotesError> {
        let target = {
            let mut state = lock(&self.state);
            let Some(target) = note_id.or_else(|| state.queue.last_failure.clone()) else {
                return Ok(None);
            };
            state.queue.forget_failures_of(&target);
            target
        };
        self.get(&target).await.map(Some)
    }

    /// `getLastRun`.
    pub fn last_run(&self) -> FoldLastRun {
        lock(&self.state).queue.last_run()
    }

    /// `noteChanged`: a note the renderer fetched before the index knew it is fetched again; a
    /// note it opened regenerates its changed chunks once it rests for the idle window.
    pub fn note_changed(self: &Arc<Self>, note_id: &str) {
        let mut state = lock(&self.state);
        if state.open.is_none() {
            return;
        }
        if state.unindexed.remove(note_id) {
            drop(state);
            (self.on_updated)(note_id);
            return;
        }
        if !state.opened.contains(note_id) {
            return;
        }
        let (this, id, generation, idle) = (
            self.clone(),
            note_id.to_owned(),
            state.generation,
            self.idle,
        );
        let timer = self.runtime.spawn(async move {
            tokio::time::sleep(idle).await;
            {
                let mut state = lock(&this.state);
                if state.generation != generation {
                    return;
                }
                state.timers.remove(&id);
            }
            // `get` hashes the new body and queues only the chunks with no cached result.
            match this.get(&id).await {
                Ok(_) => (this.on_updated)(&id),
                Err(error) => {
                    tracing::warn!(
                        scope = SCOPE,
                        note_id = id,
                        "fold regeneration failed: {error}"
                    );
                }
            }
        });
        if let Some(earlier) = state
            .timers
            .insert(note_id.to_owned(), timer.abort_handle())
        {
            earlier.abort();
        }
    }

    /// `createNoteFoldProjector`: every note the vault tier writes, whoever wrote it, reaches
    /// [`Self::note_changed`]. Only the notes the renderer opened regenerate, so an import or a
    /// vault walk queues nothing.
    pub fn watch(self: &Arc<Self>, mut facts: Receiver<Applied>) {
        let service = self.clone();
        std::thread::spawn(move || {
            loop {
                match facts.blocking_recv() {
                    Ok(Applied::Added { note_id, .. } | Applied::Changed { note_id, .. }) => {
                        service.note_changed(&note_id);
                    }
                    Ok(Applied::Renamed { note_id, .. }) => service.note_changed(&note_id),
                    Ok(_) => {}
                    Err(RecvError::Lagged(missed)) => {
                        tracing::warn!(scope = SCOPE, missed, "note changes were dropped");
                    }
                    Err(RecvError::Closed) => return,
                }
            }
        });
    }

    /// `refresh`: the settings or the agent changed, so every note the renderer fetched fetches
    /// its fold again.
    pub fn refresh(&self) {
        let seen: Vec<String> = {
            let state = lock(&self.state);
            if state.open.is_none() {
                return;
            }
            state.seen.iter().cloned().collect()
        };
        for note_id in &seen {
            (self.on_updated)(note_id);
        }
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

/// `assemble` over the cache of `writer` (`lookupFor`): no writer reads nothing. A row that does
/// not read as this chunk's reply is deleted, so it is written again.
fn fold(
    note_id: &str,
    open: &OpenVault,
    prepared: &super::engine::Prepared,
    writer: Option<&FoldWriter>,
) -> Result<Folded, NotesError> {
    let mut failure: Option<StorageError> = None;
    let assembled = assemble(note_id, prepared, |chunk| {
        let writer = writer?;
        if failure.is_some() {
            return None;
        }
        let key = ChunkKey {
            chunk_hash: chunk.hash.clone(),
            language: prepared.language.clone(),
            model_id: writer.model_id.clone(),
        };
        let payload = match open.search.fold_chunk(&key) {
            Ok(payload) => payload?,
            Err(error) => {
                failure = Some(error);
                return None;
            }
        };
        let parsed: Result<ChunkAi, String> = serde_json::from_str(&payload)
            .map_err(|error| error.to_string())
            .and_then(|value| chunk_ai(&value, chunk));
        match parsed {
            Ok(ai) => Some(ai),
            Err(error) => {
                tracing::warn!(
                    scope = SCOPE,
                    chunk_hash = chunk.hash,
                    "dropping unreadable fold cache row: {error}"
                );
                if let Err(error) = open.search.forget_fold_chunk(&key) {
                    failure = Some(error);
                }
                None
            }
        }
    });
    if let Some(error) = failure {
        return Err(error.into());
    }
    Ok(Folded {
        layers: assembled.layers,
        missing: assembled.missing.into_iter().cloned().collect(),
        language: prepared.language.clone(),
    })
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, NotesError> + Send + 'static,
) -> Result<T, NotesError> {
    match tokio::task::spawn_blocking(work).await {
        Ok(outcome) => outcome,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}
