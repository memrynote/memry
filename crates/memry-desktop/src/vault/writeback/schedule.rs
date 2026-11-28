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

use super::pass::{Keep, Outcome, Pass};

const SCOPE: &str = "vault_writeback";

/// How long a note stays quiet before its pass runs. Every schedule starts it again.
pub const DEBOUNCE: Duration = Duration::from_millis(500);
/// How many times its last pass's cost a note waits after that pass before the next one. A
/// pass serializes the whole note, so it costs what the note is big, not what the edit was;
/// this caps the write-back at about a tenth of the wall clock per note.
pub const COOLDOWN_FACTOR: u32 = 9;
/// However big the note, its file never lags its body by more than this cooldown.
pub const MAX_COOLDOWN: Duration = Duration::from_secs(5);
/// How long after a failed read or write ([`Outcome::Failed`]) its note's pass runs again on its
/// own. Each failure in a row doubles it; once it would reach [`MAX_RETRY_AFTER`] (the seventh
/// failed pass in a row) the retries end, and the note waits for its next schedule or the next
/// open's reconcile.
pub const RETRY_AFTER: Duration = Duration::from_secs(5);
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(5 * 60);

/// The user is told that a note's file could not be updated from its body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteBackFailed {
    pub note_id: String,
    pub title: Option<String>,
    /// Why the run of failures began.
    pub reason: Failure,
}

/// Why a note's file could not be updated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// A read or a write failed, or the pass could not finish ([`Outcome::Broken`]); a later
    /// pass may succeed.
    Write,
    /// The file's frontmatter does not parse: no pass writes the file until it is fixed.
    Frontmatter,
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

/// The session's one [`Pass`], shared with the open reconcile.
impl Runner for Arc<Pass> {
    fn run(&self, note_id: &str) -> Outcome {
        Pass::run(self, note_id)
    }

    fn title(&self, note_id: &str) -> Option<String> {
        Runner::title(&**self, note_id)
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
    /// When each note whose last write failed is tried again, and how many failed in a row. Not
    /// a scheduled pass: a flush or a stop neither runs nor waits for it, and a scheduled pass of
    /// the note runs instead of it.
    retries: HashMap<String, (Instant, u32)>,
    /// The delay of the first retry: [`RETRY_AFTER`], shorter in the retry tests.
    first_retry: Duration,
    /// Notes whose last pass kept the file for a server body not pulled yet: the sync's body
    /// step schedules them again once its debts settled ([`WriteBack::schedule_body_waits`]).
    body_waits: HashSet<String>,
    /// How many body steps settled: a pass kept for its body while one did is due again.
    settles: u64,
    running: bool,
    /// Flushes waiting: every pass is due now while one is.
    flushes: usize,
    /// The session is closing: every pass is due now, and the thread ends once none is left.
    stopping: bool,
    /// The thread ended.
    closed: bool,
    #[cfg(feature = "e2e")]
    debug: super::debug::Book,
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
        Self::start_retrying_after(runner, failures, RETRY_AFTER)
    }

