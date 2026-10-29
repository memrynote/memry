//! The consumer's thread: takes the watcher's facts from a bounded queue and applies them one
//! at a time, runs the open walk after the session's first `Rescanned` and then the open's
//! `after_walk` (the write-back's reconcile), and asks the watcher to report again a path
//! whose fact could not be applied.
//!
//! The watcher's sink never blocks. When the queue is full the facts that do not fit are
//! dropped; the queued ones are still applied, and the watcher is asked to resync: it forgets
//! what it reported and rescans against the rows, which hold what was applied, so every
//! dropped fact is found again. One resync waits for the `Rescanned` of the one before it,
//! and when that pass overflowed too the next waits longer: a flood the consumer cannot keep
//! up with costs a resync now and then, never a loop. When the identity adopts nothing, a
//! resync reads and reports no file without a row except one that can be a moved note
//! (`NewFiles::PairOnly`), so such files cannot flood it.

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
/// The wait before a resync whose previous pass overflowed again; it doubles up to the cap.
const FIRST_RESYNC_DELAY: Duration = Duration::from_secs(1);
const MAX_RESYNC_DELAY: Duration = Duration::from_secs(60);

/// The watcher's side of the queue.
pub struct Inbox {
    rx: Receiver<VaultEvent>,
    overflow: Arc<AtomicBool>,
}

