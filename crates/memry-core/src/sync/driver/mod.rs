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
//! - **Pause.** A paused driver runs no pass and no first sync; the caller
//!   persists the flag (`meta` `sync.paused`, the supervisor's).
//! - **The seeds.** The tag seed and the lock seed are registered here; the
//!   caller adds its own (desktop's property definitions).
//! - **The server vault id** ([`super::server_vault`]) on every request, when
//!   one is bound.
//! - **The snapshot cadence** (chapter 07 §7.13.3): which documents asked for
//!   a snapshot, and which are due. The push itself needs the resident
//!   document and is the supervisor's.

mod cipher;
pub mod observer;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use zeroize::Zeroizing;

use crate::api::auth::AuthSession;
use crate::api::errors::{StorageError, SyncError};
use crate::api::tag_hub::{TagHub, TagSeed};
use crate::crdt::snapshots::snapshot_is_due;
use crate::crypto::agent_envelope::AtRestKey;
use crate::crypto::keys;
use crate::protocol::account::{AccountSealer, DeviceSigner, device_directory};
use crate::protocol::http::HttpClient;
use crate::protocol::types::Declaration;
use crate::seams::reachability::Reachability;
use crate::storage::Db;

use super::body_pull::BodyPull;
use super::bootstrap::BootstrapClient;
use super::engine::{PassReport, PassSeed, SyncEngine};
use super::first_sync::{FirstSync, FirstSyncLimits, FirstSyncReport, ProgressSink};
use super::first_sync_store::read_meta;
use super::pack_bootstrap::PackBootstrap;
use super::pull::PullLoop;
use super::push::PushCoordinator;
use super::state::{PassTrigger, SyncState, WriteGate};
use cipher::DirectoryCipher;
pub use observer::{AppliedOutcome, AppliedRecord, ApplyObserver, FieldConflict, Observers};

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
    cipher: Arc<DirectoryCipher>,
    observers: Arc<Observers>,
    paused: AtomicBool,
    /// Chapter 07 §7.13.3: per document, the first and last request instants.
    snapshots: Mutex<BTreeMap<String, (i64, i64)>>,
}

impl SyncDriver {
    /// Builds the driver. Fetches the device directory once, so it fails
    /// offline; reads the master key, so it fails [`SyncError::Locked`] on a
    /// device nothing unlocked.
    pub async fn open(parts: DriverParts) -> Result<Self, SyncError> {
        let DriverParts {
            db,
            at_rest,
            session,
            reachability,
            config,
            seeds,
        } = parts;
        let http = session.http();
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
        let server_vault = db.call(|conn| super::server_vault::bound(conn)).await?;
        let observers = Arc::new(Observers::default());
        let declaration = config.declaration.clone();

        let pull_loop = || {
            let pull = PullLoop::new(
                Arc::clone(&http),
                db.clone(),
                declaration.clone(),
                cipher.clone(),
            )
            .with_clock_device(&device_id)
            .with_at_rest_key(at_rest.clone())
            .with_observers(Arc::clone(&observers));
            match &server_vault {
                Some(vault) => pull.with_vault(vault),
                None => pull,
            }
        };
        let feed = pull_loop().with_note_bodies(cipher.clone());
        let mut push =
            PushCoordinator::new(Arc::clone(&http), db.clone(), declaration.clone(), sealer)
                .with_at_rest_key(at_rest.clone());
        let mut bootstrap = BootstrapClient::new(Arc::clone(&http));
        let mut bodies = BodyPull::new(
            Arc::clone(&http),
            db.clone(),
            declaration.clone(),
            cipher.clone(),
        );
        if let Some(vault) = &server_vault {
            push = push.with_vault(vault);
            bootstrap = bootstrap.with_vault(vault);
            bodies = bodies.with_vault(vault);
        }
        let bootstrap = Arc::new(bootstrap);
        let bodies = Arc::new(bodies.with_bootstrap(Arc::clone(&bootstrap)));
        let mut packs = PackBootstrap::new(Arc::clone(&http), db.clone(), Arc::clone(&bodies))
            .with_concurrency(config.pack_concurrency);
        if let Some(vault) = &server_vault {
            packs = packs.with_vault(vault);
        }

        let tags = TagHub::over(db.clone(), &session.store)?;
        let mut engine = SyncEngine::new(Arc::new(feed), Arc::clone(&http), reachability)
            .with_push(Arc::new(push))
            .with_max_pages(config.max_pages_per_pass)
            .with_seed(Arc::new(TagSeed(Arc::new(tags))));
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

        Ok(Self {
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
            cipher,
            observers,
            paused: AtomicBool::new(false),
            snapshots: Mutex::default(),
        })
    }