    /// [`Self::start`] whose first retry comes `first_retry` after a failed write, the last one
    /// scaled with it: the retry tests' clock.
    pub(crate) fn start_retrying_after(
        runner: impl Runner,
        failures: broadcast::Sender<WriteBackFailed>,
        first_retry: Duration,
    ) -> std::io::Result<Self> {
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue {
                first_retry,
                ..Queue::default()
            }),
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
        #[cfg(feature = "e2e")]
        queue.debug.scheduled(note_id);
        drop(queue);
        self.shared.changed.notify_all();
    }

    /// Schedules again every note whose last pass kept its file because its server body was not
    /// pulled (`Keep::BodyNotPulled`), unless `still_owed` (one read of the body debts) names it
    /// among those still owed: their pass would only keep the file again, so they wait for the
    /// next settle. The sync calls it once a body step settled its debts: a body can settle with
    /// no tell of its own, and the pass that kept the file is not run again otherwise. A pass
    /// running meanwhile that keeps its file for the body is due again too.
    pub fn schedule_body_waits(&self, still_owed: impl FnOnce(&[String]) -> HashSet<String>) {
        let waits: Vec<String> = {
            let mut queue = self.shared.lock();
            queue.settles += 1;
            queue.body_waits.iter().cloned().collect()
        };
        let owed = still_owed(&waits);
        let settled: Vec<String> = waits.into_iter().filter(|id| !owed.contains(id)).collect();
        {
            let mut queue = self.shared.lock();
            for note_id in &settled {
                queue.body_waits.remove(note_id);
            }
        }
        for note_id in settled {
            self.schedule(&note_id);
        }
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
        // The thread left the retries aside while the flush ran: it looks at them again.
        self.shared.changed.notify_all();
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

    /// What the write-back did for the note in this session (e2e build).
    #[cfg(feature = "e2e")]
    pub fn debug(&self, note_id: &str) -> Option<super::debug::WriteBackDebug> {
        let queue = self.shared.lock();
        queue.debug.of(note_id, queue.due.contains_key(note_id))
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
        let next = next_pass(&queue);
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
                let settles = queue.settles;
                let retrying = queue.retries.contains_key(&note_id);
                #[cfg(feature = "e2e")]
                queue.debug.started(&note_id);
                drop(queue);
                let started = Instant::now();
                let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| runner.run(&note_id)))
                    .unwrap_or_else(|_| Outcome::Broken("the pass panicked".into()));
                let finished = Instant::now();
                log(&note_id, &outcome, retrying);
                let cost = Cost {
                    finished,
                    took: finished - started,
                };
                let tell = {
                    let mut queue = shared.lock();
                    queue.cost.insert(note_id.clone(), cost);
                    #[cfg(feature = "e2e")]
                    queue.debug.finished(&note_id, &outcome);
                    // A schedule taken during the pass knew only the cost before it.
                    if let Some(at) = queue.due.get_mut(&note_id) {
                        *at = (*at).max(cooled(cost));
                    }
                    if matches!(outcome, Outcome::Kept(Keep::BodyNotPulled)) {
                        queue.body_waits.insert(note_id.clone());
                        // A body step settled during the pass: its re-drive missed this note.
                        if queue.settles != settles && !queue.due.contains_key(&note_id) {
                            let at = due_at(finished, Some(cost));
                            queue.due.insert(note_id.clone(), at);
                        }
                    } else {
                        queue.body_waits.remove(&note_id);
                    }
                    let failure = match outcome {
                        Outcome::Failed(_) | Outcome::Broken(_) => Some(Failure::Write),
                        Outcome::FrontmatterUnreadable(_) => Some(Failure::Frontmatter),
                        _ => None,
                    };
                    // A failed read or write may succeed later (a full disk, a file held open),
                    // so it is retried for a while; a pass that cannot finish, or a frontmatter
                    // that does not parse, waits for a change and the note's next schedule.
                    let retry = match &outcome {
                        Outcome::Failed(reason) => {
                            let failed = queue.retries.get(&note_id).map_or(0, |retry| retry.1) + 1;
                            let delay = retry_after(queue.first_retry, failed);
                            if delay.is_none() {
                                tracing::warn!(
                                    scope = SCOPE,
                                    note_id,
                                    failed,
                                    "the write-back gave up retrying the failed write: {reason}"
                                );
                            }
                            delay.map(|delay| (finished + delay, failed))
                        }
                        _ => None,
                    };
                    match retry {
                        Some(retry) => queue.retries.insert(note_id.clone(), retry),
                        None => queue.retries.remove(&note_id),
                    };
                    match failure {
                        Some(reason) if queue.failing.insert(note_id.clone()) => Some(reason),
                        Some(_) => None,
                        None => {
                            queue.failing.remove(&note_id);
                            None
                        }
                    }
                };
                if let Some(reason) = tell {
                    let title = runner.title(&note_id);
                    // No receiver is no listener yet, which is not an error.
                    let _ = failures.send(WriteBackFailed {
                        note_id,
                        title,
                        reason,
                    });
                }
                // Running until the notice is out, so a flush returns after it.
                queue = shared.lock();
                queue.running = false;
                shared.changed.notify_all();
            }
        }
    }
}

/// The pass to run next and when it is due: the earliest scheduled one, or the earliest retry of
/// a note not scheduled when that is earlier. No retry while a flush or a stop runs.
fn next_pass(queue: &Queue) -> Option<(String, Instant)> {
    let scheduled = queue.due.iter().min_by_key(|(_, at)| **at);
    let retry = (!queue.urgent())
        .then(|| {
            queue
                .retries
                .iter()
                .filter(|(id, _)| !queue.due.contains_key(*id))
                .map(|(id, (at, _))| (id, at))
                .min_by_key(|(_, at)| **at)
        })
        .flatten();
    let next = match (scheduled, retry) {
        (Some(scheduled), Some(retry)) if retry.1 < scheduled.1 => retry,
        (scheduled, retry) => scheduled.or(retry)?,
    };
    Some((next.0.clone(), *next.1))
}

/// The delay before the retry after `failed` failed writes in a row, `first` the first one's;
/// `None` once it reaches [`MAX_RETRY_AFTER`], scaled as `first` is: the retries end.
fn retry_after(first: Duration, failed: u32) -> Option<Duration> {
    let delay = first.saturating_mul(1 << (failed - 1).min(16));
    let last = first.saturating_mul((MAX_RETRY_AFTER.as_millis() / RETRY_AFTER.as_millis()) as u32);
    (delay < last).then_some(delay)
}

/// Marks the thread ended when it returns or unwinds, so no stop waits for a thread that is gone.
struct Closed<'a>(&'a Shared);

impl Drop for Closed<'_> {
    fn drop(&mut self) {
        self.0.lock().closed = true;
        self.0.changed.notify_all();
    }
}

/// `retrying`: the note's last write failed too, which was logged.
fn log(note_id: &str, outcome: &Outcome, retrying: bool) {
    match outcome {
        Outcome::Wrote { .. } | Outcome::Unchanged => {
            tracing::debug!(scope = SCOPE, note_id, outcome = ?outcome);
        }
        // Nothing heals a forked body on its own: the file stays until someone looks.
        Outcome::Kept(Keep::Forked(fork)) => {
            tracing::error!(
                scope = SCOPE,
                note_id,
                fork = ?fork,
                "the note's body forked, so its file was kept"
            );
        }
        Outcome::Kept(keep) => {
            tracing::info!(scope = SCOPE, note_id, keep = ?keep, "the file was kept");
        }
        Outcome::Failed(reason) if retrying => {
            tracing::debug!(
                scope = SCOPE,
                note_id,
                "the write-back retry failed: {reason}"
            );
        }
        Outcome::Failed(reason) | Outcome::Broken(reason) => {
            tracing::error!(scope = SCOPE, note_id, "the write-back failed: {reason}");
        }
        Outcome::FrontmatterUnreadable(reason) => {
            tracing::warn!(
                scope = SCOPE,
                note_id,
                "the file's frontmatter does not parse, so it is kept: {reason}"
            );
        }
    }
}
