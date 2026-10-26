//! The projection runtime: derived state (search index, embeddings, project links, inbox
//! counts) kept in step with the vault. A port of
//! `apps/desktop/src/main/projections/runtime.ts`, on threads.
//!
//! One independent lane per projector, each fed by a bounded, coalescing queue, so a slow
//! projector (an embedding model load) never holds back another one's writes. A lane drains
//! its own events in publish order; only the order *between* lanes is relaxed.
//!
//! Everything a projector produces is derived, so none of it is worth blocking a vault
//! switch for: [`ProjectionRuntime::stop`] drains for a bounded time and then drops what is
//! queued (the next open re-derives it), and a thread that will not finish is reported, not
//! waited for. A caller that must reopen the same databases checks
//! [`ProjectionRuntime::live_threads`] first.

mod bus;
mod event;
#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub use bus::{DEFAULT_QUEUE_LIMIT, ProjectionBus};
pub use event::{
    EventKind, FileNoteProjection, MarkdownNoteProjection, NoteProjectionRecord, ProjectionEvent,
};

/// `DEFAULT_STOP_DRAIN_TIMEOUT_MS`.
pub const STOP_DRAIN_TIMEOUT: Duration = Duration::from_millis(5000);

/// Set when the session closes; a long `reconcile` checks it and returns promptly.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

pub trait Projector: Send + Sync + 'static {
    fn name(&self) -> &str;

    /// A lane nothing reads back synchronously: [`ProjectionRuntime::flush`] does not wait
    /// for it. It still receives every event, in publish order, and drains on its own.
    fn background(&self) -> bool {
        false
    }

    fn handles(&self, event: &ProjectionEvent) -> bool;

    fn project(&self, event: &ProjectionEvent) -> Result<(), String>;

    fn rebuild(&self) -> Result<(), String>;

    /// Consistency pass, run backgrounded on every vault open. It stops promptly when
    /// `cancel` is set: a vault switch must not leave the old pass reading the previous
    /// vault against a closed database.
    fn reconcile(&self, cancel: &CancelToken) -> Result<(), String>;
}

/// A failed reconcile pass, for the session to report.
pub type ReconcileFailure = Arc<dyn Fn(&str, &str) + Send + Sync>;

struct LaneState {
    bus: ProjectionBus,
    /// The queue dropped events; a deferred reconcile pays for them.
    needs_reconcile: bool,
    /// An event is inside `project`, or an overflow repair is running.
    busy: bool,
    stopped: bool,
    dropped_total: u64,
}

struct Lane {
    projector: Arc<dyn Projector>,
    /// One projector runs one call at a time: `project`, `reconcile` and `rebuild` (from the
    /// lane thread or the reconcile chain) all hold it, so a pass never reads rows an event
    /// is rewriting.
    work: Mutex<()>,
    state: Mutex<LaneState>,
    changed: Condvar,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Lane {
    fn idle(state: &LaneState) -> bool {
        state.bus.is_empty() && !state.busy
    }

    /// The lane's thread: project queued events in order, then pay the repair the cap owes.
    fn run(&self, cancel: &CancelToken) {
        let mut state = lock(&self.state);
        loop {
            if state.stopped {
                break;
            }
            if let Some(event) = state.bus.dequeue() {
                state.busy = true;
                drop(state);
                if self.projector.handles(&event)
                    && let Err(error) = {
                        let _turn = lock(&self.work);
                        self.projector.project(&event)
                    }
                {
                    tracing::error!(projector = self.projector.name(), %error, "projection failed");
                }
                state = lock(&self.state);
                state.busy = false;
                self.changed.notify_all();
                continue;
            }
            let dropped = state.bus.take_dropped();
            if dropped > 0 {
                state.needs_reconcile = true;
                state.dropped_total += dropped;
                tracing::warn!(
                    projector = self.projector.name(),
                    dropped,
                    "projection queue overflow; dropped pending events"
                );
            }
            if state.needs_reconcile {
                // Cleared before the pass, so an event the pass itself publishes cannot
                // retrigger it in a loop; restored on failure so the next drain retries.
                state.needs_reconcile = false;
                state.busy = true;
                drop(state);
                let outcome = {
                    let _turn = lock(&self.work);
                    self.projector.reconcile(cancel)
                };
                state = lock(&self.state);
                state.busy = false;
                if let Err(error) = outcome {
                    state.needs_reconcile = true;
                    tracing::warn!(projector = self.projector.name(), %error, "projection overflow repair failed");
                    // Retry on the next published event, not in a hot loop.
                    self.changed.notify_all();
                    state = self
                        .changed
                        .wait_while(state, |s| !s.stopped && s.bus.is_empty())
                        .unwrap_or_else(PoisonError::into_inner);
                } else {
                    self.changed.notify_all();
                }
                continue;
            }
            self.changed.notify_all();
            state = self
                .changed
                .wait_while(state, |s| {
                    !s.stopped && s.bus.is_empty() && !s.needs_reconcile
                })
                .unwrap_or_else(PoisonError::into_inner);
        }
        self.changed.notify_all();
    }
}

/// What [`ProjectionRuntime::stop`] could not wait for.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct StopReport {
    /// Threads still running at the deadline, by projector name (or `reconcile`).
    pub stuck: Vec<String>,
}

