//! `SyncDriver`: the one composition of the sync tier a long-lived shell runs
//! (#3534). Rust only, never on the FFI surface: iOS keeps
//! [`crate::api::sync::VaultSync`], one call per pass.
//!
//! The driver builds the [`SyncEngine`] (pull, seeds, push), the
//! [`FirstSync`] with its bootstrap session and packs, and the applied-record
//! feed ([`observer`]), once per session, and the desktop supervisor calls
//! it. The supervisor never composes core pieces itself, and
//! [`SyncEngine::run_pass`] stays the only pass entry.
//!
//! What it adds over the engine:
//!
//! - **Pause** ([`pause`]). A paused driver runs no pass and no first sync,
//!   and the pass in flight ends at its next request; the caller persists the
//!   flag (`meta` `sync.paused`, the supervisor's).
//! - **The seeds.** The tag seed and the lock seed are registered here; the
//!   caller adds its own (desktop's property definitions).
//! - **The server vault id** ([`super::server_vault`]) on every request. An
//!   unbound vault gets no driver: it would send no header, and the server
//!   routes such a request to the account's only vault.
//! - **One pass at a time per vault**, across every driver and `VaultSync` of
//!   it: the caller hands in the vault's process-wide pass gate.
//! - **The device directory** ([`cipher`]): refetched after a lookup missed,
//!   and the records that missed re-pulled in the same pass. The records an
//!   earlier driver stored corrupt for an unknown signer are re-pulled when
//!   the driver opens, so a quit before that re-pull loses nothing.
//! - **The stale-cursor reset** ([`super::hardening::stale_cursor`]): it
//!   watches the reachability seam, and the feed pull after a reconnect a
//!   day past the last successful pull reads the feed from the start.
//! - **The manifest check** ([`super::hardening::manifest`]) after a pass
//!   whose pull reached the head of the feed, at most every 30 minutes.
//! - **The snapshots** ([`snapshots`], chapter 07 §7.13): requested for each
//!   document the push wave stored updates of, pushed when due and at
//!   shutdown, and behind an update too large for the incremental route. All
//!   CRDT pushes share one [`CrdtAdmission`].

mod bodies;
mod cipher;
#[cfg(feature = "markdown")]
mod lock_seed;
pub mod observer;
mod pause;
pub mod progress;
mod repairs;
mod snapshots;

use std::sync::{Arc, RwLock};

use zeroize::Zeroizing;

use crate::api::auth::AuthSession;
use crate::api::errors::{StorageError, SyncError};
use crate::api::projects::ProjectSeed;
use crate::api::sync::snapshot_fallback::{LastPull, PassSnapshots};
use crate::api::tag_hub::{TagHub, TagSeed};
use crate::crdt::SnapshotPusher;
use crate::crdt::snapshot_cadence::SnapshotRequests;
use crate::crypto::agent_envelope::AtRestKey;
use crate::crypto::keys;
use crate::domain::task_activity::superseded::SupersededObserver;
use crate::protocol::account::{AccountSealer, DeviceSigner, device_directory};
use crate::protocol::auth::TokenManager;
use crate::protocol::http::{HttpClient, TokenProvider};
use crate::protocol::types::Declaration;
use crate::seams::reachability::{Reachability, ReachabilityObserver};
use crate::seams::transport::Transport;
use crate::storage::Db;
use crate::storage::repositories::sync_items;
use pause::PauseSwitch;

use super::admission::CrdtAdmission;
use super::body_pull::BodyPull;
use super::bootstrap::BootstrapClient;
use super::engine::{PassReport, PassSeed, SyncEngine};
use super::first_sync::{FirstSync, FirstSyncLimits, FirstSyncReport, ProgressSink};
use super::first_sync_store::read_meta;
use super::hardening::history::{self, HistoryKind};
use super::hardening::manifest::ManifestCheck;
use super::hardening::stale_cursor::StaleCursor;
use super::pack_bootstrap::PackBootstrap;
use super::policy::ServerClock;
use super::pull::PullLoop;
use super::push::PushCoordinator;
use super::socket::{HintSink, RealtimeClient};
use super::state::{PassTrigger, SyncState, WriteGate};
use cipher::DirectoryCipher;
#[cfg(feature = "markdown")]
use lock_seed::VaultLockSeed;
pub use observer::{
    AppliedFeed, AppliedOutcome, AppliedRecord, ApplyObserver, AttachmentDownload, CorruptItem,
    FieldConflict, Observers, SecurityWarning,
};
use progress::{InitialSyncPhase, InitialSyncSink, Phases, TasksPhase};
pub use snapshots::SnapshotRound;

