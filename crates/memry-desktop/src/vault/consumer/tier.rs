//! Hangs the watcher, the consumer and the write-back on the session: all start at
//! `OpenStage::Watcher` of every open and stop, joined, when the vault closes. New exclude
//! patterns restart the watcher and the consumer alone ([`VaultTier::rewatch`]). The rows' lane
//! lives across sessions (the app holds it), and is open only while a vault is.

use std::sync::{Arc, Mutex, MutexGuard, Weak};

use memry_core::api::vault::Vault;
use memry_core::seams::secure_store::SecureStore;
use tokio::sync::broadcast;

use super::apply::Applier;
use super::identity::{DeferIdentity, IdentityCtx, NoteIdentity};
use super::rows::{RowOwner, RowSession};
use super::{AfterWalk, Applied, Consumer, QUEUE_CAPACITY, inbox};
use crate::editor::EditorHost;
use crate::journal::folder_follow::follow_after_batch;
use crate::session::{OpenStage, OpenVault, Session};
use crate::vault::activity::ActivityLog;
use crate::vault::app_edit::OwnFiles;
use crate::vault::app_move::{finish_interrupted, follow_interrupted};
use crate::vault::config::applied_exclude_patterns;
use crate::vault::config::settings::JournalFollow;
use crate::vault::journal_rename::{JournalVault, finish_journal_change};
#[cfg(test)]
use crate::vault::watch::HoldFn;
use crate::vault::watch::filter::WatchFilter;
use crate::vault::watch::{EchoGuard, NewFiles, VaultWatcher, WatchHandle};
use crate::vault::writeback::{Pass, WriteBack, WriteBackFailed};

mod writeback;

use writeback::after_walk;

pub struct VaultTier {
    /// Holds the device key the feed writes under.
    store: Arc<dyn SecureStore>,
    rows: Arc<RowOwner>,
    /// Open with the vault, whether or not its watcher starts; the consumer records what the
    /// watcher reports into it.
    activity: Arc<ActivityLog>,
    identity: Mutex<Arc<dyn NoteIdentity>>,
    /// Every session's failed write-backs, for the notice.
    failures: broadcast::Sender<WriteBackFailed>,
    /// The open vault's handles. A close stops the watcher and the consumer first and leaves
    /// the handle here, so an edit scheduled meanwhile still reaches the write-back, which runs
    /// it before the close ends.
    open: Mutex<Option<Arc<Open>>>,
    /// The open's own-write record, published before its watcher starts, so a file the app
    /// writes while the vault opens is not reported back as an outside edit.
    echo: Mutex<Option<Arc<EchoGuard>>>,
    /// The text the app wrote for each note in the open vault, for its saves and for the
    /// consumer, which reports the watcher's read of those bytes as their writer's. Cleared as
    /// a vault opens: a day's id is the same in every vault.
    own_files: Arc<OwnFiles>,
    /// The editor the windows type in, which holds their typing while an outside edit of a
    /// note they have open is applied; unset in a test that serves no windows.
    editor: Mutex<Weak<EditorHost>>,
    /// Where a test holds a stop or a start, each run once: [`VaultTier::hold_at`].
    #[cfg(test)]
    holds: Mutex<Vec<(Hold, HoldFn)>>,
}

/// A point in a stop or a start where a test runs its closure.
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Hold {
    /// A stop, before it reads which open the tier holds.
    SlotRead,
    /// A stop, right after it stopped a consumer.
    ConsumerStopped,
    /// A start, right before its watcher starts.
    WatcherStart,
    /// A stop, right before it clears the slots.
    StopClears,
    /// The stop of the OS watch a start sets up, on the thread that stops it, right before it
    /// stops.
    OsWatchStop,
}