/// A queue for one session: the sink the watcher reports to, and the consumer's end.
pub fn inbox(capacity: usize) -> (EventSink, Inbox) {
    let (tx, rx) = sync_channel(capacity);
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

/// The work an open runs once its walk ended (the write-back's reconcile), given whether the
/// consumer was stopped since, so a close does not wait for all of it.
pub(crate) type AfterWalk = Box<dyn FnOnce(&dyn Fn() -> bool) + Send>;

impl Consumer {
    pub(super) fn start(
        applier: Applier,
        inbox: Inbox,
        watch: WatchHandle,
        exclude: Vec<String>,
        after_walk: AfterWalk,
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
            after_walk: Some(after_walk),
            retries: Retries::default(),
            resync: Resync::default(),
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
    /// Runs once the open walk ended, so the files edited while the vault was closed are fed
    /// before it.
    after_walk: Option<AfterWalk>,
    retries: Retries,
    resync: Resync,
}

/// Resyncs asked of the watcher after the queue overflowed.
struct Resync {
    /// Facts were dropped since the last resync was asked for.
    owed: bool,
    /// A resync was asked for and its pass has not reported `Rescanned` yet.
    waiting: bool,
    not_before: Instant,
    delay: Duration,
}

impl Default for Resync {
    fn default() -> Self {
        Self {
            owed: false,
            waiting: false,
            not_before: Instant::now(),
            delay: FIRST_RESYNC_DELAY,
        }
    }
}

impl Resync {
    /// The pass of the last resync ended. When the queue overflowed again meanwhile, the next
    /// resync waits, longer each time.
    fn pass_ended(&mut self, now: Instant) {
        if !self.waiting {
            return;
        }
        self.waiting = false;
        if self.owed {
            self.not_before = now + self.delay;
            self.delay = (self.delay * 2).min(MAX_RESYNC_DELAY);
        } else {
            self.not_before = now;
            self.delay = FIRST_RESYNC_DELAY;
        }
    }

    fn due(&self, now: Instant) -> bool {
        self.owed && !self.waiting && self.not_before <= now
    }
}

impl Run {
    fn work(&mut self) {
        while !self.stopped() {
            self.note_overflow();
            let now = Instant::now();
            let mut wait = self
                .retries
                .next_due()
                .map_or(IDLE, |due| due.saturating_duration_since(now).min(IDLE));
            if self.resync.owed && !self.resync.waiting {
                wait = wait.min(self.resync.not_before.saturating_duration_since(now));
            }
            match self.inbox.rx.recv_timeout(wait) {
                Ok(event) => self.take(event),
                // A resync waits for its pass's `Rescanned`, facts were dropped since, and the
                // queue went quiet: that `Rescanned` may have been dropped too, and a pass
                // still walking reports nothing for a while. The pass counts as ended, and the
                // next resync waits out the backoff.
                Err(RecvTimeoutError::Timeout) if self.resync.owed && self.resync.waiting => {
                    self.resync.pass_ended(Instant::now());
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            let now = Instant::now();
            for path in self.retries.due(now) {
                self.watch.forget(path);
            }
            if self.resync.due(now) {
                self.resync.owed = false;
                self.resync.waiting = true;
                self.watch.resync();
            }
        }
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    fn note_overflow(&mut self) {
        if self.inbox.overflow.swap(false, Ordering::Relaxed) && !self.resync.owed {
            tracing::warn!(
                scope = "vault_consumer",
                "the watcher reported faster than the index could follow; resyncing"
            );
            self.resync.owed = true;
        }
    }

    fn take(&mut self, event: VaultEvent) {
        let rescanned = matches!(event, VaultEvent::Rescanned { .. });
        let path = match &event {
            VaultEvent::Added { path, .. } | VaultEvent::Changed { path, .. } => Some(path.clone()),
            _ => None,
        };
        let step = self.applier.apply(event);
        self.after(step, path.as_deref());
        if rescanned {
            self.resync.pass_ended(Instant::now());
            if self.walk_owed {
                self.walk_owed = false;
                self.walk();
            }
        }
    }

    fn after(&mut self, step: Step, path: Option<&str>) {
        match step {
            Step::Retry(path) => self.retries.schedule(path, Instant::now()),
            Step::Done => {
                if let Some(path) = path {
                    self.retries.succeeded(path);
                }
            }
        }
        // The lane is not fair: a flood of facts must not starve an app operation waiting
        // for it.
        std::thread::yield_now();
    }

    /// Offers every file of the vault, as a watcher `Added` would: the start rescan reports
    /// no new or edited file when nothing went missing, so this is where they are found.
    /// The facts that arrive meanwhile are applied between files, so a long walk does not
    /// overflow the queue.
    fn walk(&mut self) {
        let root = self.applier.root.clone();
        let walk = walk_vault_with(&root, &self.exclude, Limits::DEFAULT);
        let complete = walk.truncated.is_none() && walk.too_deep == 0;
        for path in walk.files {
            if self.stopped() {
                return;
            }
            self.note_overflow();
            while let Ok(event) = self.inbox.rx.try_recv() {
                self.take(event);
            }
            if !self.filter.takes_file(&path) {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(PathBuf::from(&root).join(&path)) else {
                continue;
            };
            if meta.is_file() {
                let step = self.applier.walked(&path, &meta);
                self.after(step, Some(&path));
            }
        }
        if let Ok(lane) = self.applier.rows.lane_of(self.applier.session) {
            lane.publish(Applied::Indexed {
                complete: complete && self.applier.identity.adopts(),
            });
        }
        if let Some(after_walk) = self.after_walk.take() {
            after_walk(&|| self.stopped());
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

    /// A path that was applied starts its count again the next time it fails.
    fn succeeded(&mut self, path: &str) {
        self.by_path.remove(path);
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

    #[test]
    fn a_path_that_was_applied_starts_its_count_again() {
        let t0 = Instant::now();
        let mut retries = Retries::default();
        for _ in 0..MAX_RETRIES {
            retries.schedule("a.md".into(), t0);
        }
        retries.succeeded("a.md");
        retries.schedule("a.md".into(), t0);
        assert_eq!(retries.next_due(), Some(t0 + FIRST_RETRY));
    }

    #[test]
    fn a_resync_waits_for_the_pass_before_it_and_longer_while_passes_overflow() {
        let t0 = Instant::now();
        let mut resync = Resync {
            owed: true,
            ..Resync::default()
        };
        assert!(resync.due(t0 + FIRST_RESYNC_DELAY));
        resync.owed = false;
        resync.waiting = true;
        resync.owed = true;
        assert!(
            !resync.due(t0 + MAX_RESYNC_DELAY),
            "a second resync before its pass ended"
        );
        resync.pass_ended(t0);
        assert!(!resync.due(t0));
        assert!(resync.due(t0 + FIRST_RESYNC_DELAY));
        resync.owed = false;
        resync.waiting = true;
        resync.owed = true;
        resync.pass_ended(t0);
        assert!(!resync.due(t0 + FIRST_RESYNC_DELAY));
        assert!(resync.due(t0 + FIRST_RESYNC_DELAY * 2));
        resync.owed = false;
        resync.waiting = true;
        resync.pass_ended(t0);
        resync.owed = true;
        assert!(resync.due(t0), "a pass that kept up did not reset the wait");
    }
}
