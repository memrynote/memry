//! `EmbeddingService`: the text model's owner, a port of Electron's `EmbeddingModelBridge`
//! (`apps/desktop/src/main/lib/embeddings.ts`) without its utility process. One OS thread,
//! `memry-embed`, owns the loaded model and serves one request at a time. It starts on the first
//! request (`start`, embeddings.ts:606-673), loads the model (downloading it first) on the first
//! request it serves, and exits with the model 30 s after its last request
//! (`IDLE_SHUTDOWN_MS`, :931-950). A request waits at most 15 min, the download included
//! (`REQUEST_TIMEOUT_MS`, :133). ONNX Runtime runs in this process, so a panic in a load or
//! an inference is caught per request and counted the way the bridge counts a worker crash
//! (`failProcess`, :820-835). Failed loads back off through [`Breaker`].
//!
//! The model itself is a [`ModelLoader`]: the app's loader downloads the pinned files through
//! [`super::download::ModelSource`] and loads `memry_ml::EmbeddingEngine`.

#[cfg(test)]
mod tests;
mod thread;

use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use self::thread::{Fault, Job, Reply, Request, Slot, work};
use super::breaker::{Breaker, RETRY_BASE};
use super::download::Abort;
use crate::session::Session;
use crate::shell::shutdown::StepFn;

/// `MODEL_NAME`.
pub const MODEL_NAME: &str = "EmbeddingGemma 2";
/// Stored vector width (`EMBEDDING_DIMENSION`).
pub const EMBEDDING_DIMENSION: usize = 256;
/// `MIN_CONTENT_LENGTH`: shorter text, in UTF-16 units after a JS `trim`, is not embedded.
const MIN_CONTENT_LENGTH: usize = 10;

/// `EmbeddingProgressPhase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Downloading,
    Loading,
    Ready,
    Error,
}

/// One `settings:embeddingProgress` event of the text model (embeddings.ts:206-218).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelProgress {
    pub phase: Phase,
    pub progress: u8,
    pub status: String,
}

impl ModelProgress {
    pub fn new(phase: Phase, progress: u8, status: impl Into<String>) -> Self {
        Self {
            phase,
            progress,
            status: status.into(),
        }
    }
}

/// A loaded model. Owned by the embedding thread, which serves one request at a time.
pub trait Engine: Send {
    fn embed_text(&mut self, text: &str) -> Result<Vec<f32>, String>;
}

/// Makes the model present and loads it, on the embedding thread.
pub trait ModelLoader: Send + Sync + 'static {
    /// Runs first on every embedding thread: lowers its priority.
    fn prepare_thread(&self) {}

    /// Downloads what is missing (stopping on `abort`), then loads the model.
    fn load(
        &self,
        abort: &Abort,
        progress: &(dyn Fn(ModelProgress) + Sync),
    ) -> Result<Box<dyn Engine>, String>;
}

/// The bridge's timers. Tests shorten them; the app uses [`Timing::default`].
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// `REQUEST_TIMEOUT_MS`.
    pub request_deadline: Duration,
    /// `IDLE_SHUTDOWN_MS`.
    pub idle_unload: Duration,
    /// `LOAD_RETRY_BASE_DELAY_MS`.
    pub retry_base: Duration,
    /// `SHUTDOWN_TIMEOUT_MS`: how long a quit waits for the thread to finish its request.
    pub stop_wait: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            request_deadline: Duration::from_secs(15 * 60),
            idle_unload: Duration::from_secs(30),
            retry_base: RETRY_BASE,
            stop_wait: Duration::from_secs(3),
        }
    }
}

/// `ModelInfo` without `downloaded`, which the loader's files answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelStatus {
    pub name: &'static str,
    pub dimension: usize,
    pub loaded: bool,
    pub loading: bool,
    pub error: Option<String>,
}

pub type ProgressSink = Arc<dyn Fn(ModelProgress) + Send + Sync>;

struct Worker {
    jobs: mpsc::Sender<Job>,
    cancel: CancellationToken,
    thread: JoinHandle<()>,
    pending: Vec<Weak<Slot>>,
}

struct State {
    /// Bumped whenever the thread is retired; a late answer of an older thread changes nothing.
    generation: u64,
    worker: Option<Worker>,
    /// Retired threads that may still be finishing a request, for the quit to wait on.
    retired: Vec<JoinHandle<()>>,
    loaded: bool,
    loading: bool,
    error: Option<String>,
    breaker: Breaker,
}

pub struct EmbeddingService {
    loader: Arc<dyn ModelLoader>,
    progress: ProgressSink,
    timing: Timing,
    state: Mutex<State>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// JS `String.prototype.trim`: Rust's `White_Space` without U+0085, plus U+FEFF.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

impl EmbeddingService {
    pub fn new(loader: Arc<dyn ModelLoader>, progress: ProgressSink, timing: Timing) -> Arc<Self> {
        Arc::new(Self {
            loader,
            progress,
            timing,
            state: Mutex::new(State {
                generation: 0,
                worker: None,
                retired: Vec::new(),
                loaded: false,
                loading: false,
                error: None,
                breaker: Breaker::new(timing.retry_base),
            }),
        })
    }