    /// Adds an observer of every page applied from now on, after those
    /// already registered.
    pub fn register_observer(&self, observer: Arc<dyn ApplyObserver>) {
        self.observers.register(observer);
    }

    /// One pass ([`SyncEngine::run_pass`]); `None` while paused.
    pub async fn run_pass(&self, trigger: PassTrigger) -> Option<PassReport> {
        if self.is_paused() {
            return None;
        }
        self.refresh_directory().await;
        Some(self.engine.run_pass(trigger).await)
    }

    /// A socket hint ([`SyncEngine::wake`]); `None` while paused or dropped.
    pub async fn wake(&self, cursor: Option<i64>) -> Option<PassReport> {
        if self.is_paused() {
            return None;
        }
        self.refresh_directory().await;
        self.engine.wake(cursor).await
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
    pub async fn first_sync(
        &self,
        progress: Arc<dyn ProgressSink>,
    ) -> Result<Option<FirstSyncOutcome>, SyncError> {
        if self.is_paused() {
            return Ok(None);
        }
        self.refresh_directory().await;
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
            .with_progress(progress)
            .run(super::pull::now_ms())
            .await?
        };
        let mut passes = Vec::new();
        loop {
            let Some(pass) = self.run_pass(PassTrigger::Explicit).await else {
                break;
            };
            let more = pass.pull.has_more && pass.final_state == SyncState::Idle;
            passes.push(pass);
            if !more {
                break;
            }
        }
        Ok(Some(FirstSyncOutcome { first_sync, passes }))
    }

    /// Records that `doc_id` changed and wants a snapshot (§7.13.3).
    pub fn request_snapshot(&self, doc_id: &str, now_ms: i64) {
        let mut pending = self.snapshot_lock();
        pending
            .entry(doc_id.to_owned())
            .and_modify(|(_, last)| *last = now_ms)
            .or_insert((now_ms, now_ms));
    }

    /// The documents whose snapshot is due at `now_ms`, taken off the list:
    /// 30 s quiet, or 120 s after the first request ([`snapshot_is_due`]).
    pub fn snapshot_due(&self, now_ms: i64) -> Vec<String> {
        let mut pending = self.snapshot_lock();
        let due: Vec<String> = pending
            .iter()
            .filter(|(_, (first, last))| snapshot_is_due(Some(*first), Some(*last), now_ms))
            .map(|(doc_id, _)| doc_id.clone())
            .collect();
        for doc_id in &due {
            pending.remove(doc_id);
        }
        due
    }

    /// Stops passes and first syncs until [`SyncDriver::resume`]. A pass
    /// already running finishes.
    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
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

    fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    fn snapshot_lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, (i64, i64)>> {
        self.snapshots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A failed refetch is logged; the pass runs on the old directory and its
    /// unresolved signers stay unverified, never dropped (chapter 01 §1.4.0).
    async fn refresh_directory(&self) {
        if let Err(error) = self.cipher.refresh_if_missed(&self.http).await {
            eprintln!("memry-core: refetching the device directory failed: {error}");
        }
    }
}

/// Gives each lock written before Step 16 its record (Electron's
/// `seedUnclocked`, [`crate::domain::vault_locks::seed_unsynced`]). Registered
/// only for a declaration that subscribes `vault_lock`: without it the device
/// never pulls a peer's edit of the lock, so its pushes would tick only its own
/// clock.
#[cfg(feature = "markdown")]
struct VaultLockSeed {
    db: Db,
    device_id: String,
}

#[cfg(feature = "markdown")]
#[async_trait::async_trait]
impl PassSeed for VaultLockSeed {
    async fn seed(&self) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call(move |conn| {
                crate::domain::vault_locks::seed_unsynced(conn, &device_id, super::pull::now_ms())
            })
            .await?;
        Ok(())
    }
}
