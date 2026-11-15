//! The threads of one child: its stdout reader, its stderr forwarder and its idle watch.

use std::io::{BufRead, BufReader, Read};
use std::process::{ChildStderr, ChildStdout};
use std::sync::Weak;
use std::thread;
use std::time::{Duration, Instant};

use super::{
    ExitPhase, Pending, Running, Shared, WorkerError, fail_all, lock, reap, record_crash,
    report_exit,
};
use crate::frame::{read_frame, write_frame};
use crate::op::{Request, Response};
use crate::serve::READY_ID;

/// The longest stderr line forwarded to the log; the rest of the line is dropped.
const MAX_LOG_LINE: usize = 4096;
/// How long an idle worker gets to exit on `Shutdown` before it is killed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Routes each answer to its caller. Ends when the child's stdout closes or breaks the
/// protocol; either way every waiting call fails and the child is taken down.
pub(super) fn read_replies(
    shared: Weak<Shared>,
    stdout: ChildStdout,
    pending: Pending,
    generation: u64,
) {
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
    let in_flight = !lock(&pending).is_empty();
    let shared = shared.upgrade();
    let taken = match &shared {
        Some(shared) if !starting => {
            let mut state = lock(&shared.state);
            let current = state
                .running
                .as_ref()
                .is_some_and(|r| r.generation == generation);
            // Not stopped by the app: it crashed or misbehaved.
            if current {
                record_crash(shared, &mut state);
            }
            state.running.take_if(|_| current)
        }
        _ => None,
    };
    fail_all(&pending, &error);
    if let (Some(running), Some(shared)) = (taken, shared) {
        tracing::warn!(scope = "MlWorker", "worker ended: {error}");
        let status = reap(running.child);
        let phase = if in_flight {
            ExitPhase::InFlight
        } else {
            ExitPhase::Idle
        };
        report_exit(&shared, phase, status);
    }
}

pub(super) fn forward_stderr(stderr: ChildStderr) {
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
pub(super) fn watch_idle(shared: Weak<Shared>, generation: u64, tick: Duration) {
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
            if let Ok(Some(status)) = child.try_wait() {
                if !status.success() {
                    report_exit(&shared, ExitPhase::IdleShutdown, Some(status));
                }
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let status = reap(child);
        report_exit(&shared, ExitPhase::IdleShutdown, status);
        return;
    }
}
