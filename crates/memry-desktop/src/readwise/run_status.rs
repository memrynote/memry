//! Live Readwise run state for the status IPC (`run-status.ts`, #1418): the run in progress
//! and the last failure, both in memory. A failure the user must fix also parks the schedule
//! through `LastRun`, which persists (`run_state`).

use std::sync::{Arc, Mutex};

use super::client::ReadwiseErrorKind;
use super::run_types::RunError;

/// A stage change notifies at once; a per-book tick at most this often.
const PROGRESS_NOTIFY_MS: i64 = 300;

/// `ReadwiseRunProgress.stage`. `WaitingForSync` is D8: a run starts after memry sync pulled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    WaitingForSync,
    Reading,
    Writing,
}

/// `ReadwiseRunProgress`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunProgress {
    pub stage: Stage,
    /// Books to write, once the export has been read.
    pub planned: Option<u64>,
    pub done: u64,
}

/// `ReadwiseRunError`: `kind` is a `READWISE_ERROR_KINDS` code, `detail` the failure's own
/// text for `unexpected` only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunFailure {
    pub kind: &'static str,
    pub detail: Option<String>,
}

/// The contract's code of a Readwise failure.
pub fn kind_code(kind: ReadwiseErrorKind) -> &'static str {
    match kind {
        ReadwiseErrorKind::InvalidToken => "invalid-token",
        ReadwiseErrorKind::SubscriptionExpired => "subscription-expired",
        ReadwiseErrorKind::RateLimited => "rate-limited",
        ReadwiseErrorKind::Network => "network",
        ReadwiseErrorKind::Server => "server",
    }
}

/// `classifyRunFailure`: the failure a run ended with, as the status shows it. `None` for a run
/// that never started because another one was running.
pub fn classify(error: &RunError) -> Option<RunFailure> {
    match error {
        RunError::AlreadyRunning => None,
        RunError::Readwise(error) => Some(RunFailure {
            kind: error.kind().map_or("unexpected", kind_code),
            detail: None,
        }),
        RunError::Failed(detail) => Some(RunFailure {
            kind: "unexpected",
            detail: Some(detail.clone()),
        }),
    }
}

#[derive(Default)]
struct Live {
    progress: Option<RunProgress>,
    failure: Option<RunFailure>,
    last_notify: Option<i64>,
}

type Listener = Box<dyn Fn() + Send + Sync>;

/// The engine's live status. Listeners re-read it when told it changed.
pub struct RunStatus {
    live: Mutex<Live>,
    listeners: Mutex<Vec<Listener>>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl RunStatus {
    pub fn new(clock: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self {
            live: Mutex::new(Live::default()),
            listeners: Mutex::new(Vec::new()),
            clock,
        }
    }

    /// `onReadwiseStatusChanged`: tells the windows to re-read the status.
    pub fn on_change(&self, listener: impl Fn() + Send + Sync + 'static) {
        let mut listeners = self.listeners.lock().unwrap_or_else(|e| e.into_inner());
        listeners.push(Box::new(listener));
    }

    fn live(&self) -> std::sync::MutexGuard<'_, Live> {
        self.live.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Called with the status unlocked: a listener reads it back.
    fn notify(&self) {
        self.live().last_notify = Some((self.clock)());
        let listeners = self.listeners.lock().unwrap_or_else(|e| e.into_inner());
        for listener in listeners.iter() {
            listener();
        }
    }

    pub fn progress(&self) -> Option<RunProgress> {
        self.live().progress
    }

    /// `setRunProgress`. A `tick` within [`PROGRESS_NOTIFY_MS`] of the last notice is stored
    /// without one, so a big run does not flood IPC.
    pub fn set_progress(&self, progress: Option<RunProgress>, tick: bool) {
        let recent = {
            let mut live = self.live();
            live.progress = progress;
            (live.last_notify).is_some_and(|at| (self.clock)() - at < PROGRESS_NOTIFY_MS)
        };
        if !(tick && recent) {
            self.notify();
        }
    }

    pub fn failure(&self) -> Option<RunFailure> {
        self.live().failure.clone()
    }

    pub fn clear_failure(&self) {
        let cleared = self.live().failure.take().is_some();
        if cleared {
            self.notify();
        }
    }

    /// `recordRunFailure`.
    pub fn record_failure(&self, error: &RunError) {
        let Some(failure) = classify(error) else {
            return;
        };
        self.live().failure = Some(failure);
        self.notify();
    }
}
