//! The seams the supervisor runs through: [`SyncBackend`] opens a driver for the open vault, and
//! [`SyncPasses`] is the driver as the supervisor uses it. `SyncDriver` and [`VaultSyncBackend`]
//! are the real ones; tests put fakes behind both.

use std::sync::{Arc, Mutex};

use memry_core::api::auth::AuthSession;
use memry_core::api::errors::SyncError;
use memry_core::api::vault::Vault;
use memry_core::seams::reachability::Reachability;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::sync::driver::progress::InitialSyncSink;
use memry_core::sync::driver::{ApplyObserver, DriverConfig, SyncDriver};
use memry_core::sync::engine::{PassReport, PassSeed};
use memry_core::sync::policy::ServerClock;
use memry_core::sync::socket::HintSink;
use memry_core::sync::socket_run::TerminalLatch;
use memry_core::sync::state::PassTrigger;
use zeroize::Zeroizing;

use crate::session::at_rest_key::{AtRestKeyGuard, AtRestKeys};

use super::gate::AuthFacts;
use super::realtime::{CoreSocket, PinWatch, RealtimeSocket};

#[async_trait::async_trait]
pub trait SyncPasses: Send + Sync {
    /// One pass; `None` while paused.
    async fn run_pass(&self, trigger: PassTrigger) -> Option<PassReport>;
    /// A socket hint's pass; `None` while paused or when the hint was dropped.
    async fn wake(&self, cursor: Option<i64>) -> Option<PassReport>;
    /// Whether this vault has not finished a first sync on this device.
    async fn needs_first_sync(&self) -> Result<bool, SyncError>;
    /// The first sync, its progress told to `progress`, then passes to the feed head. Answers
    /// the last pass, with the rows every pass pushed; `None` while paused.
    async fn first_sync(
        &self,
        progress: Arc<dyn InitialSyncSink>,
    ) -> Result<Option<PassReport>, SyncError>;
    /// The vault's realtime socket: hints to `sink`, `on_connected` at each open, terminal
    /// closes latched in `latch`.
    fn realtime(
        &self,
        sink: Arc<dyn HintSink>,
        latch: Arc<TerminalLatch>,
        on_connected: Arc<dyn Fn() + Send + Sync>,
    ) -> Arc<dyn RealtimeSocket>;
    fn pause(&self);
    fn resume(&self);
    fn set_entitled(&self, entitled: bool);
    fn server_clock(&self) -> Option<ServerClock>;
    /// Whether a requested snapshot is due (chapter 07 §7.13.3).
    fn snapshots_due(&self, _now_ms: i64) -> bool {
        false
    }
    /// Pushes the due snapshots, under the pass gate; run at the end of each pass.
    async fn push_due_snapshots(&self, _now_ms: i64) {}
    /// Shutdown: every pending snapshot, batch by batch until `deadline`.
    async fn final_snapshots(&self, _deadline: tokio::time::Instant) {}
}

#[async_trait::async_trait]
impl SyncPasses for SyncDriver {
    async fn run_pass(&self, trigger: PassTrigger) -> Option<PassReport> {
        SyncDriver::run_pass(self, trigger).await
    }
    async fn wake(&self, cursor: Option<i64>) -> Option<PassReport> {
        SyncDriver::wake(self, cursor).await
    }
    async fn needs_first_sync(&self) -> Result<bool, SyncError> {
        SyncDriver::needs_first_sync(self).await
    }
    async fn first_sync(
        &self,
        progress: Arc<dyn InitialSyncSink>,
    ) -> Result<Option<PassReport>, SyncError> {
        Ok(SyncDriver::first_sync(self, progress)
            .await?
            .and_then(|outcome| last_with_every_push(outcome.passes)))
    }
    fn realtime(
        &self,
        sink: Arc<dyn HintSink>,
        latch: Arc<TerminalLatch>,
        on_connected: Arc<dyn Fn() + Send + Sync>,
    ) -> Arc<dyn RealtimeSocket> {
        let watch = PinWatch::new(self.transport());
        let client = self.realtime_client(Arc::clone(&watch) as _, sink);
        Arc::new(CoreSocket::new(
            client,
            self.token_provider(),
            &watch,
            latch,
            on_connected,
        ))
    }
    fn pause(&self) {
        SyncDriver::pause(self);
    }
    fn resume(&self) {
        SyncDriver::resume(self);
    }
    fn set_entitled(&self, entitled: bool) {
        SyncDriver::set_entitled(self, entitled);
    }
    fn server_clock(&self) -> Option<ServerClock> {
        SyncDriver::server_clock(self)
    }
    fn snapshots_due(&self, now_ms: i64) -> bool {
        SyncDriver::snapshots_due(self, now_ms)
    }
    async fn push_due_snapshots(&self, now_ms: i64) {
        let round = SyncDriver::push_due_snapshots(self, now_ms).await;
        if round != Default::default() {
            tracing::debug!(?round, "snapshot round");
        }
    }
    async fn final_snapshots(&self, deadline: tokio::time::Instant) {
        let round = SyncDriver::final_snapshots(self, deadline).await;
        tracing::info!(?round, "final snapshot push");
    }
}

/// The first sync's last catch-up pass, with the rows and push time of all of them: Electron's
/// full sync pushes once and tells queue-cleared with every row it sent
/// (`full-sync-runner.ts:453`).
pub(super) fn last_with_every_push(passes: Vec<PassReport>) -> Option<PassReport> {
    let pushed_items = passes.iter().map(|pass| pass.pushed_items).sum();
    let push_ms = passes.iter().map(|pass| pass.push_ms).sum();
    passes.into_iter().last().map(|mut last| {
        last.pushed |= pushed_items > 0;
        last.pushed_items = pushed_items;
        last.push_ms = push_ms;
        last
    })
}