    pub fn status(&self) -> ModelStatus {
        let state = lock(&self.state);
        ModelStatus {
            name: MODEL_NAME,
            dimension: EMBEDDING_DIMENSION,
            loaded: state.loaded,
            loading: state.loading,
            error: state.error.clone(),
        }
    }

    /// `initEmbeddingModel`: whether the model is loaded. Short-circuits while loads back off.
    pub fn load(self: &Arc<Self>) -> bool {
        if lock(&self.state).breaker.is_open(Instant::now()) {
            return false;
        }
        let (generation, result) = self.request(Request::Load);
        let mut state = lock(&self.state);
        if state.generation != generation {
            return false;
        }
        match result {
            Ok(_) => {
                state.loaded = true;
                state.loading = false;
                state.error = None;
                if state.breaker.embed_failures == 0 {
                    state.breaker.record_success();
                }
                true
            }
            Err(fault) => {
                Self::load_failed(&mut state, fault);
                false
            }
        }
    }

    /// `generateEmbedding`: the text's vector, or `None` when it is too short, loads back off, or
    /// the model failed.
    pub fn embed(self: &Arc<Self>, text: &str) -> Option<Vec<f32>> {
        if js_trim(text).encode_utf16().count() < MIN_CONTENT_LENGTH {
            return None;
        }
        let was_loaded = {
            let state = lock(&self.state);
            if state.breaker.is_open(Instant::now()) {
                return None;
            }
            state.loaded
        };
        let (generation, result) = self.request(Request::Embed(text.to_owned()));
        let mut state = lock(&self.state);
        if state.generation != generation {
            return None;
        }
        match result {
            Ok(Reply::Embedded(vector)) if vector.len() == EMBEDDING_DIMENSION => {
                state.loaded = true;
                state.loading = false;
                state.error = None;
                state.breaker.embed_failures = 0;
                state.breaker.record_success();
                Some(vector)
            }
            Ok(Reply::Embedded(vector)) => {
                tracing::error!(
                    scope = "Embeddings",
                    "Unexpected dimension: {} (expected {EMBEDDING_DIMENSION})",
                    vector.len()
                );
                None
            }
            Ok(Reply::Loaded) | Err(Fault::Retired | Fault::TimedOut) => None,
            Err(Fault::Panicked(message)) => {
                // The thread dropped the model: the bridge's crashed worker (:709-735).
                state.loaded = false;
                state.loading = false;
                tracing::error!(scope = "Embeddings", "Generation failed: {message}");
                state.error = Some(message);
                state.breaker.embed_failures += 1;
                Self::record_failure(&mut state);
                None
            }
            Err(Fault::Load(message) | Fault::Inference(message)) => {
                tracing::warn!(scope = "Embeddings", "Embedding worker failed: {message}");
                state.error = Some(message);
                state.loading = false;
                if !was_loaded {
                    Self::record_failure(&mut state);
                }
                None
            }
        }
    }

    /// `resetEmbeddingModelFailure`: the next load is attempted at once.
    pub fn reset_failure(&self) {
        lock(&self.state).breaker.clear();
    }

    /// `stopEmbeddingModel`: every waiting request ends, a download stops (its part file stays
    /// for the next attempt), and the thread drops the model once its running inference returns.
    pub fn stop(&self) {
        let mut state = lock(&self.state);
        Self::retire(&mut state);
    }

    /// Stops the model when the vault closes, so no request of the closing vault is still
    /// served when the next one opens.
    pub fn register(self: &Arc<Self>, session: &Session) {
        let service = Arc::downgrade(self);
        session.on_close(
            "embedding",
            Arc::new(move |_| {
                if let Some(service) = service.upgrade() {
                    service.stop();
                }
            }),
        );
    }

