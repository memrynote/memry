//! The model run queue of the fold (`fold-service.ts`: `enqueue`, `pump`, `execute`): at most
//! [`FOLD_CONCURRENCY`] chunks run at once, a chunk asked for by several notes runs once, and a
//! chunk whose run failed is not asked again until a retry. [`super::service::FoldService`]
//! owns the queue and its vault.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use async_trait::async_trait;
use memry_core::api::search::Search;
use memry_core::domain::fold_chunks::ChunkKey;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task::AbortHandle;

use super::agent::FoldAgentChoice;
use super::model::{ChunkAi, build_chunk_prompt, chunk_ai};
use super::sections::ParsedChunk;

/// Chunks a model writes at once (`FOLD_CONCURRENCY`).
pub const FOLD_CONCURRENCY: usize = 4;

const SCOPE: &str = "NoteFold";

/// The agent a run uses (`FoldAgent`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoldWriter {
    pub id: FoldAgentChoice,
    /// "Written by <label>".
    pub label: String,
    /// Part of the cache key, so a different model never reads another's chunks.
    pub model_id: String,
    /// The model a run asks for (`None`: the provider's default), the one `model_id` names.
    pub model: Option<String>,
}

/// Who writes the model levels: the agents the fold detects (`agent.ts`), behind a trait so the
/// queue runs without a provider in tests.
#[async_trait]
pub trait FoldBackend: Send + Sync {
    /// `resolveFoldAgent`: `None` is `no_agent`.
    async fn writer(&self, choice: FoldAgentChoice) -> Option<FoldWriter>;
    /// One structured run (`completeStructured`): the JSON object of the reply. The error text
    /// carries no key.
    async fn run(&self, writer: &FoldWriter, prompt: &str) -> Result<Value, String>;
    /// `resetFoldAgentDetection`.
    fn forget(&self);
}

/// The last model run, for the settings row (`FoldLastRun`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FoldLastRun {
    pub status: LastRunStatus,
    pub note_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum LastRunStatus {
    Idle,
    Writing,
    Failed,
}

/// `jobKey`.
pub fn job_key(key: &ChunkKey) -> String {
    format!("{}|{}|{}", key.chunk_hash, key.language, key.model_id)
}

/// Note ids in the order they asked (a JS `Set`).
#[derive(Debug, Clone, Default)]
pub struct NoteIds(Vec<String>);

impl NoteIds {
    fn of(note_id: &str) -> Self {
        Self(vec![note_id.to_owned()])
    }

    pub fn add(&mut self, note_id: &str) {
        if !self.has(note_id) {
            self.0.push(note_id.to_owned());
        }
    }

    pub fn has(&self, note_id: &str) -> bool {
        self.0.iter().any(|id| id == note_id)
    }

    pub fn last(&self) -> Option<&String> {
        self.0.last()
    }

    pub fn iter(&self) -> impl Iterator<Item = &String> {
        self.0.iter()
    }
}

/// A chunk queued or running.
pub struct Job {
    pub key: String,
    pub cache_key: ChunkKey,
    pub chunk: ParsedChunk,
    pub writer: FoldWriter,
    pub note_ids: NoteIds,
    /// The index of the vault the job was queued for; the result is written there.
    pub search: Arc<Search>,
}

/// The queue's state, one per open vault (Electron builds a service per vault open).
#[derive(Default)]
pub struct Queue {
    /// Queued or running, by job key.
    pub jobs: HashMap<String, Job>,
    /// Keys of the jobs not started yet, in order.
    pub waiting: VecDeque<String>,
    pub running: usize,
    /// The runs in flight, aborted when the vault closes.
    pub tasks: HashMap<String, AbortHandle>,
    /// Chunks whose last run failed, and the notes that asked; not run again until a retry.
    pub failed: HashMap<String, NoteIds>,
    pub last_failure: Option<String>,
    pub last_note_id: Option<String>,
    /// Chunks written so far.
    pub writes: u64,
    /// The write count after each chunk's last write, by job key: a fold that read the cache
    /// before one of its missing chunks was written reads again.
    pub written: HashMap<String, u64>,
}

impl Queue {
    /// `enqueue`.
    pub fn enqueue(
        &mut self,
        note_id: &str,
        chunk: &ParsedChunk,
        language: &str,
        writer: &FoldWriter,
        search: &Arc<Search>,
    ) {
        let cache_key = ChunkKey {
            chunk_hash: chunk.hash.clone(),
            language: language.to_owned(),
            model_id: writer.model_id.clone(),
        };
        let key = job_key(&cache_key);
        if let Some(asked) = self.failed.get_mut(&key) {
            asked.add(note_id);
            return;
        }
        self.last_note_id = Some(note_id.to_owned());
        if let Some(job) = self.jobs.get_mut(&key) {
            job.note_ids.add(note_id);
            return;
        }
        self.jobs.insert(
            key.clone(),
            Job {
                key: key.clone(),
                cache_key,
                chunk: chunk.clone(),
                writer: writer.clone(),
                note_ids: NoteIds::of(note_id),
                search: search.clone(),
            },
        );
        self.waiting.push_back(key);
    }

