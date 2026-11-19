//! `SyncSupervisor`: one task per open vault that decides when the driver runs a pass, ported from
//! Electron's sync runtime (`engine.ts:868-890`, `sync-context.ts`, `runtime.ts`).
//!
//! One loop owns every decision: it starts the driver once the gate allows, runs at most one pass
//! at a time (a request during a pass queues exactly one trailing pass), spaces pushes 300 ms
//! apart, backs off after a `429` and runs a pass when the wait ends, pauses on clock skew, and
//! throttles status events. Passes run in a spawned task so the loop keeps answering; stop aborts
//! a running pass, as Electron's `abortController` does. Timing goes through `tokio::time`, so tests drive it on a paused clock.
//!
//! Once a driver is open it also holds the vault's realtime socket ([`super::realtime`]), whose
//! hints wake passes ([`super::frames`]). A revoked device, a refused session and a pin failure
//! latch sync off for the loop's life; other failures back off 5 s doubling to 5 min; an
//! unreadable keychain retries along its ladder and at once when the keychain recovers.

use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::storage::Db;
use memry_core::sync::outbox;
use memry_core::sync::socket::HintSink;
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use super::backend::SyncBackend;
use super::frames::FrameSink;
use super::gate::{self, GateDecision, SyncStartGate};
use super::result::{SyncNowBlockedReason as Blocked, TriggerSyncResult};
use super::run_loop::Loop;
use super::signals::{AuthSignal, AuthSignals, Signals};
use super::status::{self, StatusFacts, SyncStatus, SyncStatusValue};
use super::telemetry::BootstrapMetrics;
use super::triggers::Trigger;
use crate::shell::power::PowerEvent;
use crate::telemetry::Service;

/// What a supervisor is built from.
pub struct SupervisorParts {
    pub backend: Arc<dyn SyncBackend>,
    pub gate: Arc<SyncStartGate>,
    pub reachability: Arc<dyn Reachability>,
    /// Power events; a supervisor rebuilt on a vault switch subscribes again.
    pub power: Option<broadcast::Receiver<PowerEvent>>,
    /// Each time the keychain answers again after failing (`KeyringStore::subscribe_recovered`).
    pub keychain_recovered: Option<broadcast::Receiver<()>>,
    /// The vault's `data.db`: the persisted pause and the outbox depth.
    pub db: Db,
    /// The app's telemetry, which drops every event while telemetry is off.
    pub telemetry: Option<Arc<Service>>,
    /// The session's account signals, shared by every supervisor it builds.
    pub signals: AuthSignals,
    /// Every status change, at most one per [`STATUS_THROTTLE`], the latest winning.
    pub on_status: Arc<dyn Fn(&SyncStatus) + Send + Sync>,
}

/// How long [`SyncSupervisor::stop_blocking`] waits for the loop.
pub const STOP_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

pub(super) enum Command {
    Trigger(Trigger),
    RequestPush,
    SyncNow(oneshot::Sender<TriggerSyncResult>),
    SetPaused(bool, oneshot::Sender<Result<(), StorageError>>),
    Reachable(Reachable),
    Socket {
        generation: u64,
        connected: bool,
    },
    /// A socket hint: the engine's wake past this cursor.
    Wake(Option<i64>),
    /// The socket said this device is revoked.
    Revoked,
    Stop(oneshot::Sender<()>),
    FinalSnapshots(tokio::time::Instant, oneshot::Sender<()>),
}

/// The handle. Cheap to clone; the loop stops on [`SyncSupervisor::stop`] or when every handle
/// is dropped.
#[derive(Clone)]
pub struct SyncSupervisor {
    commands: mpsc::UnboundedSender<Command>,
    status: watch::Receiver<SyncStatus>,
    signals: Arc<Signals>,
    db: Db,
    bootstrap: Arc<BootstrapMetrics>,
    /// Fired before a stop waits: the socket and the pass end even while the loop is stuck.
    stopping: Arc<watch::Sender<bool>>,
}

