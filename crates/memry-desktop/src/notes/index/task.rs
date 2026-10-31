//! The index task of one open vault: what the facts owe, when it is paid, and the `vault_reindex`
//! requests, in one loop that parks until a fact, a request or the owed work's time.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::mpsc as reply;
use std::time::Instant;

use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;

use super::pass::Indexer;
use super::{
    Backfilled, IDLE_DELAY, IndexError, IndexProgress, PROGRESS_INTERVAL, ProgressThrottle,
    RETRY_FIRST, RETRY_MAX,
};
use crate::session::projection::CancelToken;
use crate::vault::consumer::Applied;
use crate::vault::watch::VaultEvent;

pub(super) type Progress = Box<dyn FnMut(IndexProgress) + Send>;
type Answer = reply::Receiver<Result<Backfilled, IndexError>>;

enum Command {
    Reindex {
        progress: Progress,
        answer: reply::Sender<Result<Backfilled, IndexError>>,
    },
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

    /// `None` when the task already ended.
    pub(super) fn reindex(&self, progress: Progress) -> Option<Answer> {
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

/// The work the facts owe and its time.
#[derive(Default)]
struct Owed {
    queue: BTreeSet<String>,
    scan: bool,
    /// The core search reindex (links, body tags, full text).
    links: bool,
    /// The open walk ended: nothing is worked before.
    walked: bool,
    due: Option<Instant>,
    failures: u32,
}

impl Owed {
    fn arm(&mut self) {
        self.due = self.due.or(Some(Instant::now() + IDLE_DELAY));
    }

    fn scan(&mut self) {
        self.walked = true;
        self.scan = true;
        self.arm();
    }

    /// When the owed work is due; `None` while nothing is owed or the walk has not ended.
    fn next(&self) -> Option<Instant> {
        let owed = self.scan || self.links || !self.queue.is_empty();
        (self.walked && owed).then(|| self.due.unwrap_or_else(Instant::now))
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
    pub fn run(
        &self,
        facts: Receiver<Applied>,
        inbox: TaskInbox,
        cancel: &CancelToken,
    ) -> Result<(), String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .map_err(|error| format!("the note index task has no runtime: {error}"))?;
        runtime.block_on(self.serve(facts, inbox, cancel));
        Ok(())
    }

    async fn serve(&self, mut facts: Receiver<Applied>, inbox: TaskInbox, cancel: &CancelToken) {
        let TaskInbox(mut commands) = inbox;
        // Owed at every open: a pass that wrote rows may have ended before its search reindex.
        let mut owed = Owed {
            links: true,
            ..Owed::default()
        };
        while !cancel.is_cancelled() {
            let next = owed.next();
            let wake = tokio::time::Instant::from_std(next.unwrap_or_else(Instant::now));
            tokio::select! {
                biased;
                command = commands.recv() => match command {
                    Some(Command::Reindex { progress, answer }) => {
                        // The asker may have gone; the work is done either way.
                        let _ = answer.send(self.reindex(&mut owed, progress, cancel));
                    }
                    Some(Command::Stop) | None => return,
                },
                fact = facts.recv() => match fact {
                    Ok(fact) => self.take(&mut owed, fact),
                    Err(RecvError::Lagged(missed)) => {
                        tracing::warn!(scope = "note_index", missed, "facts were lost: scanning");
                        owed.scan();
                    }
                    Err(RecvError::Closed) => return,
                },
                () = tokio::time::sleep_until(wake), if next.is_some() => self.work(&mut owed, cancel),
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
                    owed.scan();
                }
            }
            Applied::Indexed { .. } => owed.scan(),
            // No `Indexed` follows a watcher that did not start: the scan is owed now.
            Applied::Vault(VaultEvent::WatchFailed { .. }) => owed.scan(),
            Applied::Vault(_) => {}
        }
    }

    fn work(&self, owed: &mut Owed, cancel: &CancelToken) {
        let ids = std::mem::take(&mut owed.queue);
        let scan = std::mem::take(&mut owed.scan);
        owed.due = None;
        let stop = || cancel.is_cancelled();
        let outcome = self
            .listed(scan, &ids)
            .and_then(|notes| self.pass(notes, &mut owed.links, &stop, &mut |_| {}));
        match outcome {
            Ok(pass) if pass.stopped => {
                owed.queue.extend(ids);
                owed.scan |= scan;
            }
            Ok(pass) if pass.unread.is_empty() && !owed.links => owed.failures = 0,
            Ok(pass) => {
                tracing::warn!(
                    scope = "note_index",
                    unread = pass.unread.len(),
                    "the pass did not finish: retrying"
                );
                owed.retry(pass.unread.into_iter().collect());
            }
            Err(error) => {
                tracing::warn!(scope = "note_index", "index pass failed, retrying: {error}");
                owed.retry(ids);
            }
        }
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
        match outcome {
            Ok(pass) if pass.stopped => {
                owed.queue.extend(ids);
                owed.scan |= scan;
                Err(IndexError::NotOpen)
            }
            Ok(pass) => {
                if !pass.unread.is_empty() || owed.links {
                    owed.retry(pass.unread.into_iter().collect());
                }
                Ok(pass.done)
            }
            Err(error) => {
                owed.retry(ids);
                Err(error)
            }
        }
    }
}