/// What one open of a vault owns. A stop works only on the handle it took when it began, and
/// clears what is shared (the slots above, the rows) only while that still is its own: a close
/// hook that ends after its deadline, or starts after it, runs while the next vault is open,
/// and must leave that vault's write-back, rows and own-write record alone.
struct Open {
    /// The vault this open belongs to: a close hook stops the open only if it is its vault's.
    view: OpenVault,
    session: RowSession,
    /// The own-write record of this open; a record made in one vault never hides a change in
    /// the next.
    echo: Arc<EchoGuard>,
    writeback: Arc<WriteBack>,
    /// The write-back's pass, for the reconcile that ends each walk.
    pass: Arc<Pass>,
    /// What the app asks of this open's watcher, the one a restart started last.
    watch: Mutex<WatchHandle>,
    /// Held by a restart from its stop to its start, so a close waits for it and stops what it
    /// started.
    tasks: Mutex<Tasks>,
}

enum Tasks {
    Running(VaultWatcher, Consumer),
    /// A restart stopped them and could not start them again; the next restart tries.
    Unwatched,
    /// Stopped for good, by the first stop; a second stop or a restart finds nothing to do.
    Stopped,
}

impl Open {
    fn watch(&self) -> WatchHandle {
        lock(&self.watch).clone()
    }
}

impl VaultTier {
    /// The store holding the device key the tier writes under.
    pub fn store(&self) -> Arc<dyn SecureStore> {
        self.store.clone()
    }

    pub fn new(store: Arc<dyn SecureStore>) -> Arc<Self> {
        Arc::new(Self {
            store,
            rows: RowOwner::new(),
            activity: ActivityLog::new(),
            identity: Mutex::new(Arc::new(DeferIdentity)),
            failures: broadcast::channel(64).0,
            open: Mutex::new(None),
            echo: Mutex::new(None),
            own_files: Arc::default(),
            editor: Mutex::new(Weak::new()),
            #[cfg(test)]
            holds: Mutex::default(),
        })
    }

    /// The record every writer tells before it changes a vault file, so the watcher does not
    /// report the write back as an outside edit. It belongs to the open vault session: a record
    /// made in one vault must never hide a change in the next, so a writer asks again for each
    /// write instead of keeping the handle.
    pub fn echo(&self) -> Arc<EchoGuard> {
        lock(&self.echo).clone().unwrap_or_default()
    }

    /// What the app wrote for each note this run ([`OwnFiles`]).
    pub fn own_files(&self) -> Arc<OwnFiles> {
        self.own_files.clone()
    }

    /// The open vault's watcher looks at the disk again, as when the OS lost events
    /// (`forget = false`) or the consumer dropped them (`forget = true`, which forgets what was
    /// reported), so a test can put the watcher's rescans on any state it builds.
    #[cfg(feature = "test-hooks")]
    #[doc(hidden)]
    pub fn rescan_watcher(&self, forget: bool) {
        if let Some(open) = self.current() {
            match forget {
                true => open.watch().resync(),
                false => open.watch().rescan(),
            }
        }
    }

    fn current(&self) -> Option<Arc<Open>> {
        self.slot().clone()
    }

