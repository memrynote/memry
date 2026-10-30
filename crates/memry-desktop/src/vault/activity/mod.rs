//! The vault activity log (`vault/activity-log.ts`): a device-local record of what happened to
//! files that entered or left the vault from outside the app, the files it skipped, and what
//! failed. `<vault>/.memry/activity.jsonl`, one JSON entry per line, with the retention in
//! `activity-settings.json` beside it. `.memry` is outside the note tree, so the log never
//! becomes a note and never syncs.
//!
//! Both files are shared with Electron builds and with older and newer builds of this app:
//! - a line is kept byte for byte while the retention window and the cap keep it, a field or
//!   a kind this build does not know included ([`entry`]). A line that is not JSON is dropped
//!   by the next rewrite, as Electron drops it;
//! - an entry this build writes has the bytes Electron's writer gives the same fields;
//! - a log file that exists and cannot be read (permission, over [`MAX_LOG_BYTES`], not a
//!   regular file) is never rewritten: entries are appended to it, and clearing it is refused.
//!   A settings file that is not a JSON object is never replaced ([`DiskError::Unreadable`]),
//!   and a retention it names that this build does not know drops no entry for its age;
//! - reading either file holds a bounded multiple of its size cap, whatever it holds
//!   (`disk.rs`, `parse.rs`);
//! - rewrites are atomic and owner-only; the vault root and `.memry`'s parent are never
//!   created, so a vault that is away does not come back as an empty folder.
//!
//! Recording never blocks on the disk and never fails the caller: entries are buffered and
//! appended [`WRITE_DELAY`] after the first one, by the log's own thread; a failed write is
//! tried again [`RETRY_DELAY`] later. A change is told to subscribers at most once per
//! [`CHANGED_THROTTLE`], and at once when a log opens or closes.
//! [`ActivityLog::flush`] writes what is buffered now; the `flush-activity-log` shutdown step
//! and the vault close call it.

mod disk;
mod entry;
mod parse;
mod store;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use memry_core::storage::repositories::instants::to_iso8601;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use disk::write_retention;
pub use disk::{
    DEFAULT_RETENTION_DAYS, DiskError, LOG_FILE, MAX_LOG_BYTES, MAX_SETTINGS_BYTES, RETENTION_DAYS,
    SETTINGS_FILE, log_path, settings_path,
};
pub use entry::{
    ActivityEntry, ActivityInput, ActivityKind, ActivitySource, MAX_ITEMS, MAX_MESSAGE_UNITS,
};
pub use parse::{MAX_COUNTS, steps};
use parse::{Read, read_line};
use store::{Log, extension, is_user_content};

use crate::error::{CoreError, FailureKind};
use crate::shell::shutdown::StepFn;

/// Lines kept, whatever the retention window says (`MAX_ACTIVITY_ENTRIES`).
pub const MAX_ENTRIES: usize = 5000;
/// Growth past the cap before the file is compacted.
pub const COMPACT_SLACK: usize = 500;
pub const WRITE_DELAY: Duration = Duration::from_millis(250);
pub const CHANGED_THROTTLE: Duration = Duration::from_millis(500);
/// Wait before a failed write is tried again.
pub const RETRY_DELAY: Duration = Duration::from_secs(5);

/// `problems` lists skipped and failed entries, and summaries that count either.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename = "VaultActivityFilter", rename_all = "lowercase")]
pub enum ActivityFilter {
    All,
    Problems,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename = "VaultActivityList", rename_all = "camelCase")]
pub struct ActivityList {
    /// Newest first.
    pub entries: Vec<ActivityEntry>,
    pub retention_days: u32,
    /// `false` when no vault is open.
    pub available: bool,
}

