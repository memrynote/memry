//! Hangs the watcher, the consumer and the write-back on the session: all start at
//! `OpenStage::Watcher` of every open and stop, joined, when the vault closes. The rows' lane
//! lives across sessions (the app holds it), and is open only while a vault is.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use memry_core::api::vault::Vault;
use memry_core::seams::secure_store::SecureStore;
use tokio::sync::broadcast;

use super::apply::Applier;
use super::identity::{DeferIdentity, IdentityCtx, NoteIdentity};
use super::rows::{RowOwner, RowSession};
use super::{AfterWalk, Applied, Consumer, QUEUE_CAPACITY, inbox};
use crate::session::{OpenStage, OpenVault, Session};
use crate::shell::shutdown::{StepFn, writeback_flush_timeout};
use crate::vault::activity::ActivityLog;
use crate::vault::config::read_vault_config;
use crate::vault::watch::{EchoGuard, NewFiles, VaultWatcher};
use crate::vault::writeback::{Pass, WriteBack, WriteBackFailed, reconcile};

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
    /// Where a test holds a stop or a start, each run once: [`VaultTier::hold_at`].
    #[cfg(test)]
    holds: Mutex<Vec<(Hold, HoldFn)>>,
}

#[cfg(test)]
type HoldFn = Box<dyn FnOnce() + Send>;

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
}

/// What one open of a vault owns. A stop works only on the handle it took when it began, and
/// clears what is shared (the slots above, the rows) only while that still is its own: a close
/// hook that ends after its deadline, or starts after it, runs while the next vault is open,
/// and must leave that vault's write-back, rows and own-write record alone.
struct Open {
    /// The vault this open belongs to: a close hook stops the open only if it is its vault's.
    vault: Arc<Vault>,
    session: RowSession,
    /// The own-write record of this open; a record made in one vault never hides a change in
    /// the next.
    echo: Arc<EchoGuard>,
    writeback: Arc<WriteBack>,
    /// Taken by the first stop; a second stop finds them gone.
    tasks: Mutex<Option<(VaultWatcher, Consumer)>>,
}

impl VaultTier {
    pub fn new(store: Arc<dyn SecureStore>) -> Arc<Self> {
        Arc::new(Self {
            store,
            rows: RowOwner::new(),
            activity: ActivityLog::new(),
            identity: Mutex::new(Arc::new(DeferIdentity)),
            failures: broadcast::channel(64).0,
            open: Mutex::new(None),
            echo: Mutex::new(None),
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

    /// Writes the note's body to its vault file, on the write-back thread
    /// ([`crate::vault::writeback`]). The editor (Step 14) calls it once a body edit is durable,
    /// the sync driver (Step 17) once a page committed. Nothing happens while no vault is open.
    pub fn schedule(&self, note_id: &str) {
        match self.current() {
            Some(open) => open.writeback.schedule(note_id),
            // The next open's reconcile writes it: its body moved after its row was stamped.
            None => tracing::warn!(
                scope = "vault_writeback",
                note_id,
                "no vault is open: the file is written on the next open"
            ),
        }
    }

    /// Every note whose file could not be updated from its body, once per run of failures.
    pub fn subscribe_failures(&self) -> broadcast::Receiver<WriteBackFailed> {
        self.failures.subscribe()
    }

    /// Runs every scheduled write-back of the open vault now and waits, at most `timeout`, for
    /// them. True when none is left; also when no vault is open.
    pub fn flush(&self, timeout: Duration) -> bool {
        self.current()
            .is_none_or(|open| open.writeback.flush(timeout))
    }

    /// The `flush-writebacks` shutdown step: the scheduled write-backs run within
    /// [`writeback_flush_timeout`] of what is left, so the steps behind keep their share. Passes
    /// still left then run in the vault close (`close-vault`), bounded only by the sequence
    /// budget; the step itself succeeds, since a failed step would end the sequence before
    /// that close.
    pub fn flush_step(self: &Arc<Self>) -> StepFn {
        let tier = self.clone();
        Arc::new(move |_, deadline| {
            let tier = tier.clone();
            Box::pin(async move {
                let timeout = writeback_flush_timeout(deadline.remaining());
                tokio::task::spawn_blocking(move || tier.flush(timeout))
                    .await
                    .map(drop)
                    .map_err(|error| error.to_string())
            })
        })
    }

    /// The identity of the next open on ([`DeferIdentity`] until one is set; the app sets the
    /// notes identity, `crate::notes::identity`).
    pub fn set_identity(&self, identity: Arc<dyn NoteIdentity>) {
        *self.identity.lock().unwrap_or_else(|e| e.into_inner()) = identity;
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
            .filter(|open| of.is_none_or(|vault| Arc::ptr_eq(&open.vault, vault)))
        else {
            return;
        };
        let tasks = open.tasks.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some((watcher, mut consumer)) = tasks {
            watcher.stop_and_drop();
            consumer.stop();
            #[cfg(test)]
            self.hold(Hold::ConsumerStopped);
        }
        open.writeback.stop();
        clear_if_held(&self.open, &open);
        clear_if_held(&self.echo, &open.echo);
        self.rows.close_session(open.session);
    }

    fn start(&self, vault: &OpenVault) -> Result<Open, String> {
        let session = self
            .rows
            .open(vault.vault.clone())
            .map_err(|error| error.to_string())?;
        let echo = Arc::<EchoGuard>::default();
        *lock(&self.echo) = Some(echo.clone());
        self.start_in(vault, session, echo.clone())
            .inspect_err(|_| {
                clear_if_held(&self.echo, &echo);
                self.rows.close_session(session);
            })
    }

    fn start_in(
        &self,
        vault: &OpenVault,
        session: RowSession,
        echo: Arc<EchoGuard>,
    ) -> Result<Open, String> {
        let exclude = read_vault_config(&vault.path).exclude_patterns;
        let identity = self
            .identity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        identity.opened(&IdentityCtx {
            root: &vault.path,
            vault: &vault.vault,
        });
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
        let pass = Arc::new(Pass::new(
            vault.path.clone(),
            vault.vault.clone(),
            self.rows.clone(),
            session,
            echo.clone(),
            vault.vault.app_settings(self.store.clone()).ok(),
        ));
        let writeback = WriteBack::start(pass.clone(), self.failures.clone())
            .map(Arc::new)
            .map_err(|error| error.to_string())?;
        let applier = Applier {
            root: vault.path.clone(),
            vault: vault.vault.clone(),
            rows: self.rows.clone(),
            session,
            identity,
            feed,
            settings: vault.vault.app_settings(self.store.clone()).ok(),
            activity: self.activity.clone(),
        };
        let after_walk: AfterWalk = {
            let writeback = writeback.clone();
            Box::new(move |stopped| reconcile(&pass, &writeback, stopped))
        };
        let consumer = Consumer::start(applier, inbox, watcher.handle(), exclude, after_walk)
            .map_err(|error| error.to_string())?;
        Ok(Open {
            vault: vault.vault.clone(),
            session,
            echo,
            writeback,
            tasks: Mutex::new(Some((watcher, consumer))),
        })
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
        let then = {
            let mut holds = self.holds.lock().unwrap_or_else(|e| e.into_inner());
            holds
                .iter()
                .position(|(point, _)| *point == at)
                .map(|i| holds.remove(i).1)
        };
        if let Some(then) = then {
            then();
        }
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