    fn slot(&self) -> MutexGuard<'_, Option<Arc<Open>>> {
        lock(&self.open)
    }

    /// The activity log of the open vault.
    pub fn activity(&self) -> Arc<ActivityLog> {
        self.activity.clone()
    }

    /// The lane the app's own file operations write their rows through.
    pub fn rows(&self) -> Arc<RowOwner> {
        self.rows.clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Applied> {
        self.rows.subscribe()
    }

    /// A create reserved `rel` for its note, found a file there that it did not write, and took
    /// the reservation back. The watcher may have looked at the file meanwhile: under the row it
    /// saw a change of the reserved note, which no row names now, and under the own-write record
    /// the create's bytes. Either way it would not report the file again, so it forgets what it
    /// saw and looks once more, and the file becomes a note of its own. Nothing when `session`
    /// is not the open one.
    pub(crate) fn not_written(&self, session: RowSession, rel: &str) {
        if let Some(open) = self.current().filter(|open| open.session == session) {
            open.watch().rehome(rel.to_owned());
        }
    }

    /// The identity of the next open on ([`DeferIdentity`] until one is set; the app sets the
    /// notes identity, `crate::notes::identity`).
    pub fn set_identity(&self, identity: Arc<dyn NoteIdentity>) {
        *self.identity.lock().unwrap_or_else(|e| e.into_inner()) = identity;
    }

    /// The editor whose windows hold their typing while an outside edit of their note applies
    /// (`crate::editor::typing`), from the next open on.
    pub fn set_editor_host(&self, editor: &Arc<EditorHost>) {
        *self.editor.lock().unwrap_or_else(|e| e.into_inner()) = Arc::downgrade(editor);
    }

    /// The identity set last, which the app's own file moves ask too.
    pub(crate) fn identity(&self) -> Arc<dyn NoteIdentity> {
        self.identity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Stops the open the tier holds now. Joined outside the locks: each waits for its
    /// current step. The watcher first, so no fact reaches a consumer that is stopping. The
    /// write-back last and still reachable, so it runs what was scheduled until it stopped,
    /// while its rows are still open.
    ///
    /// `of` names the vault a close hook closes: the hook runs on its own thread and may read
    /// the slot only after the next vault opened, whose open it must leave alone. An open
    /// stops whatever is open (`None`).
    fn stop(&self, of: Option<&Arc<Vault>>) {
        #[cfg(test)]
        self.hold(Hold::SlotRead);
        let Some(open) = self
            .current()
            .filter(|open| of.is_none_or(|vault| Arc::ptr_eq(&open.view.vault, vault)))
        else {
            return;
        };
        // Waits for a restart under way, then stops what it started.
        let tasks = std::mem::replace(&mut *lock(&open.tasks), Tasks::Stopped);
        if let Tasks::Running(watcher, mut consumer) = tasks {
            watcher.stop_and_drop();
            consumer.stop();
            #[cfg(test)]
            self.hold(Hold::ConsumerStopped);
        }
        open.writeback.stop();
        #[cfg(test)]
        self.hold(Hold::StopClears);
        clear_if_held(&self.open, &open);
        clear_if_held(&self.echo, &open.echo);
        self.rows.close_session(open.session);
    }

    fn start(&self, vault: &OpenVault) -> Result<Open, String> {
        let session = self
            .rows
            .open(vault.vault.clone())
            .map_err(|error| error.to_string())?;
        self.own_files.clear();
        let echo = Arc::<EchoGuard>::default();
        *lock(&self.echo) = Some(echo.clone());
        self.start_in(vault, session, echo.clone())
            .inspect_err(|_| {
                clear_if_held(&self.echo, &echo);
                self.rows.close_session(session);
            })
    }

    /// Restarts the watcher and the consumer of `vault`'s open on the exclude patterns saved now
    /// (`updateConfig`'s watcher restart), so a folder a pattern now drops is no longer read and
    /// one it no longer drops is. The new watcher's start rescan and the consumer's walk read the
    /// vault again under them; a row whose file a pattern drops stays (the rescan keeps the
    /// homes the patterns ignore). The rows' session, the own-write record and the write-back
    /// keep running, so the app's writes go on meanwhile, and the walk ends with the
    /// write-back's reconcile again: a restart during the open walk stopped that walk's.
    ///
    /// The tasks stay locked from the stop to the start, so a close meanwhile waits and stops
    /// what this started, and returns only once they stopped. (The open's `Drop` stops a pair
    /// that outlives its close as well, later: the lock is the ordering.) A start that fails leaves the open unwatched and is reported; the next
    /// restart tries again. Nothing when `vault` is not the open one, or a close stopped it.
    /// `unwatched` runs between the stop and the start.
    pub(crate) fn rewatch(
        &self,
        vault: &Arc<Vault>,
        unwatched: &mut dyn FnMut(),
    ) -> Result<(), String> {
        let Some(open) = self
            .current()
            .filter(|open| Arc::ptr_eq(&open.view.vault, vault))
        else {
            return Ok(());
        };
        let mut tasks = lock(&open.tasks);
        match std::mem::replace(&mut *tasks, Tasks::Unwatched) {
            Tasks::Stopped => {
                *tasks = Tasks::Stopped;
                return Ok(());
            }
            Tasks::Running(watcher, mut consumer) => {
                watcher.stop_and_drop();
                consumer.stop();
            }
            Tasks::Unwatched => {}
        }
        unwatched();
        let after_walk = after_walk(&open.pass, &open.writeback);
        let owned = (&open.echo, &open.writeback);
        let (watcher, consumer) = self.watch(&open.view, open.session, owned, after_walk)?;
        *lock(&open.watch) = watcher.handle();
        *tasks = Tasks::Running(watcher, consumer);
        Ok(())
    }

    fn start_in(
        &self,
        vault: &OpenVault,
        session: RowSession,
        echo: Arc<EchoGuard>,
    ) -> Result<Open, String> {
        let identity = self.identity();
        let ctx = IdentityCtx {
            root: &vault.path,
            vault: &vault.vault,
            search: &vault.search,
        };
        // Before the identity settles what it owes, and before the watcher: the file an app
        // move left at its new path is the note's again, never a new file.
        let settled = vault
            .vault
            .notes_writer(self.store.clone())
            .map_err(|error| error.to_string())
            .and_then(|writer| {
                // Before the lane (`settings`'s lock order). A journal setting change a crash
                // cut short puts its days back first: the folder moves settle under the setting
                // it leaves saved.
                let at = JournalVault {
                    root: &vault.path,
                    vault: &vault.vault,
                    tier: self,
                };
                finish_journal_change(at, &JournalFollow::hold());
                follow_interrupted(&vault.path, &writer);
                follow_after_batch(&vault.path, &writer, identity.notices().as_deref());
                let mut lane = self
                    .rows
                    .lane_of(session)
                    .map_err(|error| error.to_string())?;
                finish_interrupted(&ctx, &writer, &mut lane, &*identity);
                Ok(())
            });
        if let Err(error) = settled {
            tracing::warn!(
                scope = "vault_consumer",
                "the interrupted app moves wait for the next open: {error}"
            );
        }
        identity.opened(&ctx);
        // Before the watcher: the write-back runs only what is scheduled, and nothing can be
        // until the open is in the slot.
        let pass = Arc::new(Pass::new(
            vault.path.clone(),
            vault.vault.clone(),
            self.rows.clone(),
            session,
            echo.clone(),
            vault.vault.app_settings(self.store.clone()).ok(),
            self.own_files.clone(),
        ));
        let writeback = WriteBack::start(pass.clone(), self.failures.clone())
            .map(Arc::new)
            .map_err(|error| error.to_string())?;
        let tasks = self.watch(
            vault,
            session,
            (&echo, &writeback),
            after_walk(&pass, &writeback),
        )?;
        Ok(Open {
            view: vault.clone(),
            session,
            echo,
            writeback,
            pass,
            watch: Mutex::new(tasks.0.handle()),
            tasks: Mutex::new(Tasks::Running(tasks.0, tasks.1)),
        })
    }

    /// The watcher and the consumer of an open, on the exclude patterns saved now.
    fn watch(
        &self,
        vault: &OpenVault,
        session: RowSession,
        (echo, writeback): (&Arc<EchoGuard>, &Arc<WriteBack>),
        after_walk: AfterWalk,
    ) -> Result<(VaultWatcher, Consumer), String> {
        let exclude = applied_exclude_patterns(&vault.path, &vault.vault);
        // The files an exclude pattern covers are the ones no write of the app reaches
        // (`ExcludedPaths`): the note stays listed, read-only, as Electron's index drops it.
        // Hidden names and the root attachments folder the watcher skips too stay writable: the
        // app writes there itself (a `.journal` journal folder).
        let filter = WatchFilter::new(exclude.clone());
        vault
            .vault
            .excluded()
            .set(move |path| filter.excludes(path));
        let identity = self.identity();
        let new_files = if identity.adopts() {
            NewFiles::Report
        } else {
            NewFiles::PairOnly
        };
        let (sink, inbox) = inbox(QUEUE_CAPACITY);
        #[cfg(test)]
        self.hold(Hold::WatcherStart);
        let watcher = VaultWatcher::start(
            vault.path.clone(),
            exclude.clone(),
            vault.vault.note_files(),
            echo.clone(),
            sink,
            new_files,
        )
        .map_err(|error| error.to_string())?;
        #[cfg(test)]
        if let Some(then) = self.take_hold(Hold::OsWatchStop) {
            watcher.hold_os_stop(then);
        }
        let feed = vault
            .vault
            .external_feed(self.store.clone())
            .inspect_err(|error| {
                tracing::warn!(
                    scope = "vault_consumer",
                    "no file's text can reach a note in this session: {error}"
                );
            })
            .ok();
        let applier = Applier {
            root: vault.path.clone(),
            vault: vault.vault.clone(),
            search: vault.search.clone(),
            rows: self.rows.clone(),
            session,
            identity,
            feed,
            settings: vault.vault.app_settings(self.store.clone()).ok(),
            activity: self.activity.clone(),
            own_files: self.own_files.clone(),
            editor: self
                .editor
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            watch: Some(watcher.handle()),
            filter: WatchFilter::new(exclude.clone()),
            untaken: Mutex::default(),
            writeback: Some(writeback.clone()),
        };
        let consumer = Consumer::start(applier, inbox, watcher.handle(), exclude, after_walk)
            .map_err(|error| error.to_string())?;
        Ok((watcher, consumer))
    }

    /// Runs `then` once, the next time a stop or a start reaches `at`.
    #[cfg(test)]
    pub(crate) fn hold_at(&self, at: Hold, then: impl FnOnce() + Send + 'static) {
        self.holds
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((at, Box::new(then)));
    }

    #[cfg(test)]
    fn hold(&self, at: Hold) {
        if let Some(then) = self.take_hold(at) {
            then();
        }
    }

    #[cfg(test)]
    fn take_hold(&self, at: Hold) -> Option<HoldFn> {
        let mut holds = self.holds.lock().unwrap_or_else(|e| e.into_inner());
        holds
            .iter()
            .position(|(point, _)| *point == at)
            .map(|i| holds.remove(i).1)
    }

    /// Registers the open and close hooks. A watcher that cannot start fails its hook, which
    /// the session reports and survives: the vault opens without file watching, with its
    /// activity log open.
    pub fn register(self: &Arc<Self>, session: &Session) {
        let tier = self.clone();
        session.on_open(
            "vault-watcher",
            OpenStage::Watcher,
            Arc::new(move |vault| {
                tier.stop(None);
                tier.activity.open(&vault.path);
                let open = tier.start(vault)?;
                *tier.slot() = Some(Arc::new(open));
                Ok(())
            }),
        );
        let tier = self.clone();
        // After the watcher and the consumer stop, so nothing records into a closed log. A late
        // close of an earlier vault leaves the open one's log alone: its path differs, and the
        // session reopens no vault a close hook still holds.
        session.on_close(
            "vault-watcher",
            Arc::new(move |view| {
                tier.stop(Some(&view.vault));
                tier.activity.close(&view.path);
            }),
        );
    }
}

fn lock<T>(slot: &Mutex<T>) -> MutexGuard<'_, T> {
    slot.lock().unwrap_or_else(|e| e.into_inner())
}

/// Empties `slot` if it still holds `held`; a later open's handle stays.
fn clear_if_held<T>(slot: &Mutex<Option<Arc<T>>>, held: &Arc<T>) {
    let mut slot = lock(slot);
    if slot
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, held))
    {
        *slot = None;
    }
}