impl ActivityList {
    /// What is listed while no vault is open.
    pub fn unavailable() -> Self {
        Self {
            entries: Vec::new(),
            retention_days: DEFAULT_RETENTION_DAYS,
            available: false,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ActivityError {
    #[error("{0} is not a retention period (7, 30 or 90 days)")]
    InvalidRetention(u32),
    /// The log file exists and could not be read when the vault opened.
    #[error("the activity log cannot be read, so it is left as it is")]
    Unreadable,
    #[error(transparent)]
    Disk(#[from] DiskError),
}

impl CoreError for ActivityError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::InvalidRetention(_) => (FailureKind::Invalid, "invalid_retention"),
            Self::Unreadable => (FailureKind::Storage, "activity_log_unreadable"),
            Self::Disk(DiskError::Unreadable { .. }) => {
                (FailureKind::Storage, "activity_settings_unreadable")
            }
            Self::Disk(DiskError::Write { .. }) => (FailureKind::Storage, "activity_write_failed"),
        }
    }
}

#[derive(Default)]
struct State {
    log: Option<Log>,
    generation: u64,
    write_due: Option<Instant>,
    changed_due: Option<Instant>,
    stop: bool,
}

type Clock = Box<dyn Fn() -> i64 + Send + Sync>;

struct Shared {
    state: Mutex<State>,
    /// Held across every write of the log or its settings, so writes reach the disk in the
    /// order their contents were taken. Recording takes only `state`, never this.
    io: Mutex<()>,
    wake: Condvar,
    changed: broadcast::Sender<()>,
    /// Epoch milliseconds.
    clock: Clock,
}

impl Shared {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn io(&self) -> MutexGuard<'_, ()> {
        self.io.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn schedule_write(&self, state: &mut State) {
        if state.write_due.is_none() {
            state.write_due = Some(Instant::now() + WRITE_DELAY);
            self.wake.notify_all();
        }
    }

    fn schedule_changed(&self, state: &mut State) {
        if state.changed_due.is_none() {
            state.changed_due = Some(Instant::now() + CHANGED_THROTTLE);
            self.wake.notify_all();
        }
    }

    fn write(&self) -> Result<(), DiskError> {
        let _io = self.io();
        let taken = {
            let mut state = self.state();
            state.write_due = None;
            state.log.as_mut().and_then(|log| {
                let work = log.take_work()?;
                Some((log.root.clone(), log.generation, work))
            })
        };
        let Some((root, generation, work)) = taken else {
            return Ok(());
        };
        let result = work.run(&root);
        let mut guard = self.state();
        let state = &mut *guard;
        if let Some(log) = state
            .log
            .as_mut()
            .filter(|log| log.generation == generation)
        {
            if result.is_ok() {
                log.wrote();
            } else {
                log.restore(work);
                state.write_due.get_or_insert(Instant::now() + RETRY_DELAY);
                self.wake.notify_all();
            }
        }
        result
    }

    /// The log's thread: runs the buffered write and the change notice when each is due.
    fn run_timers(&self) {
        // Told once per run of failures: a vault that is away fails every retry.
        let mut failing = false;
        let mut state = self.state();
        while !state.stop {
            let now = Instant::now();
            let write = state.write_due.is_some_and(|due| due <= now);
            let changed = state.changed_due.is_some_and(|due| due <= now);
            if write || changed {
                if changed {
                    state.changed_due = None;
                }
                drop(state);
                if write {
                    match self.write() {
                        Ok(()) => failing = false,
                        Err(error) if !failing => {
                            failing = true;
                            tracing::warn!(
                                scope = "vault_activity",
                                "the activity log was not written; it is tried again: {error}"
                            );
                        }
                        Err(_) => {}
                    }
                }
                if changed {
                    let _ = self.changed.send(());
                }
                state = self.state();
                continue;
            }
            state = match [state.write_due, state.changed_due]
                .into_iter()
                .flatten()
                .min()
            {
                Some(due) => {
                    self.wake
                        .wait_timeout(state, due - now)
                        .unwrap_or_else(|e| e.into_inner())
                        .0
                }
                None => self.wake.wait(state).unwrap_or_else(|e| e.into_inner()),
            };
        }
    }
}

/// The activity log of whichever vault is open. One per app; the vault tier opens and closes
/// it with the vault.
pub struct ActivityLog {
    shared: Arc<Shared>,
    timers: Option<JoinHandle<()>>,
}

fn system_clock() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

impl ActivityLog {
    pub fn new() -> Arc<Self> {
        Self::with_clock(system_clock)
    }

