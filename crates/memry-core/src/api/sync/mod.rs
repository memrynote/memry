//! The read-only sync a shell can drive: the first sync that **fills** an
//! opened vault, and the one on-demand body fetch that finishes it (T236,
//! spec-defect 136).
//!
//! ## Why this exists
//!
//! [`crate::api::vault::Vault`] and [`crate::api::notes::Notes`] are five local
//! reads over a SQLite database, and until this module landed **nothing on the
//! FFI surface ever put a row in it**. A phone that had never synced opened an
//! empty database and correctly reported "no notes" against an account holding
//! ninety-four. The vault *list* worked, because `AuthSession::vaults` is a
//! network read — which is exactly what hid the gap: the screen before the
//! empty one was full.
//!
//! ## Read-only, and it must stay that way
//!
//! Nothing here pushes, seals, or drains an outbox. That is not tidiness: a
//! client that pushes a field-merged type **without pulling first** silently
//! destroys a concurrent peer's field, and no later pass repairs it (known bug
//! 2). The pull half is the safe half. When the write half arrives it arrives
//! as pull-then-push inside the core, never as a second exported verb a shell
//! can call on its own.
//!
//! ## Why `VaultSync` is minted by `Vault` and takes an `AuthSession`
//!
//! The three things a pull needs live in three different places:
//!
//! | Need              | Held by                                             |
//! | ----------------- | --------------------------------------------------- |
//! | the database      | [`Vault`](crate::api::vault::Vault), which opened it |
//! | an authenticated `HttpClient` | [`AuthSession`], which owns the one `TokenManager` |
//! | the master key    | the `SecureStore` the session was built over         |
//!
//! So `Vault::sync(session)` is the only shape that needs no new seam and no
//! second token manager. Handing the session in rather than storing a client on
//! `Vault` keeps `Vault::open` what it is — a local, offline, blocking open
//! that works before anyone has signed in.
//!
//! **The cost, stated:** a `VaultSync` outlives nothing and owns nothing, but it
//! does hold an `Arc<AuthSession>`, so a shell that keeps one alive keeps the
//! session alive. That is the correct lifetime — a sync without a session is
//! meaningless — but it means the shell must drop its `VaultSync` on sign-out
//! rather than relying on the session going away first.
//!
//! ## No key crosses, in either direction
//!
//! The vault key is derived **inside** this module from the master key the
//! secure store already holds, used to build an [`AccountCipher`], and dropped.
//! Nothing on this surface accepts a key, returns a key, or names one, which is
//! what keeps `core-api.md`'s "none of the B3 objects exposes a key" true.

use std::path::PathBuf;
use std::sync::Arc;

use zeroize::Zeroizing;

use crate::api::auth::AuthSession;
use crate::api::diagnostics::run_diagnostics;
use crate::api::errors::{StorageError, SyncError};
use crate::crypto::keys;
use crate::crypto::sodium;
use crate::domain::attachment_uploads;
use crate::domain::attachments;
use crate::domain::notes;
use crate::domain::reads;
use crate::protocol;
use crate::protocol::account::{self, AccountCipher};
use crate::protocol::attachment_upload;
use crate::protocol::attachments as protocol_attachments;
use crate::protocol::http::RetryPolicy;
use crate::protocol::types::Declaration;
use crate::seams::reachability::Reachable;
use crate::storage::Db;
use crate::sync::body_pull::{BodyPull, BodyPullError, BodyPullReport};
use crate::sync::bootstrap::BootstrapClient;
use crate::sync::first_sync::{
    FirstSync, FirstSyncError, FirstSyncPhase, FirstSyncProgress, FirstSyncReport,
    META_FIRST_SYNC_COMPLETED, ProgressSink,
};
use crate::sync::first_sync_store::read_meta;
use crate::sync::pack_bootstrap::PackBootstrap;
use crate::sync::pull::PullLoop;
use crate::sync::socket_run::TerminalLatch;