#[async_trait::async_trait]
pub trait SyncBackend: Send + Sync {
    /// The account side of the gate, read at each start attempt.
    async fn auth_facts(&self) -> AuthFacts;
    /// A driver for the open vault, which `observers` hear from its open on. Fails offline (it
    /// fetches the device directory) and on a vault bound to no server vault; the supervisor
    /// retries on the next trigger.
    async fn open(
        &self,
        observers: Vec<Arc<dyn ApplyObserver>>,
    ) -> Result<Arc<dyn SyncPasses>, SyncError>;
    /// The server refused the session's refresh token for good. Answered from the session's
    /// tokens, so a refused refresh during [`SyncBackend::open`] counts too.
    fn refresh_refused(&self) -> bool;
    /// The driver was dropped, or never kept: release sync's hold on the at-rest key.
    fn close(&self);
}

/// The open vault's backend over the app's session and keychain.
pub struct VaultSyncBackend {
    vault: Arc<Vault>,
    session: Arc<AuthSession>,
    store: Arc<dyn SecureStore>,
    reachability: Arc<dyn Reachability>,
    seeds: Vec<Arc<dyn PassSeed>>,
    account: Arc<dyn Fn() -> (bool, bool) + Send + Sync>,
    /// Heard by every driver this backend opens, after the supervisor's own.
    observers: Vec<Arc<dyn ApplyObserver>>,
    keys: Arc<AtRestKeys>,
    /// Sync's hold on the at-rest key while a driver is open.
    guard: Arc<Mutex<Option<AtRestKeyGuard>>>,
    /// Bumped by each close, under this lock: a key hold that a close overtook (the pass was
    /// aborted, its blocking acquire was not) is released at once.
    closes: Arc<Mutex<u64>>,
}

impl VaultSyncBackend {
    /// `account` answers signed in and `sync.recoveryPhraseConfirmed != false`, from the account
    /// service.
    pub fn new(
        vault: Arc<Vault>,
        session: Arc<AuthSession>,
        store: Arc<dyn SecureStore>,
        reachability: Arc<dyn Reachability>,
        seeds: Vec<Arc<dyn PassSeed>>,
        account: Arc<dyn Fn() -> (bool, bool) + Send + Sync>,
        keys: Arc<AtRestKeys>,
    ) -> Self {
        Self {
            vault,
            session,
            store,
            reachability,
            seeds,
            account,
            observers: Vec::new(),
            keys,
            guard: Arc::default(),
            closes: Arc::default(),
        }
    }

    /// Adds `observer` to every driver this backend opens (`sync::disk`).
    pub fn with_observer(mut self, observer: Arc<dyn ApplyObserver>) -> Self {
        self.observers.push(observer);
        self
    }
}

/// The account facts the gate reads, with the master key read from `store` (blocking). The key it
/// hands back is zeroed on drop.
pub fn read_auth_facts(
    signed_in: bool,
    recovery_confirmed: bool,
    store: &dyn SecureStore,
) -> AuthFacts {
    let key = store
        .get(SecureStoreKey::MasterKey)
        .map(|key| key.map(Zeroizing::new).is_some());
    AuthFacts {
        signed_in,
        key_verified: matches!(key, Ok(true)),
        recovery_confirmed,
        // Locked, denied or failed: the key may be there, the keychain did not answer.
        keychain_unavailable: key.is_err(),
    }
}

#[async_trait::async_trait]
impl SyncBackend for VaultSyncBackend {
    async fn auth_facts(&self) -> AuthFacts {
        let (signed_in, recovery_confirmed) = (self.account)();
        // The keychain can block on an access prompt: off the async workers.
        let store = Arc::clone(&self.store);
        tokio::task::spawn_blocking(move || {
            read_auth_facts(signed_in, recovery_confirmed, store.as_ref())
        })
        .await
        .unwrap_or(AuthFacts {
            signed_in,
            key_verified: false,
            recovery_confirmed,
            keychain_unavailable: false,
        })
    }

    async fn open(
        &self,
        observers: Vec<Arc<dyn ApplyObserver>>,
    ) -> Result<Arc<dyn SyncPasses>, SyncError> {
        let vault = Arc::clone(&self.vault);
        let keys = Arc::clone(&self.keys);
        let held = Arc::clone(&self.guard);
        let closes = Arc::clone(&self.closes);
        let generation = *crate::session::lock(&self.closes);
        // The at-rest key is the vault key, installed only while the master key is readable. The
        // session's owner keeps it installed while the agent holds it too.
        tokio::task::spawn_blocking(move || -> Result<(), SyncError> {
            let guard = keys.acquire(&vault)?;
            let closed = crate::session::lock(&closes);
            if *closed != generation {
                return Err(SyncError::Locked);
            }
            *crate::session::lock(&held) = Some(guard);
            drop(closed);
            Ok(())
        })
        .await
        .map_err(|error| SyncError::Storage {
            source: memry_core::api::errors::StorageError::Failed {
                what: format!("the at-rest key task failed: {error}"),
            },
        })??;
        let driver = self
            .vault
            .sync_driver(
                Arc::clone(&self.session),
                Arc::clone(&self.reachability),
                DriverConfig::desktop(),
                self.seeds.clone(),
                observers
                    .into_iter()
                    .chain(self.observers.iter().cloned())
                    .collect(),
            )
            .await
            .inspect_err(|_| self.close())?;
        Ok(Arc::new(driver))
    }

    fn refresh_refused(&self) -> bool {
        self.session.refresh_refused()
    }

    fn close(&self) {
        let mut closes = crate::session::lock(&self.closes);
        *closes += 1;
        let guard = crate::session::lock(&self.guard).take();
        drop(closes);
        drop(guard);
    }
}
