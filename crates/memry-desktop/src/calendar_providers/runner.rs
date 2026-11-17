//! The calendar runner (`ics/ics-runner.ts`): one task per open vault that refreshes the due
//! subscribed feeds, the first pass at once and then every [`TICK`]. Each feed keeps its own
//! interval (15 min to 24 h) in the core; the tick only bounds how late a due feed is picked up.
//! A pass never overlaps the next, since one task runs them in turn.
//!
//! Owned by the session: the open hook starts the task, the close hook (`calendar`) cancels it
//! and waits for it, so no fetch outlives its vault and no write lands after the close. The
//! `stop-schedulers` shutdown step does the same and keeps any later open from starting one.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use super::feeds::{FeedsError, IcsFeeds};
use crate::session::{OpenStage, OpenVault, Session};
use crate::shell::shutdown::StepFn;

/// `TICK_MS`.
pub const TICK: Duration = Duration::from_secs(5 * 60);
/// How long a close or the shutdown step waits for a pass to let go: a fetch is dropped at
/// once, so this only covers a core write that already started.
pub const STOP_WAIT: Duration = Duration::from_secs(2);
const SCOPE: &str = "calendar_runner";

struct Running {
    cancel: CancellationToken,
    /// Disconnected once the task has ended (its sender is dropped with it).
    ended: mpsc::Receiver<()>,
}

#[derive(Default)]
struct State {
    /// Set by `stop-schedulers`: no open starts a task again.
    halted: bool,
    running: Option<Running>,
}

pub struct CalendarRunner {
    feeds: Arc<IcsFeeds>,
    runtime: Handle,
    tick: Duration,
    state: Mutex<State>,
}

impl CalendarRunner {
    /// `tick` is [`TICK`] in the app.
    pub fn new(feeds: Arc<IcsFeeds>, runtime: Handle, tick: Duration) -> Arc<Self> {
        Arc::new(Self {
            feeds,
            runtime,
            tick,
            state: Mutex::new(State::default()),
        })
    }

    /// Starts with every open, once the vault is open (it needs no account: a feed URL needs no
    /// sign-in); stops with every close.
    pub fn register(self: &Arc<Self>, session: &Session) {
        let runner = self.clone();
        session.on_open(
            "calendar-runner",
            OpenStage::SyncStart,
            Arc::new(move |open| {
                runner.start(open);
                Ok(())
            }),
        );
        let runner = self.clone();
        session.on_close(
            "calendar",
            Arc::new(move |_| {
                runner.stop(STOP_WAIT);
            }),
        );
    }

    /// The `stop-schedulers` step: stops the task and keeps any later open from starting one.
    pub fn shutdown_step(self: &Arc<Self>) -> StepFn {
        let runner = self.clone();
        Arc::new(move |_, deadline| {
            let runner = runner.clone();
            Box::pin(async move {
                lock(&runner.state).halted = true;
                let wait = deadline.cap(STOP_WAIT);
                let stopped = tokio::task::spawn_blocking(move || runner.stop(wait))
                    .await
                    .map_err(|error| error.to_string())?;
                if stopped {
                    Ok(())
                } else {
                    Err("the calendar runner did not stop in time".to_owned())
                }
            })
        })
    }

    /// Starts the task for `open`, replacing one that still runs.
    pub fn start(&self, open: &OpenVault) {
        let mut state = lock(&self.state);
        if state.halted {
            return;
        }
        if let Some(previous) = state.running.take() {
            previous.cancel.cancel();
        }
        let cancel = CancellationToken::new();
        let (ended_tx, ended) = mpsc::channel::<()>();
        let (feeds, open, token, tick) =
            (self.feeds.clone(), open.clone(), cancel.clone(), self.tick);
        self.runtime.spawn(async move {
            let _ended = ended_tx;
            loop {
                match feeds.refresh_due(&open, &token).await {
                    Ok(()) => {}
                    // A device without its signing key cannot write the mirror; the next pass
                    // tries again (sign-in creates it).
                    Err(FeedsError::Auth(error)) => {
                        tracing::debug!(scope = SCOPE, "calendar feed pass skipped: {error}");
                    }
                    Err(error) => {
                        tracing::warn!(scope = SCOPE, "calendar feed refresh pass failed: {error}");
                    }
                }
                tokio::select! {
                    () = token.cancelled() => break,
                    () = tokio::time::sleep(tick) => {}
                }
            }
        });
        state.running = Some(Running { cancel, ended });
    }

    /// Cancels the task and waits at most `wait` for it to end. `true` when none runs any more.
    pub fn stop(&self, wait: Duration) -> bool {
        let Some(running) = lock(&self.state).running.take() else {
            return true;
        };
        running.cancel.cancel();
        match running.ended.recv_timeout(wait) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => true,
            Err(RecvTimeoutError::Timeout) => {
                tracing::warn!(scope = SCOPE, ?wait, "the calendar runner overran its stop");
                false
            }
        }
    }

    pub fn is_running(&self) -> bool {
        lock(&self.state).running.is_some()
    }
}

fn lock(state: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}
