//! The index task of one open vault: what the facts owe, when it is paid, and the `vault_reindex`
//! requests, in one loop that parks until a fact, a request or the owed work's time.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::mpsc as reply;
use std::time::Instant;

use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;

use super::pass::{Indexer, Pass};
use super::{
    Backfilled, IDLE_DELAY, IndexError, IndexProgress, PROGRESS_INTERVAL, ProgressThrottle,
    RETRY_FIRST, RETRY_MAX,
};
use crate::session::projection::CancelToken;
use crate::vault::consumer::Applied;
use crate::vault::watch::VaultEvent;

pub type Progress = Box<dyn FnMut(IndexProgress) + Send>;
pub type Answer = reply::Receiver<Result<Backfilled, IndexError>>;
type Reply = reply::Sender<Result<Backfilled, IndexError>>;

enum Command {
    Reindex { progress: Progress, answer: Reply },
    Stop,
}

/// Sends a task its requests.
#[derive(Clone)]
pub struct TaskHandle(Arc<mpsc::UnboundedSender<Command>>);

/// What a task reads its requests from.
pub struct TaskInbox(mpsc::UnboundedReceiver<Command>);

pub fn task_channel() -> (TaskHandle, TaskInbox) {
    let (sender, receiver) = mpsc::unbounded_channel();
    (TaskHandle(Arc::new(sender)), TaskInbox(receiver))
}

impl TaskHandle {
    /// Ends the task once its current pass stopped.
    pub fn stop(&self) {
        // A task that already ended needs no stop.
        let _ = self.0.send(Command::Stop);
    }

    /// Asks for a reindex, run once the open walk ended; `None` when the task already ended.
    pub fn reindex(&self, progress: Progress) -> Option<Answer> {
        let (answer, receiver) = reply::channel();
        self.0
            .send(Command::Reindex { progress, answer })
            .ok()
            .map(|()| receiver)
    }

    pub(super) fn same(&self, other: &TaskHandle) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

/// Where the open walk is, as the facts tell it. Nothing is worked, a reindex included, until
/// it ended or cannot come: a pass beside the walk holds the database locks tier 0 needs.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Walk {
    /// The walk waits for the watcher's first `Rescanned`.
    #[default]
    Before,
    /// The watcher failed before its first pass ended, so no walk may come: the work starts.
    /// A `Rescanned` after it still starts the walk.
    Failed,
    /// From the first `Rescanned` to `Indexed`. A watcher failure inside the walk does not end
    /// it: `Indexed` follows.
    During,
    /// `Indexed`, or facts were lost and it may have been one of them.
    Ended,
}

/// The work the facts owe and its time.
#[derive(Default)]
struct Owed {
    queue: BTreeSet<String>,
    scan: bool,
    /// The core search reindex (links, body tags, full text).
    links: bool,
    walk: Walk,
    due: Option<Instant>,
    failures: u32,
}

impl Owed {
    /// Due [`IDLE_DELAY`] from the first fact of a burst, and no later: a retry's backoff does
    /// not hold back a live edit.
    fn arm(&mut self) {
        let soon = Instant::now() + IDLE_DELAY;
        self.due = Some(self.due.map_or(soon, |due| due.min(soon)));
    }

    fn owe_scan(&mut self) {
        self.scan = true;
        self.arm();
    }

    fn end_walk(&mut self) {
        self.walk = Walk::Ended;
        self.owe_scan();
    }

    fn walked(&self) -> bool {
        matches!(self.walk, Walk::Failed | Walk::Ended)
    }

    /// When the owed work is due; `None` while nothing is owed or the walk has not ended.
    fn next(&self) -> Option<Instant> {
        let owed = self.scan || self.links || !self.queue.is_empty();
        (self.walked() && owed).then(|| self.due.unwrap_or_else(Instant::now))
    }

    /// What a pass over the queued `ids` (and a scan, `scan`) leaves owed.
    fn settle(&mut self, ids: BTreeSet<String>, scan: bool, outcome: &Result<Pass, IndexError>) {
        match outcome {
            Ok(pass) if pass.stopped => {
                self.queue.extend(ids);
                self.scan |= scan;
            }
            Ok(pass) if pass.unread.is_empty() && !self.links => self.failures = 0,
            Ok(pass) => {
                tracing::warn!(
                    scope = "note_index",
                    unread = pass.unread.len(),
                    links_owed = self.links,
                    "the pass did not finish: retrying"
                );
                self.retry(pass.unread.iter().cloned().collect());
            }
            Err(error) => {
                tracing::warn!(scope = "note_index", "index pass failed, retrying: {error}");
                self.retry(ids);
            }
        }
    }

    /// A pass did not finish: its notes and a scan are owed again, after a backoff.
    fn retry(&mut self, notes: BTreeSet<String>) {
        self.queue.extend(notes);
        self.scan = true;
        self.failures += 1;
        let delay = RETRY_FIRST.saturating_mul(1 << self.failures.min(16).saturating_sub(1));
        self.due = Some(Instant::now() + delay.min(RETRY_MAX));
    }
}