    /// A log that reads the time from `clock` (epoch milliseconds): entry times, retention
    /// and dedupe windows.
    pub fn with_clock(clock: impl Fn() -> i64 + Send + Sync + 'static) -> Arc<Self> {
        let shared = Arc::new(Shared {
            state: Mutex::default(),
            io: Mutex::default(),
            wake: Condvar::new(),
            changed: broadcast::channel(16).0,
            clock: Box::new(clock),
        });
        let thread = shared.clone();
        let timers = std::thread::Builder::new()
            .name("vault-activity".into())
            .spawn(move || thread.run_timers())
            .inspect_err(|error| {
                tracing::error!(
                    scope = "vault_activity",
                    "no activity log thread: entries reach the disk only on a flush or a close: {error}"
                );
            })
            .ok();
        Arc::new(Self { shared, timers })
    }

    /// One `()` per change of the entries, throttled; the renderer refetches.
    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.shared.changed.subscribe()
    }

    /// Loads the log of the vault at `root`: entries past the retention window or the cap are
    /// dropped, and the file is compacted shortly after. Closes the log of another vault first.
    pub fn open(&self, root: &Path) {
        let open = self.shared.state().log.as_ref().map(|log| log.root.clone());
        match open {
            Some(open) if open == root => return,
            Some(open) => self.close(&open),
            None => {}
        }
        let mut log = Log::load(root, (self.shared.clock)());
        let mut state = self.shared.state();
        state.generation += 1;
        log.generation = state.generation;
        let rewrite = log.needs_rewrite;
        state.log = Some(log);
        if rewrite {
            self.shared.schedule_write(&mut state);
        }
        drop(state);
        // At once, as a close is: the renderer lists this vault's entries.
        let _ = self.shared.changed.send(());
    }

    /// Writes what is buffered and lets the log of `root` go. A close of a vault that is not
    /// the open one (a late close hook of an earlier vault) does nothing.
    pub fn close(&self, root: &Path) {
        let _io = self.shared.io();
        let log = {
            let mut state = self.shared.state();
            if state.log.as_ref().is_none_or(|log| log.root != root) {
                return;
            }
            state.write_due = None;
            state.changed_due = None;
            state.log.take()
        };
        // At once rather than after the throttle, so the renderer stops showing its entries.
        let _ = self.shared.changed.send(());
        if let Some(mut log) = log
            && let Some(work) = log.take_work()
            && let Err(error) = work.run(&log.root)
        {
            tracing::warn!(
                scope = "vault_activity",
                "the activity log was not written at close: {error}"
            );
        }
    }

    /// Writes the buffered entries now.
    pub fn flush(&self) -> Result<(), DiskError> {
        self.shared.write()
    }

    /// Records one entry about the vault at `root`. Nothing happens while that vault is not the
    /// open one (a late report of a vault that closed), or for a repeat of a dedupe key inside
    /// its window; `false` then.
    pub fn record(&self, root: &Path, input: ActivityInput) -> bool {
        let mut state = self.shared.state();
        self.record_in(&mut state, root, input)
    }