/// How a driver syncs.
#[derive(Debug, Clone)]
pub struct DriverConfig {
    /// `X-Memry-Sync-Types` (chapter 13 §13.1).
    pub declaration: Declaration,
    /// The first sync's bodies window and cap.
    pub first_sync: FirstSyncLimits,
    /// Pages one pass walks before it yields the gate.
    pub max_pages_per_pass: u32,
    /// Packs the first sync downloads at once.
    pub pack_concurrency: usize,
}

impl DriverConfig {
    /// Desktop: its declaration, every body (Electron's first sync), and
    /// three packs at once (`pack-bootstrap.ts`).
    #[cfg(feature = "markdown")]
    pub fn desktop() -> Self {
        Self {
            declaration: Declaration::desktop(),
            first_sync: FirstSyncLimits::ALL,
            max_pages_per_pass: super::engine::MAX_PAGES_PER_PASS,
            pack_concurrency: 3,
        }
    }
}

/// What the driver is doing, for the status a shell shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriverStatus {
    pub state: SyncState,
    pub write_gate: WriteGate,
    pub paused: bool,
}

/// What the driver's first sync did: the sub-sequence, then the passes that
/// caught up to the feed head.
#[derive(Debug, Clone)]
pub struct FirstSyncOutcome {
    pub first_sync: FirstSyncReport,
    pub passes: Vec<PassReport>,
}

/// What a driver is built from: the open vault's parts and the session.
pub struct DriverParts {
    pub db: Db,
    pub at_rest: AtRestKey,
    pub session: Arc<AuthSession>,
    pub reachability: Arc<dyn Reachability>,
    pub config: DriverConfig,
    /// Seeds the caller owns, run after the driver's own.
    pub seeds: Vec<Arc<dyn PassSeed>>,
    /// The vault's one pass gate (`api::sync::pass_gate`).
    pub pass_gate: Arc<tokio::sync::Mutex<()>>,
    /// Hear every page applied from the open on, its re-pull included.
    pub observers: Vec<Arc<dyn ApplyObserver>>,
}

/// The first sync's parts, built once and run under the pass gate.
struct FirstSyncParts {
    pull: Arc<PullLoop>,
    bodies: Arc<BodyPull>,
    bootstrap: Arc<BootstrapClient>,
    packs: Arc<PackBootstrap>,
    limits: FirstSyncLimits,
}

/// Pass and first-sync driver for one open vault and one session.
pub struct SyncDriver {
    engine: SyncEngine,
    first: FirstSyncParts,
    db: Db,
    http: Arc<HttpClient>,
    /// The session's tokens, for the realtime socket's handshake.
    tokens: Arc<TokenManager>,
    server_vault: String,
    cipher: Arc<DirectoryCipher>,
    /// The `tasks` progress, the seed registered after every other.
    tasks: Arc<TasksPhase>,
    pause: PauseSwitch,
    /// The 30-minute manifest check ([`super::hardening::manifest`]).
    manifest: ManifestCheck,
    /// The snapshot pusher and the gate's last pull ([`snapshots`]).
    snapshots: Arc<PassSnapshots>,
    snapshot_requests: Arc<SnapshotRequests>,
    admission: Arc<CrdtAdmission>,
    /// The observers every pull tells, for the body step's `bodies_settled`.
    observers: Arc<Observers>,
}