impl Indexer {
    /// The task: facts and requests in, passes out, until the handle stops it or `cancel` is
    /// seen. Errs only when it could not start.
    /// seen. Errs only when it could not start. `report` gets the open's pass progress.
    pub fn run(
        &self,
        facts: Receiver<Applied>,
        inbox: TaskInbox,
        cancel: &CancelToken,
        report: &dyn Fn(IndexProgress),
    ) -> Result<(), String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .map_err(|error| format!("the note index task has no runtime: {error}"))?;
        runtime.block_on(self.serve(facts, inbox, cancel, report));
        Ok(())
    }

    async fn serve(
        &self,
        mut facts: Receiver<Applied>,
        inbox: TaskInbox,
        cancel: &CancelToken,
        report: &dyn Fn(IndexProgress),
    ) {
        let TaskInbox(mut commands) = inbox;
        // Owed at every open: a pass that wrote rows may have ended before its search reindex.
        let mut owed = Owed {
            links: true,
            ..Owed::default()
        };
        let mut waiting: Vec<(Progress, Reply)> = Vec::new();
        // The open's pass, the first after the walk, reports its progress (`indexVault` on
        // open): the renderer refreshes the notes list on it. No later pass reports.
        let mut report = Some(report);
        while !cancel.is_cancelled() {
            if owed.walked() {
                for (progress, answer) in waiting.drain(..) {
                    // The asker may have gone; the work is done either way.
                    let _ = answer.send(self.reindex(&mut owed, progress, cancel));
                }
            }
            let next = owed.next();
            let wake = tokio::time::Instant::from_std(next.unwrap_or_else(Instant::now));
            tokio::select! {
                biased;
                command = commands.recv() => match command {
                    Some(Command::Reindex { progress, answer }) => waiting.push((progress, answer)),
                    Some(Command::Stop) | None => return,
                },
                fact = facts.recv() => match fact {
                    Ok(fact) => self.take(&mut owed, fact),
                    Err(RecvError::Lagged(missed)) => {
                        tracing::warn!(scope = "note_index", missed, "facts were lost: scanning");
                        owed.end_walk();
                    }
                    Err(RecvError::Closed) => return,
                },
                () = tokio::time::sleep_until(wake), if next.is_some() => {
                    self.work(&mut owed, cancel, report.take());
                }
            }
        }
    }

    fn take(&self, owed: &mut Owed, fact: Applied) {
        match fact {
            Applied::Added { note_id, .. }
            | Applied::Changed { note_id, .. }
            | Applied::Renamed { note_id, .. } => {
                owed.queue.insert(note_id);
                owed.arm();
            }
            Applied::Removed { note_id, .. } => {
                owed.queue.remove(&note_id);
                if let Err(error) = self.search.forget_note_stats(&note_id) {
                    tracing::warn!(scope = "note_index", note_id, "row not dropped: {error}");
                    owed.owe_scan();
                }
            }
            Applied::Indexed { .. } => owed.end_walk(),
            Applied::Vault(VaultEvent::Rescanned { .. }) => {
                if matches!(owed.walk, Walk::Before | Walk::Failed) {
                    owed.walk = Walk::During;
                }
            }
            Applied::Vault(VaultEvent::WatchFailed { .. }) => {
                if owed.walk == Walk::Before {
                    owed.walk = Walk::Failed;
                }
                owed.owe_scan();
            }
            Applied::Vault(_) => {}
        }
    }

    /// One pass over what is owed. With `report`, its progress goes out as a reindex's does:
    /// throttled, never backwards, ending at the total once every file was read.
    fn work(&self, owed: &mut Owed, cancel: &CancelToken, report: Option<&dyn Fn(IndexProgress)>) {
        let ids = std::mem::take(&mut owed.queue);
        let scan = std::mem::take(&mut owed.scan);
        owed.due = None;
        let stop = || cancel.is_cancelled();
        let mut throttle = ProgressThrottle::new(PROGRESS_INTERVAL);
        let mut progress = |step| {
            if let Some(report) = report
                && throttle.offer(step, Instant::now())
            {
                report(step);
            }
        };
        let outcome = self
            .listed(scan, &ids)
            .and_then(|notes| self.pass(notes, &mut owed.links, &stop, &mut progress));
        owed.settle(ids, scan, &outcome);
    }

    /// Every note measured again, the queue and an owed scan with it.
    fn reindex(
        &self,
        owed: &mut Owed,
        mut progress: Progress,
        cancel: &CancelToken,
    ) -> Result<Backfilled, IndexError> {
        let ids = std::mem::take(&mut owed.queue);
        let scan = std::mem::take(&mut owed.scan);
        let stop = || cancel.is_cancelled();
        let mut throttle = ProgressThrottle::new(PROGRESS_INTERVAL);
        let outcome = self.scan(true).map_err(IndexError::from).and_then(|notes| {
            self.pass(notes, &mut owed.links, &stop, &mut |step| {
                if throttle.offer(step, Instant::now()) {
                    progress(step);
                }
            })
        });
        owed.settle(ids, scan, &outcome);
        match outcome {
            Ok(pass) if pass.stopped => Err(IndexError::NotOpen),
            Ok(pass) => Ok(pass.done),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finished(unread: &[&str]) -> Result<Pass, IndexError> {
        Ok(Pass {
            done: Backfilled::default(),
            unread: unread.iter().map(|id| (*id).to_owned()).collect(),
            stopped: false,
        })
    }

    /// A pass that finished, a reindex's included, starts the next backoff from the first step.
    #[test]
    fn a_finished_pass_ends_the_backoff() {
        let mut owed = Owed::default();
        for _ in 0..3 {
            owed.settle(BTreeSet::new(), true, &finished(&["unread"]));
        }
        assert_eq!(owed.failures, 3);
        assert!(owed.queue.contains("unread") && owed.scan);
        owed.settle(BTreeSet::new(), false, &finished(&[]));
        assert_eq!(owed.failures, 0);
    }
}
