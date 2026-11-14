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

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::thread;
use std::time::{Duration, Instant};

use crate::frame::{FrameError, read_frame, write_frame};
use crate::op::{Request, Response};
use crate::priority;
use crate::serve::READY_ID;

/// The longest stderr line forwarded to the log; the rest of the line is dropped.
const MAX_LOG_LINE: usize = 4096;
/// How long an idle worker gets to exit on `Shutdown` before it is killed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// The child parses untrusted files, so it gets none of the app's environment but these. Windows
/// loads system DLLs through `SystemRoot`.
const INHERITED_ENV: &[&str] = if cfg!(windows) { &["SystemRoot"] } else { &[] };

#[derive(Debug, Clone)]
pub struct Limits {
    /// Until the child's `Ready` frame (`ocr-engine.ts:23`).
    pub start_timeout: Duration,
    /// Per op; past it the child is killed (`pdf-host.ts:23`).
    pub op_timeout: Duration,
    pub idle_exit: Duration,
    pub crash_limit: u32,
    pub crash_cooldown: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            start_timeout: Duration::from_secs(15),
            op_timeout: Duration::from_secs(120),
            idle_exit: Duration::from_secs(60),
            crash_limit: 3,
            crash_cooldown: Duration::from_secs(10 * 60),
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
    /// The op failed inside a healthy worker, such as a PDF that does not parse.
    #[error("{0}")]
    Failed(String),
}

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
                state: Mutex::new(State::default()),
            }),
        }
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
                reap(dead.child);
            }
            return Err(error);
        }
        let outcome = match reply.recv_timeout(shared.limits.op_timeout) {
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
        reap(child);
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

/// Routes each answer to its caller. Ends when the child's stdout closes or breaks the
/// protocol; either way every waiting call fails and the child is taken down.
fn read_replies(shared: Weak<Shared>, stdout: ChildStdout, pending: Pending, generation: u64) {
    let mut stdout = BufReader::new(stdout);
    let error = loop {
        match read_frame(&mut stdout) {
            Ok(Some(frame)) => {
                let reply = Response::from_frame(&frame)
                    .map_err(|error| WorkerError::Protocol(error.to_string()));
                let protocol_error = reply.as_ref().err().cloned();
                if let Some(waiter) = lock(&pending).remove(&frame.id) {
                    let _ = waiter.send(reply);
                }
                if let Some(error) = protocol_error {
                    break error;
                }
            }
            Ok(None) => break WorkerError::Exited("the worker closed its output".into()),
            Err(error) => break WorkerError::Protocol(error.to_string()),
        }
    };
    // The state forgets the child before its callers hear of the failure, so a caller that
    // calls again at once starts a new child instead of writing to the dead one. A child that
    // never sent `Ready` is not in the state: `start` holds the state lock while it waits for
    // `Ready`, and accounts for the failure itself.
    let starting = lock(&pending).contains_key(&READY_ID);
    let taken = match shared.upgrade() {
        Some(shared) if !starting => {
            let mut state = lock(&shared.state);
            let current = state
                .running
                .as_ref()
                .is_some_and(|r| r.generation == generation);
            // Not stopped by the app: it crashed or misbehaved.
            if current {
                record_crash(&shared, &mut state);
            }
            state.running.take_if(|_| current)
        }
        _ => None,
    };
    fail_all(&pending, &error);
    if let Some(running) = taken {
        tracing::warn!(scope = "MlWorker", "worker ended: {error}");
        reap(running.child);
    }
}

fn forward_stderr(stderr: std::process::ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut line = Vec::new();
    // Inside an overlong line: its rest is dropped, a chunk at a time.
    let mut skipping = false;
    loop {
        line.clear();
        match reader
            .by_ref()
            .take(MAX_LOG_LINE as u64)
            .read_until(b'\n', &mut line)
        {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                if !skipping {
                    let text = String::from_utf8_lossy(&line);
                    tracing::info!(scope = "MlWorker", "{}", text.trim_end());
                }
                skipping = !line.ends_with(b"\n");
            }
        }
    }
}

/// Shuts the child down once it has been idle for [`Limits::idle_exit`] with no call waiting and
/// no [`Lease`] held.
fn watch_idle(shared: Weak<Shared>, generation: u64, tick: Duration) {
    loop {
        thread::sleep(tick);
        let Some(shared) = shared.upgrade() else {
            return;
        };
        let running = {
            let mut state = lock(&shared.state);
            let Some(running) = state.running.as_ref() else {
                return;
            };
            if running.generation != generation {
                return;
            }
            let idle = shared
                .clock
                .now()
                .saturating_duration_since(running.last_used);
            if idle < shared.limits.idle_exit
                || running.leases > 0
                || !lock(&running.pending).is_empty()
            {
                continue;
            }
            state.running.take().expect("checked above")
        };
        tracing::info!(scope = "MlWorker", "worker idle; shutting it down");
        let Running {
            mut child, stdin, ..
        } = running;
        let _ = write_frame(&mut *lock(&stdin), &Request::Shutdown.to_frame(0));
        drop(stdin);
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        reap(child);
        return;
    }
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

fn reap(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