    fn record_in(&self, state: &mut State, root: &Path, input: ActivityInput) -> bool {
        let now_ms = (self.shared.clock)();
        let Some(log) = state.log.as_mut().filter(|log| log.root == root) else {
            return false;
        };
        if let Some((key, window)) = &input.dedupe
            && !log.admit(key, *window, now_ms)
        {
            return false;
        }
        let at = to_iso8601(now_ms).unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned());
        let raw = input.to_line(&uuid::Uuid::new_v4().to_string(), &at);
        let Read::Line(parsed) = read_line(&raw) else {
            tracing::error!(
                scope = "vault_activity",
                "an entry was not recorded: its line does not read back"
            );
            return false;
        };
        log.push(parsed.into_line(raw));
        self.shared.schedule_write(state);
        self.shared.schedule_changed(state);
        true
    }

    /// Reports a file the vault does not index because of its type (`recordSkippedFile`): once
    /// per path while its entry is kept, and never a canvas or a lock or partial file an editor
    /// or a browser leaves beside a document.
    pub fn record_skipped(&self, root: &Path, path: &str, source: ActivitySource) -> bool {
        let path = path.replace('\\', "/");
        let mut state = self.shared.state();
        let Some(log) = state.log.as_mut().filter(|log| log.root == root) else {
            return false;
        };
        if log.reported_skips.contains(&path) || !is_user_content(&path) {
            return false;
        }
        log.reported_skips.insert(path.clone());
        let ext = extension(&path);
        let mut input = ActivityInput::new(ActivityKind::Skipped, source)
            .path(path)
            .reason("unsupported-type");
        if !ext.is_empty() {
            input = input.message(format!(".{ext}"));
        }
        self.record_in(&mut state, root, input)
    }

    pub fn list(&self, limit: usize, filter: ActivityFilter) -> ActivityList {
        let state = self.shared.state();
        let Some(log) = &state.log else {
            return ActivityList::unavailable();
        };
        let entries = log
            .lines
            .iter()
            .rev()
            .filter_map(|line| line.entry.as_ref())
            .filter(|entry| filter == ActivityFilter::All || entry.is_problem())
            .take(limit)
            .cloned()
            .collect();
        ActivityList {
            entries,
            retention_days: log.shown_retention(),
            available: true,
        }
    }

    /// Keeps `days` of entries from now on, written to the settings file first; entries
    /// already older go. Nothing happens while no vault is open.
    pub fn set_retention(&self, days: u32) -> Result<(), ActivityError> {
        if !RETENTION_DAYS.contains(&days) {
            return Err(ActivityError::InvalidRetention(days));
        }
        let Some(root) = self.shared.state().log.as_ref().map(|log| log.root.clone()) else {
            return Ok(());
        };
        let written = {
            let _io = self.shared.io();
            write_retention(&root, days)
        };
        written.map_err(|error| {
            tracing::warn!(
                scope = "vault_activity",
                "the retention was not saved: {error}"
            );
            error
        })?;
        let mut state = self.shared.state();
        let now_ms = (self.shared.clock)();
        let Some(log) = state.log.as_mut().filter(|log| log.root == root) else {
            return Ok(());
        };
        log.retention_days = Some(days);
        if log.prune(now_ms) {
            log.collect_skips();
            log.needs_rewrite = log.readable;
            self.shared.schedule_write(&mut state);
            self.shared.schedule_changed(&mut state);
        }
        Ok(())
    }

    /// Drops every entry, on disk too. Refused for a log file that could not be read.
    pub fn clear(&self) -> Result<(), ActivityError> {
        {
            let mut state = self.shared.state();
            let Some(log) = state.log.as_mut() else {
                return Ok(());
            };
            if !log.readable {
                return Err(ActivityError::Unreadable);
            }
            log.lines.clear();
            log.pending.clear();
            log.reported_skips.clear();
            log.recent_keys.clear();
            log.needs_rewrite = true;
            self.shared.schedule_changed(&mut state);
        }
        Ok(self.flush()?)
    }

    /// Writes the buffered entries and creates the file when it is not there, so revealing it
    /// shows a file. `None` when no vault is open.
    pub fn prepare_file(&self) -> Option<PathBuf> {
        let root = self.shared.state().log.as_ref()?.root.clone();
        if let Err(error) = self.flush() {
            tracing::warn!(
                scope = "vault_activity",
                "the activity log was not written: {error}"
            );
        }
        let _io = self.shared.io();
        if let Err(error) = disk::touch(&root) {
            tracing::warn!(
                scope = "vault_activity",
                "the activity log file was not created: {error}"
            );
        }
        Some(log_path(&root))
    }

    /// The `flush-activity-log` shutdown step. A failed write is logged, and the step succeeds:
    /// a failed step would end the sequence before the steps behind it.
    pub fn flush_step(self: &Arc<Self>) -> StepFn {
        let log = self.clone();
        Arc::new(move |_, _| {
            let log = log.clone();
            Box::pin(async move {
                tokio::task::spawn_blocking(move || {
                    if let Err(error) = log.flush() {
                        tracing::warn!(
                            scope = "vault_activity",
                            "the activity log was not written at quit: {error}"
                        );
                    }
                })
                .await
                .map_err(|error| error.to_string())
            })
        })
    }
}

impl Drop for ActivityLog {
    fn drop(&mut self) {
        self.shared.state().stop = true;
        self.shared.wake.notify_all();
        if let Some(timers) = self.timers.take() {
            let _ = timers.join();
        }
    }
}