mod attachment_fetch;
mod attachments_io;
mod drain;
mod inbox_attachments;
mod note_uploads;
mod pass;
mod realtime;

pub use attachment_fetch::AttachmentRedriveSummary;
pub use drain::BodyDrainSummary;
pub use inbox_attachments::{InboxAttachmentSyncSummary, InboxFileAttachment};
pub use pass::SyncPassSummary;
pub use realtime::{RealtimeListener, VaultRealtime};

use attachments_io::*;
use note_uploads::*;

impl From<FirstSyncError> for SyncError {
    fn from(error: FirstSyncError) -> Self {
        match error {
            FirstSyncError::Pull { source } => match source {
                crate::sync::pull::PullError::Api { source } => SyncError::Api { source },
                crate::sync::pull::PullError::Storage { source } => SyncError::Storage { source },
            },
            FirstSyncError::Body { source } => source.into(),
            FirstSyncError::Storage { source } => SyncError::Storage { source },
        }
    }
}

impl From<BodyPullError> for SyncError {
    fn from(error: BodyPullError) -> Self {
        match error {
            BodyPullError::Api { source } => SyncError::Api { source },
            BodyPullError::Storage { source } => SyncError::Storage { source },
        }
    }
}

/// Which part of the vault is arriving, data-model §C.3 and FR-028.
///
/// A mirror of [`FirstSyncPhase`] rather than a derive on it: the internal type
/// is free to gain a pass, and the day it does, this enum's absence of one is a
/// compile error here rather than a silent new case on the FFI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SyncPhase {
    /// Note records: what a shell shows as "Downloading notes".
    Records,
    /// Note bodies: what a shell shows as "Downloading note content".
    Bodies,
    Done,
}

impl From<FirstSyncPhase> for SyncPhase {
    fn from(phase: FirstSyncPhase) -> Self {
        match phase {
            FirstSyncPhase::Records => SyncPhase::Records,
            FirstSyncPhase::Bodies => SyncPhase::Bodies,
            FirstSyncPhase::Done => SyncPhase::Done,
        }
    }
}

/// FR-028's determinate progress, in live notes and journals of the vault
/// (#5233). `completed` is never above `total`, so a shell renders a fraction
/// without guarding against one above 1. `total` is `None` while the vault's
/// total is not known yet, early in the records phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct SyncProgress {
    pub phase: SyncPhase,
    pub completed: u64,
    pub total: Option<u64>,
}

/// Where progress goes.
///
/// **Synchronous by contract.** It is called from inside the pass that is
/// reporting, so an implementation that blocks stalls the sync it is measuring:
/// hop to the main thread and return, never await inside it.
#[uniffi::export(with_foreign)]
pub trait SyncProgressListener: Send + Sync {
    fn progress(&self, progress: SyncProgress);
}

/// Adapts the foreign listener onto the core's internal sink.
pub(super) struct ForeignProgress(pub(super) Arc<dyn SyncProgressListener>);

impl ProgressSink for ForeignProgress {
    fn progress(&self, progress: FirstSyncProgress) {
        self.0.progress(SyncProgress {
            phase: progress.phase.into(),
            completed: progress.completed,
            total: progress.total,
        });
    }
}

/// What a first sync did.
///
/// Counts are `u32` because `usize` has no FFI width. **`metadata_corrupt` is
/// not a failure and must not be hidden**: it is the number of items this
/// device could not open, and a vault that returns some of them is a vault a
/// shell should say something about rather than render as complete.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FirstSyncSummary {
    pub refs_recorded: u32,
    pub tombstones: u32,
    /// Records the metadata pass applied. With record packs this is often 0:
    /// the packs and the reconcile applied them (the two counts below).
    pub metadata_applied: u32,
    /// Record pack entries applied (chapter 08 §8.4.2).
    pub record_pack_entries: u32,
    /// Items the manifest reconcile pulled by id (§8.10).
    pub reconcile_pulled: u32,
    /// Documents the body pack phase proved current.
    pub pack_bodies_settled: u32,
    /// Documents still owed a body when the run ended: the shell's
    /// [`VaultSync::drain_bodies`] pulls them.
    pub bodies_owed: u32,
    pub metadata_corrupt: u32,
    pub bodies: u32,
    pub updates: u32,
    /// Documents whose body pull stopped at an update this device could not
    /// open (chapter 07 §7.9). Their cursor did **not** advance, so the next
    /// run retries them; they are not lost and they are not complete.
    pub bodies_stopped: u32,
    /// The window boundary this run used, epoch milliseconds. A note older than
    /// this has its metadata but not yet its body.
    pub window_start_ms: i64,
    /// Whether the bootstrap session was elevated (chapter 10 §10.7).
    /// Informational: the run is byte-for-byte identical either way.
    pub elevated: bool,
}