impl SyncSupervisor {
    /// Starts the loop on `runtime`; its first step reads the persisted pause, before any
    /// request is handled.
    pub fn start(runtime: &tokio::runtime::Handle, parts: SupervisorParts) -> Self {
        let (commands, rx) = mpsc::unbounded_channel();
        // Weak: the reachability source keeps its observers for good, and must not keep the
        // loop alive once every handle is gone.
        parts
            .reachability
            .observe(Arc::new(Observer(commands.downgrade())));
        let online = parts.reachability.current() != Reachable::Offline;
        let first = status::derive(&StatusFacts {
            gate: GateDecision::NotStarted(gate::SyncNotStartedReason::Unavailable),
            paused: false,
            online,
            syncing: false,
            engine: None,
            last_error: None,
            last_sync_at: None,
            pending: 0,
            offline_since: None,
            keychain_unavailable: false,
        });
        let (status_tx, status) = watch::channel(first);
        let signals = Arc::new(Signals::new(parts.signals.clone()));
        let stopping = Arc::new(watch::Sender::new(false));
        let db = parts.db.clone();
        let bootstrap = Arc::new(BootstrapMetrics::new(parts.telemetry.clone()));
        let state = Loop::new(
            parts,
            rx,
            commands.downgrade(),
            Arc::clone(&signals),
            status_tx,
            stopping.subscribe(),
            online,
        );
        runtime.spawn(state.run());
        Self {
            commands,
            status,
            signals,
            db,
            bootstrap,
            stopping,
        }
    }

    /// The fresh-device bootstrap window of this vault.
    pub fn bootstrap(&self) -> &BootstrapMetrics {
        &self.bootstrap
    }

    /// Session expiry, revocation and linking requests, as sync learns them. The session-wide
    /// [`AuthSignals`] this supervisor was built with hears every rebuilt supervisor too.
    pub fn subscribe_auth_signals(&self) -> broadcast::Receiver<AuthSignal> {
        self.signals.subscribe()
    }

    /// How many passes have pulled since the loop started.
    pub fn completed_pulls(&self) -> u64 {
        self.signals.completed_pulls()
    }

    /// The gate answered for this vault: sync starts, or it does not for a reason the user
    /// settled (`isSyncDecided`).
    pub fn decided(&self) -> bool {
        self.signals.decided()
    }

    /// `isCaughtUpWithServer`: the last pass ended cleanly, and sync is neither paused nor
    /// offline now.
    pub fn caught_up(&self) -> bool {
        let now = self.status().status;
        self.signals.caught_up()
            && !matches!(now, SyncStatusValue::Paused | SyncStatusValue::Offline)
    }

    /// Waits until more than `after` passes have pulled; answers how many have.
    pub async fn wait_for_pull(&self, after: u64) -> u64 {
        self.signals.wait_for_pull(after).await
    }

    /// Outbox rows queued for item `item_id` (`synced_settings` is the settings item).
    pub async fn outbox_count(&self, item_id: &str) -> Result<usize, StorageError> {
        let db = self.db.clone();
        let item_id = item_id.to_owned();
        tokio::task::spawn_blocking(move || {
            db.read_blocking(move |conn| outbox::queued_for(conn, &item_id))
        })
        .await
        .map_err(|error| StorageError::Failed {
            what: format!("the outbox read task failed: {error}"),
        })?
    }

    /// Where the realtime socket's frames go; tests and e2e feed frames here too.
    pub fn hint_sink(&self) -> Arc<dyn HintSink> {
        Arc::new(FrameSink {
            commands: self.commands.downgrade(),
            signals: Arc::clone(&self.signals),
        })
    }

    /// A local write wants pushing: a pass at once, or when 300 ms have passed since the last
    /// one started (`push-coordinator.ts:585-609`).
    pub fn request_push(&self) {
        let _ = self.commands.send(Command::RequestPush);
    }

    /// The app came to the foreground.
    pub fn foreground(&self) {
        let _ = self.commands.send(Command::Trigger(Trigger::Foreground));
    }

