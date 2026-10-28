//! The consumer's thread: takes the watcher's facts from a bounded queue and applies them one
//! at a time, runs the open walk after the session's first `Rescanned`, and asks the watcher
//! to report again a path whose fact could not be applied.
//!
//! The watcher's sink never blocks. When the queue is full its facts are dropped and the
//! watcher is asked to resync: it forgets what it reported and rescans against the rows, which
//! hold exactly what was applied, so every dropped fact is found again.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TrySendError, sync_channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::Applied;
use super::apply::{Applier, Step};
use crate::vault::walk::{Limits, walk_vault_with};
use crate::vault::watch::filter::WatchFilter;
use crate::vault::watch::{EventSink, VaultEvent, WatchHandle};

/// Facts queued between the watcher and the consumer.
pub const QUEUE_CAPACITY: usize = 65_536;
/// Attempts per path and session before a fact waits for the next open.
pub const MAX_RETRIES: u32 = 5;
/// The first retry's delay; each next one doubles it.
pub const FIRST_RETRY: Duration = Duration::from_secs(1);
/// How long the loop waits for a fact before it looks at the clock.
const IDLE: Duration = Duration::from_millis(250);

/// The watcher's side of the queue.
pub struct Inbox {
    rx: Receiver<VaultEvent>,
    overflow: Arc<AtomicBool>,
}

/// A queue for one session: the sink the watcher reports to, and the consumer's end.
pub fn inbox() -> (EventSink, Inbox) {
    let (tx, rx) = sync_channel(QUEUE_CAPACITY);
    let overflow = Arc::new(AtomicBool::new(false));
    let full = overflow.clone();
    let sink: EventSink = Arc::new(move |event| match tx.try_send(event) {
        Ok(()) | Err(TrySendError::Disconnected(_)) => {}
        Err(TrySendError::Full(_)) => full.store(true, Ordering::Relaxed),
    });
    (sink, Inbox { rx, overflow })
}

pub struct Consumer {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Consumer {
    pub(super) fn start(
        applier: Applier,
        inbox: Inbox,
        watch: WatchHandle,
        exclude: Vec<String>,
    ) -> std::io::Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let mut run = Run {
            filter: WatchFilter::new(exclude.clone()),
            exclude,
            applier,
            inbox,
            watch,
            stop: stop.clone(),
            walk_owed: true,
            retries: Retries::default(),
        };
        let thread = std::thread::Builder::new()
            .name("vault-consumer".into())
            .spawn(move || run.work())?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }

    /// Stops after the fact or the file being applied, and waits. Facts still queued are
    /// dropped: the rows do not hold them, so the next open finds them again.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            tracing::error!(scope = "vault_consumer", "the consumer thread panicked");
        }
    }
}

impl Drop for Consumer {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Run {
    applier: Applier,
    inbox: Inbox,
    watch: WatchHandle,
    filter: WatchFilter,
    exclude: Vec<String>,
    stop: Arc<AtomicBool>,
    /// The open walk waits for the session's first `Rescanned`.
    walk_owed: bool,
    retries: Retries,
}

impl Run {
    fn work(&mut self) {
        while !self.stopped() {
            if self.inbox.overflow.swap(false, Ordering::Relaxed) {
                while self.inbox.rx.try_recv().is_ok() {}
                tracing::warn!(
                    scope = "vault_consumer",
                    "the watcher reported faster than the index could follow; resyncing"
                );
                self.watch.resync();
            }
            let now = Instant::now();
            let wait = self
                .retries
                .next_due()
                .map_or(IDLE, |due| due.saturating_duration_since(now).min(IDLE));
            match self.inbox.rx.recv_timeout(wait) {
                Ok(event) => self.take(event),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            for path in self.retries.due(Instant::now()) {
                self.watch.forget(path);
            }
        }
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    fn take(&mut self, event: VaultEvent) {
        let opens_walk = self.walk_owed && matches!(event, VaultEvent::Rescanned { .. });
        let step = self.applier.apply(event);
        self.after(step);
        if opens_walk {
            self.walk_owed = false;
            self.walk();
        }
    }

    fn after(&mut self, step: Step) {
        if let Step::Retry(path) = step {
            self.retries.schedule(path, Instant::now());
        }
        // The lane is not fair: a flood of facts must not starve an app operation waiting
        // for it.
        std::thread::yield_now();
    }

    /// Offers every file of the vault, as a watcher `Added` would: the start rescan reports
    /// no new or edited file when nothing went missing, so this is where they are found.
    fn walk(&mut self) {
        let root = self.applier.root.clone();
        let walk = walk_vault_with(&root, &self.exclude, Limits::DEFAULT);
        let complete = walk.truncated.is_none() && walk.too_deep == 0;
        for path in walk.files {
            if self.stopped() {
                return;
            }
            if !self.filter.takes_file(&path) {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(PathBuf::from(&root).join(&path)) else {
                continue;
            };
            if meta.is_file() {
                let step = self.applier.walked(&path, &meta);
                self.after(step);
            }
        }
        if let Ok(lane) = self.applier.rows.lane() {
            lane.publish(Applied::Indexed { complete });
        }
    }
}

/// Paths whose fact failed, with their next attempt.
#[derive(Default)]
struct Retries {
    by_path: HashMap<String, Retry>,
}

struct Retry {
    attempts: u32,
    due: Option<Instant>,
}

impl Retries {
    fn schedule(&mut self, path: String, now: Instant) {
        let retry = self.by_path.entry(path).or_insert(Retry {
            attempts: 0,
            due: None,
        });
        retry.attempts += 1;
        if retry.attempts > MAX_RETRIES {
            if retry.attempts == MAX_RETRIES + 1 {
                tracing::warn!(
                    scope = "vault_consumer",
                    "a vault file failed {MAX_RETRIES} times; the next open tries again"
                );
            }
            retry.due = None;
            return;
        }
        retry.due = Some(now + FIRST_RETRY * 2u32.pow(retry.attempts - 1));
    }

    fn next_due(&self) -> Option<Instant> {
        self.by_path.values().filter_map(|r| r.due).min()
    }

    fn due(&mut self, now: Instant) -> Vec<String> {
        let mut due = Vec::new();
        for (path, retry) in &mut self.by_path {
            if retry.due.is_some_and(|at| at <= now) {
                retry.due = None;
                due.push(path.clone());
            }
        }
        due
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_is_retried_with_doubling_delays_and_then_left_for_the_next_open() {
        let t0 = Instant::now();
        let mut retries = Retries::default();
        let mut at = t0;
        for n in 0..MAX_RETRIES {
            retries.schedule("a.md".into(), at);
            let due = retries.next_due().expect("a retry is due");
            assert_eq!(due - at, FIRST_RETRY * 2u32.pow(n));
            assert!(retries.due(due - Duration::from_millis(1)).is_empty());
            assert_eq!(retries.due(due), vec!["a.md".to_owned()]);
            at = due;
        }
        retries.schedule("a.md".into(), at);
        assert_eq!(retries.next_due(), None, "a sixth attempt was scheduled");
    }
}