    /// The `stop-utility-processes` quit step: stop, then wait for the thread to finish within
    /// [`Timing::stop_wait`] and what is left of the quit.
    pub fn shutdown_step(self: &Arc<Self>) -> StepFn {
        let service = Arc::downgrade(self);
        Arc::new(move |_, deadline| {
            let service = service.clone();
            Box::pin(async move {
                let Some(service) = service.upgrade() else {
                    return Ok(());
                };
                service.stop();
                let until = tokio::time::Instant::now() + deadline.cap(service.timing.stop_wait);
                while !service.threads_finished() {
                    if tokio::time::Instant::now() >= until {
                        tracing::warn!(
                            scope = "Embeddings",
                            "the embedding thread did not finish before the quit"
                        );
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Ok(())
            })
        })
    }

    fn threads_finished(&self) -> bool {
        let mut state = lock(&self.state);
        state.retired.retain(|thread| !thread.is_finished());
        state.retired.is_empty()
    }

    fn request(self: &Arc<Self>, request: Request) -> (u64, Result<Reply, Fault>) {
        let deadline = Instant::now() + self.timing.request_deadline;
        let slot = Arc::new(Slot::default());
        let generation = {
            let mut state = lock(&self.state);
            if let Err(error) = self.ensure_worker(&mut state) {
                return (
                    state.generation,
                    Err(Fault::Load(format!(
                        "the embedding thread did not start: {error}"
                    ))),
                );
            }
            state.loading = !state.loaded;
            let worker = state.worker.as_mut().expect("ensured above");
            worker.pending.retain(|slot| slot.strong_count() > 0);
            worker.pending.push(Arc::downgrade(&slot));
            let job = Job {
                request,
                slot: slot.clone(),
                deadline,
            };
            if worker.jobs.send(job).is_err() {
                return (state.generation, Err(Fault::Retired));
            }
            state.generation
        };
        match slot.wait_until(deadline) {
            Some(result) => (generation, result),
            None => {
                self.time_out(generation);
                (generation, Err(Fault::TimedOut))
            }
        }
    }

    fn ensure_worker(self: &Arc<Self>, state: &mut State) -> std::io::Result<()> {
        if state.worker.is_some() {
            return Ok(());
        }
        let (jobs, queue) = mpsc::channel();
        let cancel = CancellationToken::new();
        let thread = {
            let (service, loader, cancel) =
                (Arc::downgrade(self), self.loader.clone(), cancel.clone());
            let (generation, idle) = (state.generation, self.timing.idle_unload);
            std::thread::Builder::new()
                .name("memry-embed".into())
                .spawn(move || work(&service, &*loader, generation, &queue, &cancel, idle))?
        };
        state.worker = Some(Worker {
            jobs,
            cancel,
            thread,
            pending: Vec::new(),
        });
        Ok(())
    }

    /// `failProcess` for a request past its deadline: the thread is let go (an inference cannot
    /// be interrupted; it drops the model when it returns) and the failure feeds the backoff.
    fn time_out(&self, generation: u64) {
        let mut state = lock(&self.state);
        if state.generation != generation {
            return;
        }
        state.error = Some("Embedding request timed out".to_owned());
        state.breaker.embed_failures += 1;
        Self::record_failure(&mut state);
        Self::retire(&mut state);
    }

    fn retire(state: &mut State) {
        let Some(worker) = state.worker.take() else {
            return;
        };
        state.generation += 1;
        state.loaded = false;
        state.loading = false;
        worker.cancel.cancel();
        for slot in worker.pending.iter().filter_map(Weak::upgrade) {
            slot.fill(Err(Fault::Retired));
        }
        state.retired.retain(|thread| !thread.is_finished());
        state.retired.push(worker.thread);
    }

    fn load_failed(state: &mut State, fault: Fault) {
        state.loading = false;
        state.error = Some(match fault {
            Fault::Load(message) | Fault::Inference(message) | Fault::Panicked(message) => message,
            Fault::TimedOut | Fault::Retired => return,
        });
        Self::record_failure(state);
    }

    fn record_failure(state: &mut State) {
        let error = state.error.as_deref().unwrap_or_default();
        match state.breaker.record_failure(Instant::now()) {
            Some(delay) => tracing::warn!(
                scope = "Embeddings",
                retry_in_ms = delay.as_millis() as u64,
                "Embedding model failed — backing off before retry: {error}"
            ),
            None => tracing::error!(
                scope = "Embeddings",
                "Embedding model failed repeatedly — giving up until restart: {error}"
            ),
        }
    }

    /// `applyProgress`: a progress event of the current thread updates the status, then reaches
    /// the windows.
    fn apply_progress(&self, generation: u64, progress: ModelProgress) {
        {
            let mut state = lock(&self.state);
            if state.generation != generation {
                return;
            }
            match progress.phase {
                Phase::Ready => {
                    state.loaded = true;
                    state.loading = false;
                    state.error = None;
                }
                Phase::Error => {
                    state.loaded = false;
                    state.loading = false;
                    state.error = Some(progress.status.clone());
                }
                Phase::Downloading | Phase::Loading => {
                    state.loading = true;
                    state.error = None;
                }
            }
        }
        (self.progress)(progress);
    }

    /// Lets an idle thread go, unless a request reached it while it timed out.
    fn retire_idle(&self, generation: u64) -> bool {
        let mut state = lock(&self.state);
        if state.generation != generation {
            return true;
        }
        let waiting = state.worker.as_ref().is_some_and(|worker| {
            worker
                .pending
                .iter()
                .filter_map(Weak::upgrade)
                .any(|slot| !slot.is_filled())
        });
        if waiting {
            return false;
        }
        state.worker = None;
        state.generation += 1;
        state.loaded = false;
        state.loading = false;
        true
    }
}
