//! The app's side of the worker: one child process, started on the first call and stopped after
//! [`Limits::idle_exit`] of quiet. A call that outlives its timeout kills the child, and the next
//! call starts a new one. A child that exits on its own [`Limits::crash_limit`] times in a row
//! pauses the worker for [`Limits::crash_cooldown`]. Ports `apps/desktop/src/main/file-text/
//! ocr-engine.ts:23-167` and the call timeout of `pdf-host.ts:23-24,109-136`.
//!
//! Lock order: the state lock, then a child's pending map. The stdout reader takes the pending
//! map alone and the state lock alone, never one inside the other, so a call that holds the
//! state lock while it waits for `Ready` is answered. A child's stdin lock is taken with no other
//! lock held: a write blocks while the child reads nothing (a hung op), and the timeout kill,
//! [`Supervisor::stop`] and the idle exit must still get the state lock to end it.

mod child;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::thread;
use std::time::{Duration, Instant};

use self::child::{forward_stderr, read_replies, watch_idle};
use crate::frame::{FrameError, write_frame};
use crate::op::{Request, Response};
use crate::priority;
use crate::serve::READY_ID;
/// The child parses untrusted files, so it gets none of the app's environment but these. Windows
/// loads system DLLs through `SystemRoot`.
const INHERITED_ENV: &[&str] = if cfg!(windows) { &["SystemRoot"] } else { &[] };

#[derive(Debug, Clone)]
pub struct Limits {
    /// Until the child's `Ready` frame (`ocr-engine.ts:23`).
    pub start_timeout: Duration,
    /// Per op; past it the child is killed (`pdf-host.ts:23`).
    pub op_timeout: Duration,
    /// [`Limits::op_timeout`] of an OCR read (`ocr-engine.ts:24`).
    pub ocr_timeout: Duration,
    pub idle_exit: Duration,
    pub crash_limit: u32,
    pub crash_cooldown: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            start_timeout: Duration::from_secs(15),
            op_timeout: Duration::from_secs(120),
            ocr_timeout: Duration::from_secs(180),
            idle_exit: Duration::from_secs(60),
            crash_limit: 3,
            crash_cooldown: Duration::from_secs(10 * 60),
        }
    }
}

impl Limits {
    fn timeout_of(&self, request: &Request) -> Duration {
        match request {
            Request::Ocr { .. } => self.ocr_timeout,
            _ => self.op_timeout,
        }
    }
}

/// The time the crash cooldown and the idle exit are measured on.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WorkerError {
    #[error("the worker could not start: {0}")]
    Start(String),
    #[error("the worker did not answer {op} in time")]
    Timeout { op: &'static str },
    #[error("the worker exited: {0}")]
    Exited(String),
    #[error("the worker broke the frame protocol: {0}")]
    Protocol(String),
    #[error("the worker is paused after repeated crashes")]
    Paused,
    #[error("the worker was stopped")]
    Stopped,
    /// The [`Lease`]'s child has stopped, and the next child numbers its handles afresh.
    #[error("the handle is not open: the worker that held it has stopped")]
    NotOpen,
    /// The op ran in a healthy worker and refused its input, such as an image it cannot decode.
    #[error("{0}")]
    Rejected(String),
    /// The op failed inside a healthy worker, such as a PDF that does not parse.
    #[error("{0}")]
    Failed(String),
}

/// Where a child was in its life when it exited without the app stopping it, as Electron's
/// `WorkerExitPhase` (`apps/desktop/src/main/lib/embeddings.ts:49,737-741`): before `Ready`, with
/// calls waiting on it, idle, or while it was being shut down for idleness (reported only when
/// it had to be killed or exited non-zero, as `embeddings.ts:716-722`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitPhase {
    Starting,
    InFlight,
    Idle,
    IdleShutdown,
}

impl ExitPhase {
    /// The phase in Electron's `worker_exit_<phase>` log action.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::InFlight => "in_flight",
            Self::Idle => "idle",
            Self::IdleShutdown => "idle_shutdown",
        }
    }
}