/// The core's own clock, as [`crate::sync::pull`] and [`crate::sync::body_pull`]
/// already use it.
///
/// Deliberately **not** a parameter. The window boundary FR-028 windows against
/// is the core's decision (chapter 10 §10.6.1 leaves the span to the client and
/// `first_sync.window_start` persists it), and a shell that supplied a clock
/// could hand in a wrong one and get a silently wrong window back.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 128 bits of libsodium randomness, hex.
fn hex_id() -> String {
    sodium::random_bytes(16)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

impl From<FirstSyncReport> for FirstSyncSummary {
    fn from(report: FirstSyncReport) -> Self {
        Self {
            refs_recorded: count(report.refs_recorded),
            tombstones: count(report.tombstones),
            metadata_applied: count(report.metadata_applied),
            record_pack_entries: count(report.record_packs.entries_applied),
            reconcile_pulled: count(report.reconcile_pulled),
            pack_bodies_settled: count(report.body_packs.settled),
            bodies_owed: count(report.bodies_owed),
            metadata_corrupt: count(report.metadata_corrupt),
            bodies: count(report.bodies.documents),
            updates: count(report.bodies.updates),
            bodies_stopped: count(report.bodies.stopped.len()),
            window_start_ms: report.window_start,
            elevated: report.elevated,
        }
    }
}

/// What one on-demand body fetch did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BodyFetchSummary {
    pub updates: u32,
    pub baselines: u32,
    /// The pull stopped at an update this device could not open (§7.9). The
    /// body is **incomplete, not absent**, and the cursor did not advance past
    /// the gap, so a later fetch resumes there.
    pub stopped: bool,
}

/// What one attachment fetch did.
///
/// `deferred` is not a failure. FR-045 asks for lazy, unmetered-by-default
/// downloads, so "waiting for wifi" is the feature working; a shell that met
/// an error there would report a fault for correct behaviour.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AttachmentFetchSummary {
    pub downloaded: bool,
    /// The metered policy said not now (FR-045).
    pub deferred: bool,
    /// Plaintext bytes written. Zero when deferred.
    pub bytes: u64,
    /// Relative to the vault's `images/` directory, when the bytes are there
    /// — which includes the deferred case if an earlier fetch succeeded.
    pub local_path: Option<String>,
}

impl From<BodyPullReport> for BodyFetchSummary {
    fn from(report: BodyPullReport) -> Self {
        Self {
            updates: count(report.updates),
            baselines: count(report.baselines),
            stopped: !report.stopped.is_empty(),
        }
    }
}

/// The read-only sync over one opened vault.
///
/// Built by [`crate::api::vault::Vault::sync`], which is the only way: a
/// `VaultSync` over a database nobody opened is a sync into the wrong vault.
#[derive(uniffi::Object)]
pub struct VaultSync {
    vault_id: String,
    db: Db,
    session: Arc<AuthSession>,
    /// The vault directory, for the one thing sync writes outside the
    /// database: attachment bytes live in `images/` as sandbox files rather
    /// than as blobs (data-model §A.4).
    directory: String,
    /// §9.9's 4004/4009 latch, here rather than on the socket because the
    /// shell mints a socket per foreground (#2798).
    realtime_latch: Arc<TerminalLatch>,
}