    /// The next job to start, once a run slot is free (`pump`'s loop condition).
    pub fn start_next(&mut self) -> Option<StartedJob> {
        if self.running >= FOLD_CONCURRENCY {
            return None;
        }
        let key = self.waiting.pop_front()?;
        let job = self.jobs.get(&key).expect("a waiting job is in `jobs`");
        self.running += 1;
        Some(StartedJob {
            key,
            cache_key: job.cache_key.clone(),
            chunk: job.chunk.clone(),
            writer: job.writer.clone(),
            search: job.search.clone(),
        })
    }

    /// A run ended: the job leaves the queue, and the notes that asked are returned for their
    /// update events. The notes are read at the end, so a note that joined while it ran is told.
    pub fn finish(&mut self, key: &str, outcome: &Result<(), String>) -> NoteIds {
        self.running -= 1;
        self.tasks.remove(key);
        let note_ids = self
            .jobs
            .remove(key)
            .map(|job| job.note_ids)
            .unwrap_or_default();
        match outcome {
            Ok(()) => {
                self.writes += 1;
                self.written.insert(key.to_owned(), self.writes);
                self.failed.remove(key);
                if let Some(last) = self.last_failure.clone()
                    && note_ids.has(&last)
                    && !self.failed.values().any(|ids| ids.has(&last))
                {
                    self.last_failure = None;
                }
            }
            Err(_) => {
                self.failed.insert(key.to_owned(), note_ids.clone());
                self.last_failure = note_ids.last().cloned();
            }
        }
        note_ids
    }

    /// `getLastRun`.
    pub fn last_run(&self) -> FoldLastRun {
        if self.running > 0 || !self.waiting.is_empty() {
            return FoldLastRun {
                status: LastRunStatus::Writing,
                note_id: self.last_note_id.clone(),
            };
        }
        match &self.last_failure {
            Some(note_id) => FoldLastRun {
                status: LastRunStatus::Failed,
                note_id: Some(note_id.clone()),
            },
            None => FoldLastRun {
                status: LastRunStatus::Idle,
                note_id: None,
            },
        }
    }

    /// The retry of `retry(noteId)`: the chunks `note_id` asked for may run again.
    pub fn forget_failures_of(&mut self, note_id: &str) {
        self.failed.retain(|_, ids| !ids.has(note_id));
        if self.last_failure.as_deref() == Some(note_id) {
            self.last_failure = None;
        }
    }

    /// The vault closed: nothing queued starts, nothing running reports.
    pub fn clear(&mut self) -> HashSet<String> {
        for task in self.tasks.values() {
            task.abort();
        }
        let keys = self.jobs.keys().cloned().collect();
        *self = Self::default();
        keys
    }
}

/// What a run needs, taken out of the queue so the lock is not held across it.
pub struct StartedJob {
    pub key: String,
    pub cache_key: ChunkKey,
    pub chunk: ParsedChunk,
    pub writer: FoldWriter,
    pub search: Arc<Search>,
}

/// `execute`: one model run of a chunk, its reply checked against the chunk and cached. Invalid
/// JSON, a reply of the wrong shape or a failed run leaves the chunk on its local fallback, and
/// the note reports `failed` until the user retries.
pub async fn execute(
    backend: &dyn FoldBackend,
    job: &StartedJob,
    now_ms: i64,
) -> Result<(), String> {
    let outcome = write(backend, job, now_ms).await;
    if let Err(error) = &outcome {
        tracing::warn!(
            scope = SCOPE,
            chunk_hash = job.cache_key.chunk_hash,
            model_id = job.cache_key.model_id,
            language = job.cache_key.language,
            "fold chunk failed: {error}"
        );
    }
    outcome
}

async fn write(backend: &dyn FoldBackend, job: &StartedJob, now_ms: i64) -> Result<(), String> {
    let prompt = build_chunk_prompt(&job.chunk, &job.cache_key.language);
    let reply = backend.run(&job.writer, &prompt).await?;
    let value: ChunkAi = chunk_ai(&reply, &job.chunk)?;
    let payload = serde_json::to_string(&value).map_err(|error| error.to_string())?;
    let (search, key) = (job.search.clone(), job.cache_key.clone());
    tokio::task::spawn_blocking(move || search.put_fold_chunk(&key, &payload, now_ms))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}