/// Hears each exit of [`ExitPhase`] with the child's exit code (minus the signal number of a
/// child a signal ended). Runs on the supervisor's threads, at times under its state lock, so it
/// never calls the supervisor.
pub type ExitObserver = Arc<dyn Fn(ExitPhase, Option<i32>) + Send + Sync>;

type Reply = Result<Response, WorkerError>;
type Pending = Arc<Mutex<HashMap<u32, Sender<Reply>>>>;

pub struct Supervisor {
    shared: Arc<Shared>,
}

struct Shared {
    program: PathBuf,
    args: Vec<OsString>,
    limits: Limits,
    clock: Arc<dyn Clock>,
    exits: Option<ExitObserver>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    running: Option<Running>,
    generation: u64,
    next_id: u32,
    crashes: u32,
    paused_until: Option<Instant>,
}

struct Running {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    generation: u64,
    last_used: Instant,
    /// Held [`Lease`]s; the child does not idle out while one is held.
    leases: usize,
}

/// Ties a handle the child holds, such as an open PDF, to that child. [`Supervisor::call_on`]
/// reaches only it: once it stops, the call fails with [`WorkerError::NotOpen`] and never reaches
/// a handle of the same number in the next child. The child does not idle out while a lease is
/// held. Dropping the lease releases it.
pub struct Lease {
    shared: Weak<Shared>,
    generation: u64,
}

impl Drop for Lease {
    fn drop(&mut self) {
        let Some(shared) = self.shared.upgrade() else {
            return;
        };
        let mut state = lock(&shared.state);
        if let Some(running) = current(&mut state, self.generation) {
            running.leases -= 1;
            running.last_used = shared.clock.now();
        }
    }
}

