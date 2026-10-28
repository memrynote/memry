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
use super::handle::{Gate, Msg, NewFiles, WatchHandle};
use super::reconcile::Reconciler;
use super::safety::{SafetyNet, Tuning};

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

pub struct VaultWatcher {
    stop: Arc<AtomicBool>,
    gate: Gate,
    handle: WatchHandle,
    thread: Option<JoinHandle<()>>,
}

impl VaultWatcher {
    /// Starts watching `root`. The OS watcher is set up before this returns, so a failure
    /// (the Linux inotify limit) is the caller's error.
    ///
    /// The start rescan runs on the worker, after this returns, and always ends with a
    /// [`VaultEvent::Rescanned`], sent at the pass's deadline: when the windows it opened end
    /// (the rename window of each removal it found, the grace of each new file it holds), so
    /// what it found is reported before it. A writer that touches one of those files again
    /// restarts its window, and that `Removed` or `Added` follows the signal as a live event
    /// (the deadline is the cap, `rescan::end_pass`). Electron ran the pass before the open's
    /// index walk (it replays the removals of files deleted while the app was closed). The
    /// consumer that applies events (12e) must run its open walk after that first
    /// `Rescanned`, or the walk indexes a file whose removal is still on its way, and must
    /// handle a later event for a path the walk already covered like any live event.
    pub fn start(
        root: PathBuf,
        exclude: Vec<String>,
        files: NoteFiles,
        echo: Arc<EchoGuard>,
        sink: EventSink,
        new_files: NewFiles,
    ) -> Result<Self, WatchError> {
        Self::start_with(
            root,
            exclude,
            files,
            echo,
            sink,
            Tuning::platform(),
            new_files,
        )
    }

    pub fn start_with(
        root: PathBuf,
        exclude: Vec<String>,
        files: NoteFiles,
        echo: Arc<EchoGuard>,
        sink: EventSink,
        tuning: Tuning,
        new_files: NewFiles,
    ) -> Result<Self, WatchError> {
        let (tx, rx) = sync_channel(CHANNEL_CAPACITY);
        let overflow = Arc::new(AtomicBool::new(false));
        let watcher = watch(&root, &tx, &overflow)?;
        let stop = Arc::new(AtomicBool::new(false));
        let gate = Gate::open();
        let sink = gate.wrap(sink);
        let reconciler = Reconciler::new(root.clone(), exclude, files, echo, sink.clone())
            .with_stop(stop.clone())
            .with_new_files(new_files);
        let mut worker = Worker::new(
            reconciler,
            root,
            sink,
            tuning,
            (tx, rx),
            overflow,
            stop.clone(),
        );
        worker.watcher = Some(watcher);
        let handle = WatchHandle::new(worker.tx.clone(), worker.resync.clone());
        let thread = std::thread::Builder::new()
            .name("vault-watcher".into())
            .spawn(move || worker.run())
            .map_err(WatchError::Thread)?;
        Ok(Self {
            stop,
            gate,
            handle,
            thread: Some(thread),
        })
    }

    pub fn handle(&self) -> WatchHandle {
        self.handle.clone()
    }

    /// Stops the worker and waits for it. No event leaves from the moment this is called
    /// (`Gate`). The worker looks at the flag every tick, between the files of a batch and
    /// between the steps of a rescan; the walk of the vault or of a new folder cannot be
    /// interrupted (it is bounded by the walk caps), so the join can take as long as one walk.
    pub fn stop(&mut self) {
        self.gate.close();
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
    /// Set by [`WatchHandle::resync`].
    resync: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    /// Held so the OS keeps delivering; replaced when the vault returns.
    watcher: Option<RecommendedWatcher>,
    net: SafetyNet,
    last_error: Option<Instant>,
}

impl Worker {
    fn new(
        reconciler: Reconciler,
        root: PathBuf,
        sink: EventSink,
        tuning: Tuning,
        (tx, rx): (SyncSender<Msg>, Receiver<Msg>),
        overflow: Arc<AtomicBool>,
        stop: Arc<AtomicBool>,
    ) -> Self {
        Self {
            reconciler,
            canonical_root: std::fs::canonicalize(&root).ok(),
            root,
            sink,
            tx,
            rx,
            overflow,
            resync: Arc::default(),
            stop,
            watcher: None,
            net: SafetyNet::new(tuning, Instant::now()),
            last_error: None,
        }
    }

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
            let mut paths_taken = 0;
            while let Some(msg) = next {
                match msg {
                    Msg::Paths(paths) => {
                        paths_taken += paths.len();
                        for path in paths {
                            match self.rel_of(&path) {
                                Some(rel) if rel.is_empty() => self.reconciler.check_reachable(),
                                Some(rel) => debounce.touch(rel, now),
                                None => {}
                            }
                        }
                    }
                    Msg::Rescan => force_rescan = true,
                    Msg::Forget(rel) => {
                        self.reconciler.reported.remove(&rel);
                        debounce.touch(rel, now);
                    }
                    Msg::Error(error) => {
                        self.report(&error, now);
                        self.net.lost_events(now);
                    }
                }
                taken += 1;
                next = if taken < MAX_PER_TICK {
                    self.rx.try_recv().ok()
                } else {
                    None
                };
            }

