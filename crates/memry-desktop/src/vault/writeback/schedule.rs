//! When passes run: the write-back thread of one vault session and its queue
//! (`scheduleWriteback`, `writebackDelayMs`, `reportWritebackFailure` and
//! `flushPendingWritebacks` of desktop `crdt-writeback.ts`). The rules are the module
//! invariants under "When".

use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tokio::sync::broadcast;

use super::pass::{Outcome, Pass};

const SCOPE: &str = "vault_writeback";

/// How long a note stays quiet before its pass runs. Every schedule starts it again.
pub const DEBOUNCE: Duration = Duration::from_millis(500);
/// How many times its last pass's cost a note waits after that pass before the next one. A
/// pass serializes the whole note, so it costs what the note is big, not what the edit was;
/// this caps the write-back at about a tenth of the wall clock per note.
pub const COOLDOWN_FACTOR: u32 = 9;
/// However big the note, its file never lags its body by more than this cooldown.
pub const MAX_COOLDOWN: Duration = Duration::from_secs(5);

/// The user is told that a note's file could not be updated from its body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteBackFailed {
    pub note_id: String,
    pub title: Option<String>,
}

/// What the write-back thread runs: a [`Pass`] in the app.
pub(crate) trait Runner: Send + 'static {
    fn run(&self, note_id: &str) -> Outcome;
    /// The note's title for the failure notice; `None` when it cannot be read.
    fn title(&self, note_id: &str) -> Option<String>;
}

impl Runner for Pass {
    fn run(&self, note_id: &str) -> Outcome {
        Pass::run(self, note_id)
    }

    fn title(&self, note_id: &str) -> Option<String> {
        self.vault
            .write_back()
            .title(note_id)
            .inspect_err(|error| {
                tracing::warn!(scope = SCOPE, note_id, "no title for the notice: {error}");
            })
            .ok()
            .flatten()
    }
}

/// What a note's last pass cost.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Cost {
    pub(crate) finished: Instant,
    pub(crate) took: Duration,
}

/// When a pass scheduled at `now` is due: the debounce, or the end of the cooldown of the
/// note's last pass when that is later.
pub(crate) fn due_at(now: Instant, last: Option<Cost>) -> Instant {
    let debounced = now + DEBOUNCE;
    last.map_or(debounced, |last| debounced.max(cooled(last)))
}

/// When the cooldown of a pass that cost `last` ends.
fn cooled(last: Cost) -> Instant {
    last.finished + last.took.saturating_mul(COOLDOWN_FACTOR).min(MAX_COOLDOWN)
}

#[derive(Default)]
struct Queue {
    /// When each scheduled note's pass is due.
    due: HashMap<String, Instant>,
    cost: HashMap<String, Cost>,
    /// Notes whose last pass failed and whose user was told.
    failing: HashSet<String>,
    running: bool,
    /// Flushes waiting: every pass is due now while one is.
    flushes: usize,
    /// The session is closing: every pass is due now, and the thread ends once none is left.
    stopping: bool,
    /// The thread ended.
    closed: bool,
}

impl Queue {
    fn urgent(&self) -> bool {
        self.flushes > 0 || self.stopping
    }

    fn idle(&self) -> bool {
        self.closed || (!self.running && self.due.is_empty())
    }
}