impl Supervisor {
    pub fn new(
        program: PathBuf,
        args: Vec<OsString>,
        limits: Limits,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                program,
                args,
                limits,
                clock,
                exits: None,
                state: Mutex::new(State::default()),
            }),
        }
    }

    /// Reports the child's unexpected exits to `observer` (Electron's `worker_exit_*` log).
    pub fn observing_exits(mut self, observer: ExitObserver) -> Self {
        Arc::get_mut(&mut self.shared)
            .expect("no lease or thread holds a supervisor before its first call")
            .exits = Some(observer);
        self
    }

    /// Sends `request` and waits for its answer, starting the child first when none runs.
    pub fn call(&self, request: &Request) -> Result<Response, WorkerError> {
        self.send(request, None, false)
            .map(|(response, _)| response)
    }

    /// [`Supervisor::call`] for a request that opens a handle in the child: the answer comes
    /// with the handle's [`Lease`], taken when the request is sent.
    pub fn call_leasing(&self, request: &Request) -> Result<(Response, Lease), WorkerError> {
        let (response, lease) = self.send(request, None, true)?;
        Ok((response, lease.expect("leased on send")))
    }

    /// [`Supervisor::call`] on the child that holds `lease`; never starts one.
    pub fn call_on(&self, lease: &Lease, request: &Request) -> Result<Response, WorkerError> {
        if !std::ptr::eq(lease.shared.as_ptr(), Arc::as_ptr(&self.shared)) {
            return Err(WorkerError::NotOpen);
        }
        self.send(request, Some(lease.generation), false)
            .map(|(response, _)| response)
    }

    fn send(
        &self,
        request: &Request,
        pinned: Option<u64>,
        leasing: bool,
    ) -> Result<(Response, Option<Lease>), WorkerError> {
        let shared = &self.shared;
        let (reply, id, generation, stdin, pending, lease) = {
            let mut state = lock(&shared.state);
            let now = shared.clock.now();
            if let Some(generation) = pinned {
                if current(&mut state, generation).is_none() {
                    return Err(WorkerError::NotOpen);
                }
            } else {
                if let Some(until) = state.paused_until {
                    if now < until {
                        return Err(WorkerError::Paused);
                    }
                    state.paused_until = None;
                }
                if state.running.is_none() {
                    start(shared, &mut state)?;
                }
            }
            state.next_id = state.next_id.checked_add(1).unwrap_or(1);
            let id = state.next_id;
            let running = state.running.as_mut().expect("running above");
            let (tx, rx) = mpsc::channel();
            lock(&running.pending).insert(id, tx);
            running.last_used = now;
            let lease = leasing.then(|| {
                running.leases += 1;
                Lease {
                    shared: Arc::downgrade(shared),
                    generation: running.generation,
                }
            });
            let stdin = running.stdin.clone();
            (
                rx,
                id,
                running.generation,
                stdin,
                running.pending.clone(),
                lease,
            )
        };
        // Outside the state lock: a stop or a timeout kill of this child ends a blocked write.
        // The stdin guard ends with this statement, before any lock the error path takes.
        let written = write_frame(&mut *lock(&stdin), &request.to_frame(id));
        if let Err(error) = written {
            lock(&pending).remove(&id);
            // The codec refused the request before it wrote a byte: the child is healthy and
            // only this call fails.
            if let FrameError::TooLarge(len) = error {
                return Err(WorkerError::Failed(format!(
                    "the request of {len} bytes is over the frame cap"
                )));
            }
            // The child is gone. Forget it now, unless it was already stopped, so the next call
            // starts a new one instead of writing to it again; its stdout reader then finds it
            // is not current.
            let error = WorkerError::Exited(error.to_string());
            let dead = {
                let mut state = lock(&shared.state);
                let dead = current(&mut state, generation).is_some();
                if dead {
                    record_crash(shared, &mut state);
                }
                state.running.take_if(|_| dead)
            };
            if let Some(dead) = dead {
                fail_all(&dead.pending, &error);
                let status = reap(dead.child);
                report_exit(shared, ExitPhase::InFlight, status);
            }
            return Err(error);
        }
        let outcome = match reply.recv_timeout(shared.limits.timeout_of(request)) {
            Ok(reply) => reply,
            Err(RecvTimeoutError::Timeout) => {
                let error = WorkerError::Timeout { op: request.name() };
                tracing::warn!(
                    scope = "MlWorker",
                    op = request.name(),
                    "op timed out; killing the worker"
                );
                stop_generation(shared, Some(generation), &error);
                return Err(error);
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err(WorkerError::Exited("the answer channel closed".into()))
            }
        };
        if outcome.is_ok() {
            let mut state = lock(&shared.state);
            state.crashes = 0;
            if let Some(running) = current(&mut state, generation) {
                running.last_used = shared.clock.now();
            }
        }
        match outcome? {
            Response::Rejected(message) => Err(WorkerError::Rejected(message)),
            Response::Failed(message) => Err(WorkerError::Failed(message)),
            response => Ok((response, lease)),
        }
    }

    /// Kills the child, if one runs, and fails every call waiting on it. A later call starts
    /// a new child.
    pub fn stop(&self) {
        stop_generation(&self.shared, None, &WorkerError::Stopped);
    }

    /// The running child's process id.
    pub fn pid(&self) -> Option<u32> {
        lock(&self.shared.state)
            .running
            .as_ref()
            .map(|r| r.child.id())
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop();
    }
}