impl VaultSync {
    pub(crate) fn over(
        vault_id: String,
        db: Db,
        session: Arc<AuthSession>,
        directory: String,
    ) -> Self {
        Self {
            vault_id,
            db,
            session,
            directory,
            realtime_latch: Arc::default(),
        }
    }

    /// The account's record cipher: chapter 01 §1.7's one vault key, and
    /// chapter 01 §1.4.0's signer directory.
    ///
    /// The directory is fetched **before** the first page, so a record signed
    /// by a peer opens rather than landing unverified. It is a snapshot: a
    /// `signerDeviceId` it cannot resolve is one corrupt item, never a dropped
    /// page, and the next run refetches.
    async fn cipher(&self) -> Result<Arc<AccountCipher>, SyncError> {
        let master_key = Zeroizing::new(self.session.master_key()?.ok_or(SyncError::Locked)?);
        let vault_key = Zeroizing::new(keys::derive_vault_key(&master_key)?.to_vec());
        let directory = account::device_directory(&self.session.http()).await?;
        Ok(Arc::new(AccountCipher::new(vault_key.to_vec(), directory)))
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl VaultSync {
    /// Outbox rows still waiting to reach the server, claimable or parked in
    /// backoff: the "N pending" a status line shows (spec 006 ST15). Blocks,
    /// makes no request.
    pub fn pending_changes(&self) -> Result<u32, SyncError> {
        let depth = self
            .db
            .call_blocking(|conn| crate::sync::outbox::depth(conn))?;
        Ok(u32::try_from(depth).unwrap_or(u32::MAX))
    }

    /// Whether this device has already finished a first sync for this vault.
    ///
    /// **Blocks, and makes no request** (spec-defect 90). It is one row of the
    /// local `meta` table, so a shell can decide whether to show a "setting
    /// up" screen without going near the network — which is the whole point of
    /// asking.
    pub fn is_first_sync_complete(&self) -> Result<bool, SyncError> {
        Ok(self
            .db
            .call_blocking(|conn| read_meta(conn, META_FIRST_SYNC_COMPLETED))?
            .is_some())
    }

    /// The first sync: note records for the whole vault, then bodies from packs
    /// for the whole vault (data-model §C.3, FR-028, #5233). With partial pack
    /// coverage it pulls the owed bodies of the recent window and leaves the
    /// rest owed for [`Self::drain_bodies`].
    ///
    /// **`async`, and that is contract, not detail** (spec-defect 90). It is
    /// tens of network round trips — a no-op pass over a ninety-four-note vault
    /// already costs thirty-odd seconds, and a genuine first sync is longer.
    ///
    /// **It cannot be cancelled from the shell** (spec-defect 108:
    /// `rust_future_cancel` appears nowhere in the generated bindings). A shell
    /// may abandon the *UI* — navigate away, background the app, stop drawing
    /// the bar — and it may drop its `Arc` when the call returns, but the run
    /// itself continues to completion or to its first error. **Never offer a
    /// Cancel button over this call.** What makes that tolerable is that every
    /// pass's progress is durable in the data itself, so a run that is killed
    /// with the process resumes at the last thing it actually wrote rather than
    /// starting again.
    ///
    /// `progress` is optional and is the reason this is bearable to sit in
    /// front of: without it a shell has a spinner and no information. Pass one
    /// unless the run is genuinely invisible.
    ///
    /// **A partial run never leaves a vault looking empty.** Metadata lands
    /// before bodies and each pass is durable as it goes, so an error part way
    /// through leaves the notes that did arrive visible and readable; it throws,
    /// and what it throws is the reason. A shell must render that reason, never
    /// an empty state.
    ///
    /// **A [`Self::sync_now`] asked for meanwhile waits for this run**, as a
    /// second pass waits for the first: the shell shows the vault while it
    /// fills, so writes and foregrounds ask for passes during it.
    pub async fn first_sync(
        &self,
        progress: Option<Arc<dyn SyncProgressListener>>,
    ) -> Result<FirstSyncSummary, SyncError> {
        // A first sync is a pass over this vault, and passes run one at a
        // time. A shell browses the vault while this runs, so a write or a
        // foreground asks for `sync_now` meanwhile; run alongside, both page
        // the one record cursor and spend the same rate-limit buckets.
        let gate = pass::pass_gate(&self.vault_id);
        let _held = gate.lock().await;
        let cipher = self.cipher().await?;
        let http = self.session.http();
        // #5215: the run's own requests are counted, not the session's.
        let diagnostics = run_diagnostics();
        let counted = diagnostics.observe(&http);

        // Chapter 10 §10.6: a client SHOULD open an elevated window, and every
        // failure of it is silent — a 501 from a deployment that has none
        // (§10.12) changes nothing except how long the run takes.
        let bootstrap = Arc::new(
            BootstrapClient::new(http)
                .with_vault(&self.vault_id)
                .with_diagnostics(Arc::clone(&diagnostics)),
        );

        let pull = Arc::new(
            PullLoop::new(
                Arc::clone(&counted),
                self.db.clone(),
                Declaration::subscribed(),
                cipher.clone(),
            )
            .with_vault(&self.vault_id)
            .with_clock_device(&self.session.device_id()?),
        );
        let bodies = Arc::new(
            BodyPull::new(
                Arc::clone(&counted),
                self.db.clone(),
                Declaration::subscribed(),
                cipher,
            )
            .with_vault(&self.vault_id)
            // The body pass is most of a first sync's requests, and its
            // `crdt_pull` bucket is the one the session widens most (x5).
            .with_bootstrap(Arc::clone(&bootstrap)),
        );

        let packs = Arc::new(
            PackBootstrap::new(counted, self.db.clone(), Arc::clone(&bodies))
                .with_vault(&self.vault_id)
                // Beside `data.db`: body packs wait here for their checks.
                .with_spill_dir(std::path::Path::new(&self.directory).join("pack-spill")),
        );
        let mut run = FirstSync::new(pull, bodies, self.db.clone())
            .with_bootstrap(bootstrap)
            .with_packs(packs)
            .with_diagnostics(diagnostics);
        if let Some(listener) = progress {
            run = run.with_progress(Arc::new(ForeignProgress(listener)));
        }
        Ok(run.run(now_ms()).await?.into())
    }

    /// One note's body, on demand (chapter 07 §7.8 – §7.11).
    ///
    /// **This is not an extra.** With partial pack coverage, [`Self::first_sync`]
    /// leaves the bodies outside the recent window owed until
    /// [`Self::drain_bodies`] reaches them (chapter 10 §10.6.1), and FR-028
    /// says "older content on demand": a note opened before then has its
    /// metadata and no body, and [`crate::api::notes::Notes::read`] answers
    /// `NoteBody { present: false }`. This call makes it readable now.
    ///
    /// **`async`**, and one document rather than the whole feed: a handful of
    /// round trips, not tens.
    ///
    /// A note this vault holds no **live** record of is refused rather than
    /// fetched, and the refusal is [`SyncError::UnknownNote`]. Chapter 07 §7.15:
    /// the server still answers with the surviving log of a deleted document,
    /// and applying it would resurrect body state for a note the record feed
    /// says is gone. The liveness check is the same read the note view makes,
    /// so the two can never disagree.
    pub async fn fetch_note_body(&self, note_id: String) -> Result<BodyFetchSummary, SyncError> {
        let wanted = note_id.clone();
        let live = self
            .db
            .call(move |conn| Ok(reads::document_exists(conn, &wanted)))
            .await?;
        if !live {
            return Err(SyncError::UnknownNote { id: note_id });
        }

        let cipher = self.cipher().await?;
        let report = BodyPull::new(
            self.session.http(),
            self.db.clone(),
            Declaration::subscribed(),
            cipher,
        )
        .with_vault(&self.vault_id)
        .pull_document(&note_id)
        .await?;
        Ok(report.into())
    }
}