pub struct ProjectionRuntime {
    lanes: Vec<Arc<Lane>>,
    threads: Mutex<Vec<(String, JoinHandle<()>)>>,
    cancel: CancelToken,
    stopping: AtomicBool,
}

impl ProjectionRuntime {
    pub fn start(projectors: Vec<Arc<dyn Projector>>, queue_limit: usize) -> std::io::Result<Self> {
        let cancel = CancelToken::default();
        let lanes: Vec<Arc<Lane>> = projectors
            .into_iter()
            .map(|projector| {
                Arc::new(Lane {
                    projector,
                    work: Mutex::new(()),
                    state: Mutex::new(LaneState {
                        bus: ProjectionBus::new(queue_limit),
                        needs_reconcile: false,
                        busy: false,
                        stopped: false,
                        dropped_total: 0,
                    }),
                    changed: Condvar::new(),
                })
            })
            .collect();
        let mut threads = Vec::new();
        for lane in &lanes {
            let (worker, cancel) = (lane.clone(), cancel.clone());
            let name = worker.projector.name().to_owned();
            let spawned = std::thread::Builder::new()
                .name(format!("projection-{name}"))
                .spawn(move || worker.run(&cancel));
            match spawned {
                Ok(handle) => threads.push((name, handle)),
                Err(err) => {
                    // Stop the lanes already running before reporting.
                    for started in &lanes {
                        lock(&started.state).stopped = true;
                        started.changed.notify_all();
                    }
                    for (_, handle) in threads {
                        let _ = handle.join();
                    }
                    return Err(err);
                }
            }
        }
        Ok(Self {
            lanes,
            threads: Mutex::new(threads),
            cancel,
            stopping: AtomicBool::new(false),
        })
    }

    pub fn cancel_token(&self) -> CancelToken {
        self.cancel.clone()
    }

    /// Queues the event on every lane. Refused (and logged) once the runtime is stopping:
    /// anything still emitting would refill a lane as fast as the drain empties it.
    pub fn publish(&self, event: ProjectionEvent) {
        if self.stopping.load(Ordering::SeqCst) {
            tracing::debug!(kind = ?event.kind(), "projection event refused: runtime is stopping");
            return;
        }
        for lane in &self.lanes {
            let mut state = lock(&lane.state);
            if state.stopped {
                continue;
            }
            state.bus.enqueue(event.clone());
            lane.changed.notify_all();
        }
    }

