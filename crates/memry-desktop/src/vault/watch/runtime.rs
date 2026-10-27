//! The `notify` watcher and the thread that owns the reconciler.
//!
//! The OS callback only queues: it pushes the reported paths into a bounded channel and never
//! touches a file or the database. When the channel is full, or the debouncer holds too many
//! paths, the queue is dropped and one full rescan stands in for what was lost, so a flood
//! (`git checkout` of a big branch, a folder copy) costs a rescan and never memory without
//! bound and never a silently missed change.
//!
//! One worker thread does everything else, in a loop with a short tick: take what arrived,
//! look at the paths that went quiet, settle deletes whose rename window closed. A vault that
//! becomes unreachable (an unplugged drive) is polled until it is back, then watched again and
//! rescanned.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use memry_core::api::note_files::NoteFiles;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::debounce::Debouncer;
use super::echo::EchoGuard;
use super::event::{EventSink, VaultEvent};
use super::gone::is_vault_reachable;
use super::reconcile::Reconciler;

/// Messages queued between the OS callback and the worker.
pub const CHANNEL_CAPACITY: usize = 65_536;
/// How long the worker waits for a message before it looks at the clock.
const TICK: Duration = Duration::from_millis(50);
/// Messages taken per tick, so a flood cannot starve the debounce and the settle.
const MAX_PER_TICK: usize = 4096;
/// `VAULT_RETURN_POLL_MS`: how often an unreachable vault is looked at.
const RETURN_POLL: Duration = Duration::from_secs(2);
/// A burst of identical OS errors is reported once a minute.
const ERROR_REPORT_EVERY: Duration = Duration::from_secs(60);

#[derive(Debug, thiserror::Error)]
pub enum WatchError {
    #[error("the file watcher could not start: {0}")]
    Notify(#[from] notify::Error),
    #[error("the watcher thread could not start: {0}")]
    Thread(std::io::Error),
}

enum Msg {
    Paths(Vec<PathBuf>),
    Rescan,
    Error(notify::Error),
}

pub struct VaultWatcher {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl VaultWatcher {
    /// Starts watching `root`. The OS watcher is set up before this returns, so a failure
    /// (the Linux inotify limit) is the caller's error.
    pub fn start(
        root: PathBuf,
        exclude: Vec<String>,
        files: NoteFiles,
        echo: Arc<EchoGuard>,
        sink: EventSink,
    ) -> Result<Self, WatchError> {
        let (tx, rx) = sync_channel(CHANNEL_CAPACITY);
        let overflow = Arc::new(AtomicBool::new(false));
        let watcher = watch(&root, &tx, &overflow)?;
        let stop = Arc::new(AtomicBool::new(false));
        let worker = Worker {
            reconciler: Reconciler::new(root.clone(), exclude, files, echo, sink.clone()),
            canonical_root: std::fs::canonicalize(&root).ok(),
            root,
            sink,
            tx,
            rx,
            overflow,
            stop: stop.clone(),
            watcher: Some(watcher),
        };
        let thread = std::thread::Builder::new()
            .name("vault-watcher".into())
            .spawn(move || worker.run())
            .map_err(WatchError::Thread)?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }

    /// Stops the worker and waits for it. It looks at the flag every tick and between the
    /// steps of a rescan, so this returns promptly.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            tracing::error!(scope = "vault_watch", "the watcher thread panicked");
        }
    }
}

impl VaultWatcher {
    /// [`VaultWatcher::stop`] by value, for a caller that is done with it.
    pub fn stop_and_drop(mut self) {
        self.stop();
    }
}

impl Drop for VaultWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

fn watch(
    root: &Path,
    tx: &SyncSender<Msg>,
    overflow: &Arc<AtomicBool>,
) -> notify::Result<RecommendedWatcher> {
    let (tx, overflow) = (tx.clone(), overflow.clone());
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let msg = match result {
            Ok(event) if matches!(event.kind, EventKind::Access(_)) => return,
            Ok(event) if event.need_rescan() => Msg::Rescan,
            Ok(event) => Msg::Paths(event.paths),
            Err(error) => Msg::Error(error),
        };
        match tx.try_send(msg) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => overflow.store(true, Ordering::Relaxed),
            Err(TrySendError::Disconnected(_)) => {}
        }
    })?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok(watcher)
}

