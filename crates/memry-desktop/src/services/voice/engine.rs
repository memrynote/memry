//! The local Whisper engine: whisper.cpp in the `memry-ml-worker` sidecar, on a [`Supervisor`] of
//! its own, as Electron's `VoiceModelBridge` drives its voice transcription utility process
//! (`apps/desktop/src/main/inbox/voice-model.ts`). The child starts on the first transcription,
//! loads the model then (Electron's `loadVoicePipeline`, with its `loading` and `ready` progress),
//! exits 30 s after its last call (`IDLE_SHUTDOWN_MS`), and is killed by a start past 10 s
//! (`START_TIMEOUT_MS`) or a request past 5 min (`REQUEST_TIMEOUT_MS`); the next call starts a new
//! one. A crash fails only the calls waiting on it.
//!
//! "Loaded" means the child that loaded the model still runs: an idle exit, a crash, a timeout
//! and [`LocalEngine::stop`] all end it, so the status turns back to not loaded with no
//! bookkeeping of its own. Transcriptions run one at a time.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use memry_ml_worker::{Limits, Supervisor, SystemClock, WorkerError};

use super::model::MODEL_NAME;
use crate::embedding::service::{ModelProgress, Phase};
use crate::services::file_text::WorkerPaths;

/// Electron's `START_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS` and `IDLE_SHUTDOWN_MS`, with the
/// supervisor's crash bound (three in a row pause the worker for ten minutes).
pub fn limits() -> Limits {
    Limits {
        start_timeout: Duration::from_secs(10),
        op_timeout: Duration::from_secs(5 * 60),
        idle_exit: Duration::from_secs(30),
        ..Limits::default()
    }
}

pub struct LocalEngine {
    supervisor: Supervisor,
    model: PathBuf,
    state: Mutex<State>,
    /// Held for a whole transcription, so two never race to load the model.
    job: Mutex<()>,
}

#[derive(Default)]
struct State {
    /// The child that loaded the model.
    loaded_by: Option<u32>,
    loading: bool,
    /// The last load's or transcription's failure, cleared by the next success.
    error: Option<String>,
}

impl LocalEngine {
    /// Starts nothing. `model` is the ggml file ([`super::model::VoiceModel::model_path`]).
    pub fn new(paths: &WorkerPaths, model: PathBuf, limits: Limits) -> Arc<Self> {
        let supervisor = Supervisor::new(
            paths.program.clone(),
            vec!["--pdfium-dir".into(), paths.pdfium_dir.clone().into()],
            limits,
            Arc::new(SystemClock),
        );
        Arc::new(Self {
            supervisor,
            model,
            state: Mutex::default(),
            job: Mutex::default(),
        })
    }

    /// `transcribeWithLocalModel`: the text in `wav` (a WAV file) in `language`. The first call
    /// of each child loads the model, reporting Electron's `loading` then `ready` (or `error`) on
    /// `progress`.
    pub fn transcribe(
        &self,
        wav: &[u8],
        language: &str,
        progress: &(dyn Fn(ModelProgress) + Sync),
    ) -> Result<String, WorkerError> {
        let _job = lock(&self.job);
        if !self.loaded() {
            self.load(progress)?;
        }
        let outcome = self.supervisor.transcribe(&self.model, language, wav);
        lock(&self.state).error = outcome.as_ref().err().map(ToString::to_string);
        outcome
    }

    fn load(&self, progress: &(dyn Fn(ModelProgress) + Sync)) -> Result<(), WorkerError> {
        {
            let mut state = lock(&self.state);
            state.loading = true;
            state.error = None;
        }
        progress(ModelProgress::new(
            Phase::Loading,
            0,
            format!("Initializing {MODEL_NAME}..."),
        ));
        let outcome = self.supervisor.transcribe_load(&self.model);
        let pid = self.supervisor.pid();
        let mut state = lock(&self.state);
        state.loading = false;
        match &outcome {
            Ok(()) => {
                state.loaded_by = pid;
                drop(state);
                progress(ModelProgress::new(
                    Phase::Ready,
                    100,
                    format!("{MODEL_NAME} ready"),
                ));
            }
            Err(error) => {
                tracing::warn!(scope = "Voice", "the Whisper model did not load: {error}");
                state.error = Some(error.to_string());
                drop(state);
                progress(ModelProgress::new(Phase::Error, 0, error.to_string()));
            }
        }
        outcome
    }

    pub fn loaded(&self) -> bool {
        let running = self.supervisor.pid();
        running.is_some() && lock(&self.state).loaded_by == running
    }

    pub fn loading(&self) -> bool {
        lock(&self.state).loading
    }

    pub fn error(&self) -> Option<String> {
        lock(&self.state).error.clone()
    }

    /// Kills the child, if one runs, which fails a transcription in flight at once. The next
    /// call starts a new one.
    pub fn stop(&self) {
        self.supervisor.stop();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