impl SyncDriver {
    /// Builds the driver. Fetches the device directory once, so it fails
    /// offline; reads the master key, so it fails [`SyncError::Locked`] on a
    /// device nothing unlocked; refuses a vault bound to no server vault.
    pub async fn open(parts: DriverParts) -> Result<Self, SyncError> {
        let DriverParts {
            db,
            at_rest,
            session,
            reachability,
            config,
            seeds,
            pass_gate,
            observers: listeners,
        } = parts;
        let server_vault = db
            .call(|conn| super::server_vault::bound(conn))
            .await?
            .ok_or_else(|| StorageError::Failed {
                what: "this vault is bound to no server vault; bind it before syncing".into(),
            })?;
        let pause = PauseSwitch::default();
        let http = Arc::new(pause.client(
            &session.http(),
            Arc::clone(&session.tokens) as Arc<dyn TokenProvider>,
        ));
        let master_key = Zeroizing::new(session.master_key()?.ok_or(SyncError::Locked)?);
        let vault_key = Zeroizing::new(keys::derive_vault_key(&master_key)?.to_vec());
        let directory = device_directory(&http).await?;
        let cipher = Arc::new(DirectoryCipher::new(vault_key.to_vec(), directory));
        let device_id = session.device_id()?;
        let signer = DeviceSigner::new(
            &session.registered_device_id()?,
            session.signing_secret_key()?,
        )
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })?;
        let sealer = Arc::new(AccountSealer::new(vault_key.to_vec(), signer));
        let observers = Arc::new(Observers::default());
        for listener in listeners {
            observers.register(listener);
        }
        let declaration = config.declaration.clone();

        let pull_loop = || {
            PullLoop::new(
                Arc::clone(&http),
                db.clone(),
                declaration.clone(),
                cipher.clone(),
            )
            .with_clock_device(&device_id)
            .with_at_rest_key(at_rest.clone())
            .with_observers(Arc::clone(&observers))
            .with_vault(&server_vault)
            .with_hardening()
            .with_signer_keys(cipher.clone())
        };
        let stale_cursor = Arc::new(StaleCursor::default());
        reachability.observe(Arc::clone(&stale_cursor) as Arc<dyn ReachabilityObserver>);
        let feed = pull_loop()
            .with_note_bodies(cipher.clone())
            .with_stale_cursor(stale_cursor);
        let admission = Arc::new(CrdtAdmission::default());
        let snapshot_requests = Arc::new(SnapshotRequests::default());
        let snapshots = Arc::new(PassSnapshots {
            pusher: SnapshotPusher::new(
                Arc::clone(&http),
                db.clone(),
                sealer.clone(),
                declaration.clone(),
            )
            .with_single_attempt()
            .with_vault(&server_vault),
            db: db.clone(),
            device_id: device_id.clone(),
            pull: Arc::new(RwLock::new(LastPull::default())),
            admission: Some(Arc::clone(&admission)),
        });
        let push = PushCoordinator::new(Arc::clone(&http), db.clone(), declaration.clone(), sealer)
            .with_at_rest_key(at_rest.clone())
            .with_vault(&server_vault)
            .with_snapshot_fallback(Arc::clone(&snapshots) as _)
            .with_crdt_pacing(Arc::clone(&admission), Arc::clone(&snapshot_requests));
        let bootstrap = Arc::new(BootstrapClient::new(Arc::clone(&http)).with_vault(&server_vault));
        let bodies = Arc::new(
            BodyPull::new(
                Arc::clone(&http),
                db.clone(),
                declaration.clone(),
                cipher.clone(),
            )
            .with_observers(Arc::clone(&observers))
            .with_vault(&server_vault)
            .with_bootstrap(Arc::clone(&bootstrap)),
        );
        let packs = PackBootstrap::new(Arc::clone(&http), db.clone(), Arc::clone(&bodies))
            .with_concurrency(config.pack_concurrency)
            .with_vault(&server_vault);

        let tags = TagHub::over(db.clone(), &session.store)?;
        let mut engine = SyncEngine::new(Arc::new(feed), Arc::clone(&http), reachability)
            .with_push(Arc::new(push))
            .with_pull_sink(Arc::clone(&snapshots) as _)
            .with_gate(pass_gate)
            .with_max_pages(config.max_pages_per_pass)
            .with_seed(Arc::new(TagSeed(Arc::new(tags))))
            .with_seed(ProjectSeed::over(db.clone(), device_id.clone()));
        #[cfg(feature = "markdown")]
        if declaration.classify(crate::domain::vault_locks::ITEM_TYPE)
            == crate::protocol::types::ArrivingItemType::Subscribed
        {
            engine = engine.with_seed(Arc::new(VaultLockSeed {
                db: db.clone(),
                device_id: device_id.clone(),
            }));
        }
        for seed in seeds {
            engine = engine.with_seed(seed);
        }
        let tasks = Arc::new(TasksPhase::new(db.clone()));
        engine = engine.with_seed(Arc::clone(&tasks) as Arc<dyn PassSeed>);
        observers.register(SupersededObserver::new(db.clone(), device_id.clone()));

        let driver = Self {
            engine,
            first: FirstSyncParts {
                pull: Arc::new(pull_loop()),
                bodies,
                bootstrap,
                packs: Arc::new(packs),
                limits: config.first_sync,
            },
            db,
            http,
            tokens: Arc::clone(&session.tokens),
            server_vault: server_vault.clone(),
            cipher,
            tasks,
            pause,
            manifest: ManifestCheck::default(),
            snapshots,
            snapshot_requests,
            admission,
            observers,
        };
        driver.repull_unknown_signers().await?;
        Ok(driver)
    }

    /// One pass ([`SyncEngine::run_pass`]); `None` while paused.
    pub async fn run_pass(&self, trigger: PassTrigger) -> Option<PassReport> {
        if self.is_paused() {
            return None;
        }
        self.settle_misses().await;
        let started = super::pull::now_ms();
        let pass = self.engine.run_pass(trigger).await;
        self.pull_bodies(&pass).await;
        self.record_history(&pass, started).await;
        self.settle_misses().await;
        self.check_manifest(&pass).await;
        Some(pass)
    }

    /// A socket hint ([`SyncEngine::wake`]); `None` while paused or dropped.
    pub async fn wake(&self, cursor: Option<i64>) -> Option<PassReport> {
        if self.is_paused() {
            return None;
        }
        self.settle_misses().await;
        let started = super::pull::now_ms();
        let pass = self.engine.wake(cursor).await;
        if let Some(pass) = &pass {
            self.record_history(pass, started).await;
        }
        self.settle_misses().await;
        pass
    }

    /// Whether this vault has not finished a first sync yet.
    pub async fn needs_first_sync(&self) -> Result<bool, SyncError> {
        let done = self
            .db
            .call(|conn| read_meta(conn, super::first_sync::META_FIRST_SYNC_COMPLETED))
            .await?;
        Ok(done.is_none())
    }

    /// The first sync under the pass gate, then passes until the feed head,
    /// so the seeds run and the outbox drains. `None` while paused.
    ///
    /// Progress follows Electron's full sync: `notes` and `packs` from the
    /// first sync, `tasks` with the outbox the passes will push once their
    /// seeds ran (only when it is not empty), then `complete`.
    pub async fn first_sync(
        &self,
        progress: Arc<dyn InitialSyncSink>,
    ) -> Result<Option<FirstSyncOutcome>, SyncError> {
        if self.is_paused() {
            return Ok(None);
        }
        let phases = Arc::new(Phases(progress));
        self.settle_misses().await;
        let first_sync = {
            let _gate = self.engine.hold_gate().await;
            FirstSync::new(
                Arc::clone(&self.first.pull),
                Arc::clone(&self.first.bodies),
                self.db.clone(),
            )
            .with_bootstrap(Arc::clone(&self.first.bootstrap))
            .with_packs(Arc::clone(&self.first.packs))
            .with_limits(self.first.limits)
            .with_progress(Arc::clone(&phases) as Arc<dyn ProgressSink>)
            .run(super::pull::now_ms())
            .await?
        };
        self.tasks.arm(Some(Arc::clone(&phases)));
        let mut passes = Vec::new();
        let mut cursor = None;
        loop {
            let Some(pass) = self.run_pass(PassTrigger::Explicit).await else {
                break;
            };
            // A pass that left the cursor where it was would repeat forever.
            let more = pass.pull.has_more
                && pass.final_state == SyncState::Idle
                && pass.pull.cursor != cursor;
            cursor.clone_from(&pass.pull.cursor);
            passes.push(pass);
            if !more {
                break;
            }
        }
        self.tasks.arm(None);
        phases.emit(InitialSyncPhase::Complete, 0, 0);
        Ok(Some(FirstSyncOutcome { first_sync, passes }))
    }

    pub fn status(&self) -> DriverStatus {
        DriverStatus {
            state: self.engine.state(),
            write_gate: self.engine.write_gate(),
            paused: self.is_paused(),
        }
    }

    /// The account's plan ([`SyncEngine::set_entitled`]).
    pub fn set_entitled(&self, entitled: bool) {
        self.engine.set_entitled(entitled);
    }

    /// The pass's [`history`] rows, as Electron's coordinators write them: a
    /// pull that succeeded (`pull-coordinator.ts:527`), a push that sent rows
    /// (`push-coordinator.ts:519`), and each failure (`:583`, `:566`). A row
    /// that does not write is logged; the pass already happened.
    async fn record_history(&self, pass: &PassReport, started_ms: i64) {
        let mut rows: Vec<(HistoryKind, usize, Option<String>)> = Vec::new();
        if pass.pull.pages > 0 && pass.pull_error.is_none() && !pass.pull.refused {
            rows.push((
                HistoryKind::Pull,
                pass.pull.applied + pass.pull.deleted,
                None,
            ));
        }
        if pass.pushed_items > 0 {
            rows.push((HistoryKind::Push, pass.pushed_items, None));
        }
        // A request a pause cut is not a failure.
        let errors = [&pass.pull_error, &pass.push_error].into_iter().flatten();
        for error in errors.filter(|error| !error.is_cancelled()) {
            rows.push((HistoryKind::Error, 0, Some(error.to_string())));
        }
        if rows.is_empty() {
            return;
        }
        let recorded = self
            .db
            .call(move |conn| {
                let now = super::pull::now_ms();
                rows.iter().try_for_each(|(kind, count, details)| {
                    history::record(
                        conn,
                        *kind,
                        *count,
                        now - started_ms,
                        details.as_deref(),
                        now,
                    )
                })
            })
            .await;
        if let Err(error) = recorded {
            eprintln!("memry-core: recording the sync history failed: {error}");
        }
    }

    /// The server clock the last policy poll read ([`super::policy::PolicyTier::server_clock`]).
    pub fn server_clock(&self) -> Option<ServerClock> {
        self.engine.policy().server_clock()
    }

    /// The realtime socket of this driver's server vault (chapter 09), over `transport` (the
    /// session's, or a wrapper of [`SyncDriver::transport`]) and the session's tokens.
    pub fn realtime_client(
        &self,
        transport: Arc<dyn Transport>,
        sink: Arc<dyn HintSink>,
    ) -> RealtimeClient {
        RealtimeClient::new(
            transport,
            self.http.base_url(),
            self.http.identity().clone(),
            self.token_provider(),
            sink,
        )
        .with_vault(&self.server_vault)
    }

    /// The session's transport.
    pub fn transport(&self) -> Arc<dyn Transport> {
        self.http.transport()
    }

    /// The session's tokens, which the realtime socket refreshes through.
    pub fn token_provider(&self) -> Arc<dyn TokenProvider> {
        Arc::clone(&self.tokens) as Arc<dyn TokenProvider>
    }

    /// Re-pulls, under the pass gate and over the directory `open` just
    /// fetched, every record stored corrupt for an unknown signer (chapter 01
    /// §1.4.0). The cipher's list of misses lives only as long as a driver, so
    /// after a quit between the page that stored such a record and
    /// [`SyncDriver::settle_misses`], the row is the only trace. A failed
    /// re-pull is logged and left to the next pass's settle.
    async fn repull_unknown_signers(&self) -> Result<(), SyncError> {
        let _gate = self.engine.hold_gate().await;
        let ids = self
            .db
            .call(|conn| sync_items::unknown_signer_ids(conn))
            .await?;
        if ids.is_empty() {
            return Ok(());
        }
        match self.first.pull.fetch_ids(&ids).await {
            // A signer still missing from a fresh directory is not in the
            // account, as in `settle_misses`.
            Ok(_) => self.cipher.forget_missed(),
            Err(error) => {
                eprintln!(
                    "memry-core: re-pulling {} record(s) of an unknown signer failed: {error}",
                    ids.len()
                );
                self.cipher.keep_missed(ids);
            }
        }
        Ok(())
    }

    /// After a lookup missed (chapter 01 §1.4.0): refetches the directory and
    /// re-pulls, by id, the records that missed, under the pass gate. Their
    /// rows were stored corrupt and the feed cursor moved past them, so this
    /// is their only way back. A failed refetch or re-pull is logged and kept
    /// for the next call; the pass runs on the old directory meanwhile.
    async fn settle_misses(&self) {
        if !self.cipher.has_missed() {
            return;
        }
        let _gate = self.engine.hold_gate().await;
        if let Err(error) = self.cipher.refresh(&self.http).await {
            eprintln!("memry-core: refetching the device directory failed: {error}");
            return;
        }
        let ids = self.cipher.take_missed();
        if ids.is_empty() {
            return;
        }
        match self.first.pull.fetch_ids(&ids).await {
            Ok(_) => self.cipher.forget_missed(),
            Err(error) => {
                eprintln!(
                    "memry-core: re-pulling {} record(s) of a new signer failed: {error}",
                    ids.len()
                );
                self.cipher.keep_missed(ids);
            }
        }
    }
}