struct Worker {
    reconciler: Reconciler,
    root: PathBuf,
    canonical_root: Option<PathBuf>,
    sink: EventSink,
    tx: SyncSender<Msg>,
    rx: Receiver<Msg>,
    overflow: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    /// Held so the OS keeps delivering; replaced when the vault returns.
    watcher: Option<RecommendedWatcher>,
}

impl Worker {
    fn run(mut self) {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.work()));
        if outcome.is_err() {
            (self.sink)(VaultEvent::WatchFailed {
                message: "the vault watcher stopped unexpectedly".into(),
                limit: false,
            });
        }
    }

    fn work(&mut self) {
        let mut debounce = Debouncer::standard();
        let mut force_rescan = false;
        let mut last_poll = Instant::now();
        let mut last_error: Option<Instant> = None;
        // Files removed while the app was closed get the removal a live unlink would have.
        self.rescan(false);

        while !self.stop.load(Ordering::Relaxed) {
            let mut next = match self.rx.recv_timeout(TICK) {
                Ok(msg) => Some(msg),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            };
            let now = Instant::now();
            let mut taken = 0;
            while let Some(msg) = next {
                match msg {
                    Msg::Paths(paths) => {
                        for path in paths {
                            match self.rel_of(&path) {
                                Some(rel) if rel.is_empty() => self.reconciler.check_reachable(),
                                Some(rel) => debounce.touch(rel, now),
                                None => {}
                            }
                        }
                    }
                    Msg::Rescan => force_rescan = true,
                    Msg::Error(error) => self.report(&error, now, &mut last_error),
                }
                taken += 1;
                next = if taken < MAX_PER_TICK {
                    self.rx.try_recv().ok()
                } else {
                    None
                };
            }

            if self.reconciler.is_away() {
                debounce.clear();
                if now.duration_since(last_poll) >= RETURN_POLL {
                    last_poll = now;
                    self.try_return();
                }
                continue;
            }
            if self.overflow.swap(false, Ordering::Relaxed)
                | debounce.take_overflow()
                | std::mem::take(&mut force_rescan)
                | self.reconciler.take_rescan_owed()
            {
                self.rescan(true);
            }
            let due = debounce.due(now);
            if !due.is_empty() {
                self.reconciler.batch(due, now);
            }
            self.reconciler.settle_expired(now);
        }
        self.reconciler.clear();
    }

    fn rescan(&mut self, with_changes: bool) {
        if let Err(error) = self
            .reconciler
            .rescan(with_changes, Instant::now(), &self.stop)
        {
            tracing::error!(scope = "vault_watch", "the rescan failed: {error}");
            (self.sink)(VaultEvent::WatchFailed {
                message: error.to_string(),
                limit: false,
            });
        }
    }

    /// The vault is back: watch it again (the old watch may point at nothing) and rescan.
    fn try_return(&mut self) {
        if !is_vault_reachable(&self.root) {
            return;
        }
        self.watcher = None;
        match watch(&self.root, &self.tx, &self.overflow) {
            Ok(watcher) => self.watcher = Some(watcher),
            Err(error) => {
                (self.sink)(VaultEvent::WatchFailed {
                    message: error.to_string(),
                    limit: matches!(error.kind, notify::ErrorKind::MaxFilesWatch),
                });
                return;
            }
        }
        self.reconciler.come_back();
        self.rescan(true);
    }

    fn report(&self, error: &notify::Error, now: Instant, last: &mut Option<Instant>) {
        tracing::warn!(
            scope = "vault_watch",
            "the OS watcher reported an error: {error}"
        );
        if last.is_some_and(|at| now.duration_since(at) < ERROR_REPORT_EVERY) {
            return;
        }
        *last = Some(now);
        (self.sink)(VaultEvent::WatchFailed {
            message: error.to_string(),
            limit: matches!(error.kind, notify::ErrorKind::MaxFilesWatch),
        });
    }

    /// The vault-relative `/` path of an absolute one. The OS may report the root through a
    /// link (`/var` for `/private/var` on macOS), so the canonical root is tried too.
    fn rel_of(&self, path: &Path) -> Option<String> {
        let rest = path.strip_prefix(&self.root).ok().or_else(|| {
            let canonical = self.canonical_root.as_deref()?;
            path.strip_prefix(canonical).ok()
        })?;
        let mut rel = String::new();
        for part in rest.components() {
            if !rel.is_empty() {
                rel.push('/');
            }
            rel.push_str(part.as_os_str().to_str()?);
        }
        Some(rel)
    }
}