struct Shared {
    queue: Mutex<Queue>,
    changed: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The write-back thread of one vault session.
pub struct WriteBack {
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl WriteBack {
    pub(crate) fn start(
        runner: impl Runner,
        failures: broadcast::Sender<WriteBackFailed>,
    ) -> std::io::Result<Self> {
        let shared = Arc::new(Shared {
            queue: Mutex::default(),
            changed: Condvar::new(),
        });
        let thread = {
            let shared = shared.clone();
            std::thread::Builder::new()
                .name("vault-writeback".into())
                .spawn(move || {
                    let _closed = Closed(&shared);
                    work(&shared, &runner, &failures);
                })?
        };
        Ok(Self {
            shared,
            thread: Mutex::new(Some(thread)),
        })
    }

    /// Writes the note's body to its file once the note is quiet: the debounce after this
    /// schedule, or the cooldown of its last pass when that ends later.
    pub fn schedule(&self, note_id: &str) {
        let mut queue = self.shared.lock();
        if queue.closed {
            tracing::error!(scope = SCOPE, note_id, "the write-back thread is gone");
            return;
        }
        let now = Instant::now();
        let at = if queue.urgent() {
            now
        } else {
            due_at(now, queue.cost.get(note_id).copied())
        };
        queue.due.insert(note_id.to_owned(), at);
        drop(queue);
        self.shared.changed.notify_all();
    }

    /// Runs every scheduled pass now and waits, at most `timeout`, until they and the one
    /// running have finished and their failure notices are sent. True when they did.
    pub fn flush(&self, timeout: Duration) -> bool {
        let mut queue = self.shared.lock();
        queue.flushes += 1;
        self.shared.changed.notify_all();
        let (mut queue, _) = self
            .shared
            .changed
            .wait_timeout_while(queue, timeout, |queue| !queue.idle())
            .unwrap_or_else(|e| e.into_inner());
        queue.flushes -= 1;
        let done = queue.idle();
        if !done {
            tracing::error!(
                scope = SCOPE,
                waiting = queue.due.len(),
                running = queue.running,
                "the write-back flush ran out of time"
            );
        }
        done
    }

    /// Runs every scheduled pass now and returns once the thread ended. Any number of callers
    /// may stop it (a close hook that ran late, the next open); each waits for the end, not only
    /// the one that joins the thread.
    pub(crate) fn stop(&self) {
        let mut queue = self.shared.lock();
        queue.stopping = true;
        self.shared.changed.notify_all();
        drop(
            self.shared
                .changed
                .wait_while(queue, |queue| !queue.closed)
                .unwrap_or_else(|e| e.into_inner()),
        );
        let thread = self.thread.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(thread) = thread
            && thread.join().is_err()
        {
            tracing::error!(scope = SCOPE, "the write-back thread panicked");
        }
    }
}

impl Drop for WriteBack {
    fn drop(&mut self) {
        self.stop();
    }
}

fn work(shared: &Shared, runner: &impl Runner, failures: &broadcast::Sender<WriteBackFailed>) {
    let mut queue = shared.lock();
    loop {
        let now = Instant::now();
        let next = queue
            .due
            .iter()
            .min_by_key(|(_, at)| **at)
            .map(|(id, at)| (id.clone(), *at));
        match next {
            None if queue.stopping => break,
            None => {
                queue = shared
                    .changed
                    .wait(queue)
                    .unwrap_or_else(|e| e.into_inner())
            }
            Some((_, at)) if at > now && !queue.urgent() => {
                queue = shared
                    .changed
                    .wait_timeout(queue, at - now)
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
            Some((note_id, _)) => {
                // Taken off before the pass, so a schedule during it gives one more.
                queue.due.remove(&note_id);
                queue.running = true;
                drop(queue);
                let started = Instant::now();
                let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| runner.run(&note_id)))
                    .unwrap_or_else(|_| Outcome::Failed("the pass panicked".into()));
                let finished = Instant::now();
                log(&note_id, &outcome);
                let cost = Cost {
                    finished,
                    took: finished - started,
                };
                let tell = {
                    let mut queue = shared.lock();
                    queue.cost.insert(note_id.clone(), cost);
                    // A schedule taken during the pass knew only the cost before it.
                    if let Some(at) = queue.due.get_mut(&note_id) {
                        *at = (*at).max(cooled(cost));
                    }
                    match outcome {
                        Outcome::Failed(_) => queue.failing.insert(note_id.clone()),
                        _ => {
                            queue.failing.remove(&note_id);
                            false
                        }
                    }
                };
                if tell {
                    let title = runner.title(&note_id);
                    // No receiver is no listener yet, which is not an error.
                    let _ = failures.send(WriteBackFailed { note_id, title });
                }
                // Running until the notice is out, so a flush returns after it.
                queue = shared.lock();
                queue.running = false;
                shared.changed.notify_all();
            }
        }
    }
}

/// Marks the thread ended when it returns or unwinds, so no stop waits for a thread that is gone.
struct Closed<'a>(&'a Shared);

impl Drop for Closed<'_> {
    fn drop(&mut self) {
        self.0.lock().closed = true;
        self.0.changed.notify_all();
    }
}

fn log(note_id: &str, outcome: &Outcome) {
    match outcome {
        Outcome::Wrote { .. } | Outcome::Unchanged => {
            tracing::debug!(scope = SCOPE, note_id, outcome = ?outcome);
        }
        Outcome::Kept(keep) => {
            tracing::info!(scope = SCOPE, note_id, keep = ?keep, "the file was kept");
        }
        Outcome::Failed(reason) => {
            tracing::error!(scope = SCOPE, note_id, "the write-back failed: {reason}");
        }
    }
}