    /// The realtime socket's state (L4b): a tick skips its pull while one generation stayed
    /// connected since the last tick.
    pub fn note_socket(&self, generation: u64, connected: bool) {
        let _ = self.commands.send(Command::Socket {
            generation,
            connected,
        });
    }

    /// Sync Now: ends a pause, then runs a pass and answers how it went.
    pub async fn sync_now(&self) -> TriggerSyncResult {
        let (reply, answer) = oneshot::channel();
        if self.commands.send(Command::SyncNow(reply)).is_err() {
            return TriggerSyncResult::blocked(Blocked::Unavailable, None);
        }
        answer
            .await
            .unwrap_or_else(|_| TriggerSyncResult::blocked(Blocked::Unavailable, None))
    }

    /// Pauses or resumes sync, persisted in `meta` `sync.paused` before the driver is told.
    pub async fn set_paused(&self, paused: bool) -> Result<(), StorageError> {
        let (reply, answer) = oneshot::channel();
        let gone = || StorageError::Failed {
            what: "sync is not running for this vault; the pause was not saved".into(),
        };
        if self
            .commands
            .send(Command::SetPaused(paused, reply))
            .is_err()
        {
            return Err(gone());
        }
        answer.await.unwrap_or_else(|_| Err(gone()))
    }

    /// Pushes every pending snapshot before `deadline` (shutdown); returns once done or cut.
    pub async fn final_snapshots(&self, deadline: tokio::time::Instant) {
        let (reply, done) = oneshot::channel();
        if self
            .commands
            .send(Command::FinalSnapshots(deadline, reply))
            .is_ok()
        {
            let _ = tokio::time::timeout_at(deadline, done).await;
        }
    }

    /// The latest status, unthrottled.
    pub fn status(&self) -> SyncStatus {
        self.status.borrow().clone()
    }

    /// Aborts a running pass, closes the driver and ends the loop.
    pub async fn stop(&self) {
        self.bootstrap.abandon();
        self.stopping.send_replace(true);
        let (reply, done) = oneshot::channel();
        if self.commands.send(Command::Stop(reply)).is_ok() {
            let _ = done.await;
        }
    }

    /// [`SyncSupervisor::stop`] from a thread outside the runtime (a session close hook), waiting
    /// at most [`STOP_WAIT`]: a loop held in a keychain prompt must not hold the close. Its socket
    /// and pass stop at once all the same. Answers whether the loop stopped in time; one that did
    /// not ends when it reads the request.
    pub fn stop_blocking(&self) -> bool {
        self.stop_blocking_within(STOP_WAIT)
    }

    pub(crate) fn stop_blocking_within(&self, wait: std::time::Duration) -> bool {
        self.bootstrap.abandon();
        self.stopping.send_replace(true);
        let (reply, mut done) = oneshot::channel();
        if self.commands.send(Command::Stop(reply)).is_err() {
            return true;
        }
        let deadline = std::time::Instant::now() + wait;
        loop {
            match done.try_recv() {
                Err(oneshot::error::TryRecvError::Empty)
                    if std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(oneshot::error::TryRecvError::Empty) => {
                    tracing::error!("sync did not stop in time; the close goes on without it");
                    return false;
                }
                _ => return true,
            }
        }
    }
}

struct Observer(mpsc::WeakUnboundedSender<Command>);

impl ReachabilityObserver for Observer {
    fn on_change(&self, reachable: Reachable) {
        if let Some(commands) = self.0.upgrade() {
            let _ = commands.send(Command::Reachable(reachable));
        }
    }
}

#[cfg(test)]
#[path = "supervisor_review_tests.rs"]
mod review_tests;
#[cfg(test)]
#[path = "supervisor_rig.rs"]
pub(crate) mod rig;
#[cfg(test)]
#[path = "supervisor_signal_tests.rs"]
mod signal_tests;
#[cfg(test)]
#[path = "supervisor_snapshot_tests.rs"]
mod snapshot_tests;
#[cfg(test)]
#[path = "supervisor_tests.rs"]
mod tests;