    /// Waits until every **foreground** lane is idle, or `timeout` passes. Background lanes
    /// still receive events but are not waited for. Returns whether it settled.
    pub fn flush(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        for lane in self.lanes.iter().filter(|l| !l.projector.background()) {
            if !wait_idle(lane, deadline) {
                return false;
            }
        }
        true
    }

    /// Events the cap dropped on `projector`, since the runtime started.
    pub fn dropped(&self, projector: &str) -> u64 {
        self.lanes
            .iter()
            .find(|l| l.projector.name() == projector)
            .map_or(0, |l| {
                let state = lock(&l.state);
                state.dropped_total + state.bus.dropped()
            })
    }

    /// One sequential pass over every projector's `reconcile`, on its own thread. A failure
    /// is reported through `on_failure(projector, error)` and the failing projector's
    /// `rebuild` runs once (`vault/index.ts:370-395`); the rest of the pass continues.
    /// Never awaited by the caller.
    pub fn start_reconcile(&self, on_failure: ReconcileFailure) -> std::io::Result<()> {
        let lanes = self.lanes.clone();
        let cancel = self.cancel.clone();
        let handle = std::thread::Builder::new()
            .name("projection-reconcile".into())
            .spawn(move || {
                for lane in lanes {
                    if cancel.is_cancelled() {
                        break;
                    }
                    let projector = &lane.projector;
                    let _turn = lock(&lane.work);
                    if cancel.is_cancelled() {
                        break;
                    }
                    let Err(error) = projector.reconcile(&cancel) else {
                        continue;
                    };
                    tracing::error!(projector = projector.name(), %error, "projection reconcile failed");
                    on_failure(projector.name(), &error);
                    if let Err(error) = projector.rebuild() {
                        tracing::error!(projector = projector.name(), %error, "projection rebuild failed");
                    }
                }
            })?;
        lock(&self.threads).push(("reconcile".into(), handle));
        Ok(())
    }

    /// Threads (lanes and the reconcile chain) that have not finished.
    pub fn live_threads(&self) -> usize {
        lock(&self.threads)
            .iter()
            .filter(|(_, handle)| !handle.is_finished())
            .count()
    }

    /// Cancels reconcile passes, refuses new events, optionally drains what is queued for at
    /// most [`STOP_DRAIN_TIMEOUT`], drops the rest, and joins every thread that finishes
    /// within the same deadline. A stuck thread is reported and left.
    pub fn stop(&self, drain: bool) -> StopReport {
        self.stop_within(drain, STOP_DRAIN_TIMEOUT)
    }

    pub fn stop_within(&self, drain: bool, deadline: Duration) -> StopReport {
        self.stopping.store(true, Ordering::SeqCst);
        self.cancel.cancel();
        let end = Instant::now() + deadline;
        if drain {
            for lane in &self.lanes {
                wait_idle(lane, end);
            }
        }
        for lane in &self.lanes {
            let mut state = lock(&lane.state);
            state.stopped = true;
            state.bus.clear();
            lane.changed.notify_all();
        }
        let mut threads = lock(&self.threads);
        while Instant::now() < end && threads.iter().any(|(_, h)| !h.is_finished()) {
            std::thread::sleep(Duration::from_millis(5));
        }
        let mut stuck = Vec::new();
        let mut remaining = Vec::new();
        for (name, handle) in threads.drain(..) {
            if handle.is_finished() {
                let _ = handle.join();
            } else {
                stuck.push(name.clone());
                remaining.push((name, handle));
            }
        }
        *threads = remaining;
        if !stuck.is_empty() {
            tracing::warn!(
                ?stuck,
                "projection threads did not stop before the deadline"
            );
        }
        StopReport { stuck }
    }
}

fn wait_idle(lane: &Lane, deadline: Instant) -> bool {
    let mut state = lock(&lane.state);
    loop {
        if Lane::idle(&state) {
            return true;
        }
        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
            return false;
        };
        state = lane
            .changed
            .wait_timeout(state, left)
            .unwrap_or_else(PoisonError::into_inner)
            .0;
    }
}
