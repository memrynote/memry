//! The `memry-embed` thread: it serves one request at a time and answers through a [`Slot`].

use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, PoisonError, Weak};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use super::{
    AudioOpened, EMBEDDING_DIMENSION, EmbedError, EmbeddingService, Engine, ModelLoader,
    ModelProgress, Phase, lock,
};
use crate::embedding::download::Abort;

pub(super) enum Request {
    Load,
    Embed(String),
    /// Each audio op is its own request with its own deadline, so text runs between the windows
    /// of a recording (Electron's timer is per window, embeddings.ts:792-798).
    OpenAudio(PathBuf),
    AudioWindow {
        recording: u64,
        window: u32,
    },
}

pub(super) enum Reply {
    Loaded,
    Embedded(Vec<f32>),
    AudioOpened(AudioOpened),
}

impl Reply {
    /// The width of a vector in the reply that is not [`EMBEDDING_DIMENSION`] wide.
    pub(super) fn wrong_width(&self) -> Option<usize> {
        match self {
            Self::Embedded(vector) => Some(vector.len()).filter(|w| *w != EMBEDDING_DIMENSION),
            Self::Loaded | Self::AudioOpened(_) => None,
        }
    }
}

#[derive(Debug)]
pub(super) enum Fault {
    Load(String),
    Inference(String),
    /// The request's input cannot be used (a recording the worker cannot read or decode).
    Input(String),
    /// A panic, or a model process that died under the request; the model was dropped.
    Crashed(String),
    TimedOut,
    /// The thread was stopped or replaced before it answered.
    Retired,
}

/// The answer to one request, filled once: by the thread, or by a stop that retires it.
#[derive(Default)]
pub(super) struct Slot {
    value: Mutex<Option<Result<Reply, Fault>>>,
    filled: Condvar,
}

impl Slot {
    pub(super) fn fill(&self, result: Result<Reply, Fault>) {
        let mut value = lock(&self.value);
        if value.is_none() {
            *value = Some(result);
            self.filled.notify_all();
        }
    }

    pub(super) fn is_filled(&self) -> bool {
        lock(&self.value).is_some()
    }

    pub(super) fn wait_until(&self, deadline: Instant) -> Option<Result<Reply, Fault>> {
        let mut value = lock(&self.value);
        loop {
            if let Some(result) = value.take() {
                return Some(result);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            value = self
                .filled
                .wait_timeout(value, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

pub(super) struct Job {
    pub(super) request: Request,
    pub(super) slot: Arc<Slot>,
    pub(super) deadline: Instant,
}

fn panic_message(panic: &(dyn Any + Send)) -> String {
    let text = panic
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("unknown panic");
    format!("Embedding model panicked: {text}")
}

/// The `memry-embed` thread.
pub(super) fn work(
    service: &Weak<EmbeddingService>,
    loader: &dyn ModelLoader,
    generation: u64,
    queue: &mpsc::Receiver<Job>,
    cancel: &CancellationToken,
    idle: Duration,
) {
    loader.prepare_thread();
    let progress = |event: ModelProgress| {
        if let Some(service) = service.upgrade() {
            service.apply_progress(generation, event);
        }
    };
    let mut engine: Option<Box<dyn Engine>> = None;
    loop {
        let job = match queue.recv_timeout(idle) {
            Ok(job) => job,
            Err(RecvTimeoutError::Timeout) => match service.upgrade() {
                Some(service) if !service.retire_idle(generation) => continue,
                _ => return,
            },
            Err(RecvTimeoutError::Disconnected) => return,
        };
        if cancel.is_cancelled() {
            return;
        }
        if job.slot.is_filled() {
            continue;
        }
        let abort = Abort {
            cancel: cancel.clone(),
            deadline: job.deadline,
        };
        let served = catch_unwind(AssertUnwindSafe(|| {
            serve(loader, &mut engine, &job.request, &abort, &progress)
        }));
        let result = served.unwrap_or_else(|panic| {
            engine = None;
            Err(Fault::Crashed(panic_message(&*panic)))
        });
        job.slot.fill(result);
    }
}

fn serve(
    loader: &dyn ModelLoader,
    engine: &mut Option<Box<dyn Engine>>,
    request: &Request,
    abort: &Abort,
    progress: &(dyn Fn(ModelProgress) + Sync),
) -> Result<Reply, Fault> {
    let loaded = match engine {
        Some(loaded) => loaded,
        None => {
            // embedding-worker.ts:123, :259, :265.
            progress(ModelProgress::new(
                Phase::Loading,
                0,
                "Initializing model...",
            ));
            match loader.load(abort, progress) {
                Ok(loaded) => {
                    progress(ModelProgress::new(Phase::Ready, 100, "Model ready"));
                    engine.insert(loaded)
                }
                Err(message) => {
                    progress(ModelProgress::new(
                        Phase::Error,
                        0,
                        format!("Error: {message}"),
                    ));
                    return Err(Fault::Load(message));
                }
            }
        }
    };
    let outcome = match request {
        Request::Load => return Ok(Reply::Loaded),
        Request::Embed(text) => loaded.embed_text(text).map(Reply::Embedded),
        Request::OpenAudio(path) => loaded.open_audio(path).map(Reply::AudioOpened),
        Request::AudioWindow { recording, window } => loaded
            .embed_audio_window(*recording, *window)
            .map(Reply::Embedded),
    };
    outcome.map_err(|error| match error {
        EmbedError::Failed(message) => Fault::Inference(message),
        EmbedError::Input(message) => Fault::Input(message),
        EmbedError::Crashed(message) => {
            *engine = None;
            Fault::Crashed(message)
        }
    })
}