fn start(shared: &Arc<Shared>, state: &mut State) -> Result<(), WorkerError> {
    let mut command = Command::new(&shared.program);
    command
        .args(&shared.args)
        .env_clear()
        .envs(
            INHERITED_ENV
                .iter()
                .filter_map(|key| Some((key, std::env::var_os(key)?))),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The app's install dir, never the app's cwd, which Windows searches for DLLs at load.
    if let Some(dir) = shared
        .program
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
    {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows::Win32::System::Threading::CREATE_NO_WINDOW.0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| WorkerError::Start(format!("{}: {error}", shared.program.display())))?;
    if let Err(error) = priority::lower(&child) {
        tracing::debug!(
            scope = "MlWorker",
            "could not lower the worker's priority: {error}"
        );
    }
    state.generation += 1;
    let generation = state.generation;
    let stdin = child.stdin.take().expect("piped");
    let stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");
    let pending: Pending = Arc::default();
    let (ready_tx, ready_rx) = mpsc::channel();
    lock(&pending).insert(READY_ID, ready_tx);
    let weak = Arc::downgrade(shared);
    let reader_pending = pending.clone();
    thread::Builder::new()
        .name("ml-worker-stdout".into())
        .spawn(move || read_replies(weak, stdout, reader_pending, generation))
        .map_err(|error| WorkerError::Start(error.to_string()))?;
    thread::Builder::new()
        .name("ml-worker-stderr".into())
        .spawn(move || forward_stderr(stderr))
        .map_err(|error| WorkerError::Start(error.to_string()))?;

    let failure = match ready_rx.recv_timeout(shared.limits.start_timeout) {
        Ok(Ok(Response::Ready)) => None,
        Ok(Ok(other)) => Some(WorkerError::Protocol(format!(
            "expected Ready, got {}",
            other.name()
        ))),
        Ok(Err(error)) => {
            // Exited before it was ready: counts as a crash (`ocr-engine.ts:126-137`).
            record_crash(shared, state);
            Some(error)
        }
        Err(RecvTimeoutError::Timeout) => Some(WorkerError::Start(
            "the worker did not start in time".into(),
        )),
        Err(RecvTimeoutError::Disconnected) => {
            Some(WorkerError::Exited("the worker closed its output".into()))
        }
    };
    if let Some(error) = failure {
        let exited = matches!(error, WorkerError::Exited(_));
        let status = reap(child);
        if exited {
            report_exit(shared, ExitPhase::Starting, status);
        }
        return Err(error);
    }
    tracing::info!(scope = "MlWorker", pid = child.id(), "worker started");
    state.running = Some(Running {
        child,
        stdin: Arc::new(Mutex::new(stdin)),
        pending,
        generation,
        last_used: shared.clock.now(),
        leases: 0,
    });
    let weak = Arc::downgrade(shared);
    let tick = shared
        .limits
        .idle_exit
        .clamp(Duration::from_millis(10), Duration::from_secs(1));
    thread::Builder::new()
        .name("ml-worker-idle".into())
        .spawn(move || watch_idle(weak, generation, tick))
        .map_err(|error| WorkerError::Start(error.to_string()))?;
    Ok(())
}

/// Kills the running child when it is `generation` (any child for `None`) and fails its calls.
fn stop_generation(shared: &Shared, generation: Option<u64>, error: &WorkerError) {
    let taken = {
        let mut state = lock(&shared.state);
        let matches = state
            .running
            .as_ref()
            .is_some_and(|r| generation.is_none_or(|g| g == r.generation));
        if !matches {
            return;
        }
        state.running.take()
    };
    if let Some(running) = taken {
        fail_all(&running.pending, error);
        reap(running.child);
    }
}

/// The running child when it is `generation`.
fn current(state: &mut State, generation: u64) -> Option<&mut Running> {
    state
        .running
        .as_mut()
        .filter(|r| r.generation == generation)
}

fn record_crash(shared: &Shared, state: &mut State) {
    state.crashes += 1;
    if state.crashes >= shared.limits.crash_limit {
        state.crashes = 0;
        state.paused_until = Some(shared.clock.now() + shared.limits.crash_cooldown);
        tracing::error!(scope = "MlWorker", "worker keeps crashing; paused");
    }
}

fn fail_all(pending: &Pending, error: &WorkerError) {
    for (_, waiter) in lock(pending).drain() {
        let _ = waiter.send(Err(error.clone()));
    }
}

/// Kills the child unless it has exited, and waits for it.
fn reap(mut child: Child) -> Option<ExitStatus> {
    let _ = child.kill();
    child.wait().ok()
}

fn report_exit(shared: &Shared, phase: ExitPhase, status: Option<ExitStatus>) {
    let Some(observer) = &shared.exits else {
        return;
    };
    let code = status.and_then(|status| {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            status
                .code()
                .or_else(|| status.signal().map(|signal| -signal))
        }
        #[cfg(not(unix))]
        {
            status.code()
        }
    });
    observer(phase, code);
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