            self.net.traffic(paths_taken, now);
            if self.reconciler.is_away() {
                debounce.clear();
                if now.duration_since(last_poll) >= RETURN_POLL {
                    last_poll = now;
                    self.try_return();
                }
                continue;
            }
            if self.net.rescan_due(now) {
                if self.net.rearms() {
                    // A watch the OS dropped without saying so is back.
                    self.rearm(now);
                }
                force_rescan = true;
            }
            if self.resync.swap(false, Ordering::Relaxed) {
                self.reconciler.reported.clear();
                self.reconciler.clear();
                force_rescan = true;
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

    /// Sets the OS watch up again. The old watch is replaced only once the new one is armed: a
    /// failed re-arm leaves the watching that still works.
    fn rearm(&mut self, now: Instant) {
        match watch(&self.root, &self.tx, &self.overflow) {
            Ok(watcher) => self.watcher = Some(watcher),
            Err(error) => self.report(&error, now),
        }
    }

    fn report(&mut self, error: &notify::Error, now: Instant) {
        tracing::warn!(
            scope = "vault_watch",
            "the OS watcher reported an error: {error}"
        );
        if self
            .last_error
            .is_some_and(|at| now.duration_since(at) < ERROR_REPORT_EVERY)
        {
            return;
        }
        self.last_error = Some(now);
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

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use memry_core::api::vault::Vault;
    use memry_core::domain::note_files::NoteFileStat;
    use memry_core::storage::OpenOptions;

    use super::*;
    use crate::vault::hash::content_hash;

    #[test]
    fn a_closed_gate_lets_no_event_through() {
        let seen = Arc::new(Mutex::new(0));
        let counter = seen.clone();
        let gate = Gate::open();
        let sink = gate.wrap(Arc::new(move |_| *counter.lock().unwrap() += 1));
        sink(VaultEvent::Reachable);
        gate.close();
        sink(VaultEvent::Reachable);
        assert_eq!(*seen.lock().unwrap(), 1);
    }

    /// A backend error is the OS watcher saying it may have lost events and may be blind to
    /// part of the vault: a rescan follows, and finds the edit no event announced.
    #[test]
    fn a_backend_error_ends_in_a_rescan_that_finds_what_no_event_announced() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let core = root.join(".memry/core");
        std::fs::create_dir_all(&core).unwrap();
        let vault =
            Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
        std::fs::write(root.join("a.md"), "edited behind the watcher's back").unwrap();
        vault
            .note_files()
            .upsert_stat(NoteFileStat {
                note_id: "n1".into(),
                path: "a.md".into(),
                file_type: "markdown".into(),
                mime_type: None,
                file_size: Some(4),
                content_hash: Some(content_hash("base")),
                indexed_at: 1,
            })
            .unwrap();
        let log: Arc<Mutex<Vec<VaultEvent>>> = Arc::default();
        let events = log.clone();
        let sink: EventSink = Arc::new(move |event| events.lock().unwrap().push(event));
        let stop = Arc::new(AtomicBool::new(false));
        let reconciler = Reconciler::new(
            root.clone(),
            vec![],
            vault.note_files(),
            Arc::new(EchoGuard::default()),
            sink.clone(),
        );
        let (tx, rx) = sync_channel(8);
        let mut worker = Worker::new(
            reconciler,
            root,
            sink,
            Tuning::none(),
            (tx.clone(), rx),
            Arc::default(),
            stop.clone(),
        );
        tx.send(Msg::Error(notify::Error::generic("inotify said no")))
            .unwrap();
        let thread = std::thread::spawn(move || worker.work());

        let deadline = Instant::now() + Duration::from_secs(20);
        let changed = |log: &Mutex<Vec<VaultEvent>>| {
            log.lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, VaultEvent::Changed { note_id, .. } if note_id == "n1"))
        };
        while !changed(&log) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        stop.store(true, Ordering::Relaxed);
        thread.join().unwrap();
        let events = log.lock().unwrap().clone();
        assert!(changed(&log), "no rescan after the error: {events:?}");
        assert!(
            events
                .iter()
                .any(|e| matches!(e, VaultEvent::WatchFailed { .. })),
            "the failure is reported too: {events:?}"
        );
    }

    /// A re-arm that fails (the folder is momentarily gone, the OS is out of watches) keeps the
    /// watch that still works: dropping it first would leave the vault unwatched.
    #[test]
    fn a_failed_re_arm_keeps_the_old_watch() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let core = root.join(".memry/core");
        std::fs::create_dir_all(&core).unwrap();
        let vault =
            Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap();
        let log: Arc<Mutex<Vec<VaultEvent>>> = Arc::default();
        let events = log.clone();
        let sink: EventSink = Arc::new(move |event| events.lock().unwrap().push(event));
        let reconciler = Reconciler::new(
            root.clone(),
            vec![],
            vault.note_files(),
            Arc::new(EchoGuard::default()),
            sink.clone(),
        );
        let (tx, rx) = sync_channel(8);
        let overflow = Arc::<AtomicBool>::default();
        let mut worker = Worker::new(
            reconciler,
            root.clone(),
            sink,
            Tuning::windows(),
            (tx.clone(), rx),
            overflow.clone(),
            Arc::default(),
        );
        worker.watcher = Some(watch(&root, &tx, &overflow).unwrap());

        worker.root = dir.path().join("not-there");
        worker.rearm(Instant::now());
        assert!(worker.watcher.is_some(), "the old watch was dropped");
        assert!(
            log.lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, VaultEvent::WatchFailed { .. })),
            "the failure is reported"
        );

        worker.root = root.clone();
        worker.rearm(Instant::now());
        assert!(worker.watcher.is_some());
    }
}
