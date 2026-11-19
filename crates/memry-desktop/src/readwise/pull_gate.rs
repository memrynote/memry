//! Who pulls from Readwise (`apps/desktop/src/main/readwise/pull-gate.ts`, D8). Notes ride memry
//! sync and a write replaces the whole body, so two devices pulling, or a device pulling before
//! it holds the others' notes, duplicates books. [`PullGate`] is the run's [`RunGate`]: the
//! engine awaits [`RunGate::await_ready`] before it reads Readwise, so every caller (the
//! scheduler, the import dialog) is held to the same rule.
//!
//! Two devices that claim at once both write `syncDeviceId`. Electron has no tie-break of its
//! own, and none is needed: a `settings` push is never refused (protocol §5.7), so the server
//! holds one row, the last push, and §6.3's "remote wins a tie" makes every device take that
//! row on its next pull. The claim converges to the device whose push the server took last.
//!
//! **Departure:** Electron pulls as soon as its claim is delivered. If a peer's claim lands on
//! the server after that push, both devices pull until their next sync pull, and both rewrite
//! the same notes. This gate waits for one more sync pull after the delivery and reads the
//! claim again, so the device whose push the server took first stops before its first book.

use std::sync::Arc;
use std::time::Duration;

use memry_core::api::readwise::ReadwiseStore;
use memry_core::api::settings::Settings;
use tokio_util::sync::CancellationToken;

use super::claim::{Claim, write_claim};
use super::release::{ClaimGate, ThisDevice};
use super::run_types::{RunError, RunGate, failed};
use super::token::ReadwiseToken;

const SCOPE: &str = "Readwise:PullGate";

/// `POLL_MS`.
const POLL: Duration = Duration::from_millis(500);
/// `READY_TIMEOUT_MS` (2 minutes) in polls.
const READY_POLLS: u32 = 240;
/// `PUSH_TIMEOUT_MS` (30 s) in polls; also the wait for the confirming pull.
const PUSH_POLLS: u32 = 60;

/// `PullEnv`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PullEnv {
    /// The sync runtime reached a verdict for the open vault.
    pub decided: bool,
    /// Memry sync runs on this install.
    pub eligible: bool,
    /// A memry sync pull completed since the runtime started.
    pub pulled: bool,
    /// The registered sync device id, `None` before registration.
    pub device_id: Option<String>,
}

/// What the gate reads from memry sync: `readPullEnv`, `SyncEngineView` and the index build.
pub trait SyncView: Send + Sync {
    fn env(&self) -> PullEnv;
    /// `isCaughtUpWithServer`.
    fn caught_up(&self) -> bool;
    fn request_push(&self);
    /// `hasQueuedItem('synced_settings')`.
    fn settings_queued(&self) -> bool;
    /// Sync passes that pulled since the runtime started.
    fn completed_pulls(&self) -> u64;
    /// `readCurrentDeviceName`.
    fn device_name(&self) -> Option<String>;
    /// The open's index build is running (`waitForVaultIndexBuild`).
    fn indexing(&self) -> bool;
}

/// `PullAuthority`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Authority {
    Pull,
    /// Sync's verdict or its first pull is not in yet. Ask again later.
    Wait,
    /// Sync is on and nobody claims Readwise. The first run claims it.
    ClaimNeeded,
    Elsewhere(Option<String>),
}

/// `pullAuthority`.
pub fn authority(env: &PullEnv, claim: &Claim) -> Authority {
    if !env.decided {
        return Authority::Wait;
    }
    // Sync off: no peer to race, so no claim, and this device pulls.
    if !env.eligible {
        return Authority::Pull;
    }
    let Some(this) = env.device_id.as_deref() else {
        return Authority::Wait;
    };
    if claim
        .device_id
        .as_deref()
        .is_some_and(|holder| holder != this)
    {
        return Authority::Elsewhere(claim.device_name.clone());
    }
    match (env.pulled, claim.device_id.is_some()) {
        (false, _) => Authority::Wait,
        (true, false) => Authority::ClaimNeeded,
        (true, true) => Authority::Pull,
    }
}

/// `PullGateErrorCode`: a run that sync's state does not allow. The run is skipped, not failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PullGateError {
    #[error("Readwise pull gate: elsewhere")]
    Elsewhere(Option<String>),
    #[error("Readwise pull gate: not-ready")]
    NotReady,
    #[error("Readwise pull gate: needs-sync")]
    NeedsSync,
    #[error("Readwise pull gate: claim-not-delivered")]
    ClaimNotDelivered,
}

impl PullGateError {
    /// `ReadwisePullGateError.code`, the telemetry error code.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Elsewhere(_) => "elsewhere",
            Self::NotReady => "not-ready",
            Self::NeedsSync => "needs-sync",
            Self::ClaimNotDelivered => "claim-not-delivered",
        }
    }
}

pub struct PullGate {
    claim: ClaimGate,
    settings: Arc<Settings>,
    sync: Arc<dyn SyncView>,
    poll: Duration,
}

impl PullGate {
    pub fn new(
        store: ReadwiseStore,
        settings: Arc<Settings>,
        token: ReadwiseToken,
        sync: Arc<dyn SyncView>,
    ) -> Self {
        let view = Arc::clone(&sync);
        // `claimLostToAnotherDevice`: only a registered device with sync on can lose the claim.
        let this_device: ThisDevice = Arc::new(move || {
            let env = view.env();
            env.eligible.then_some(env.device_id).flatten()
        });
        Self {
            claim: ClaimGate::new(store, token, this_device),
            settings,
            sync,
            poll: POLL,
        }
    }

    /// Tests poll faster; the timeouts stay the same number of polls.
    pub fn with_poll(mut self, poll: Duration) -> Self {
        self.poll = poll;
        self
    }

    /// The claim half, for the scheduler's release while no run is in flight.
    pub fn claim_gate(&self) -> &ClaimGate {
        &self.claim
    }

    /// `awaitPullAuthority`, plus the confirming pull (the module's departure). Returns `Ok` on
    /// cancel; the engine checks the signal next.
    fn await_authority(&self, cancel: &CancellationToken) -> Result<(), RunError> {
        let mut confirmed = false;
        let mut waited = 0;
        while !cancel.is_cancelled() {
            let env = self.sync.env();
            let claim = self.claim.claim().map_err(failed)?;
            match authority(&env, &claim) {
                Authority::Pull if !env.eligible || confirmed => return Ok(()),
                Authority::Pull => {
                    self.await_delivered(cancel)?;
                    self.await_next_pull(cancel)?;

                    confirmed = true;
                    continue;
                }
                Authority::Elsewhere(name) => return Err(PullGateError::Elsewhere(name).into()),
                Authority::ClaimNeeded => {
                    self.claim_this_device(&env)?;
                    continue;
                }
                Authority::Wait => {}
            }
            if waited >= READY_POLLS {
                tracing::info!(
                    scope = SCOPE,
                    ?env,
                    "Readwise run held back: memry sync has not completed a pull yet"
                );
                return Err(PullGateError::NotReady.into());
            }
            self.sleep(cancel);
            waited += 1;
        }
        Ok(())
    }

    /// `claimThisDevice`: writes the claim; the loop then waits for its delivery.
    fn claim_this_device(&self, env: &PullEnv) -> Result<(), RunError> {
        let Some(device_id) = env.device_id.as_deref().filter(|_| env.eligible) else {
            return Err(PullGateError::NeedsSync.into());
        };
        if !env.pulled || !self.sync.caught_up() {
            return Err(PullGateError::NotReady.into());
        }
        let name = self.sync.device_name();
        write_claim(&self.settings, device_id, name.as_deref()).map_err(failed)
    }

    /// `awaitClaimDelivered`: the claim sits in the settings queue until the server has it.
    fn await_delivered(&self, cancel: &CancellationToken) -> Result<(), RunError> {
        self.sync.request_push();
        for _ in 0..PUSH_POLLS {
            if cancel.is_cancelled() || !self.sync.settings_queued() {
                return Ok(());
            }
            self.sleep(cancel);
        }
        Err(PullGateError::ClaimNotDelivered.into())
    }

    /// One more sync pull after the delivery, so a peer's claim the server took after ours
    /// reaches this device before it reads Readwise.
    fn await_next_pull(&self, cancel: &CancellationToken) -> Result<(), RunError> {
        let delivered = self.sync.completed_pulls();
        self.sync.request_push();
        for _ in 0..PUSH_POLLS {
            if cancel.is_cancelled() || self.sync.completed_pulls() > delivered {
                return Ok(());
            }
            self.sleep(cancel);
        }
        Err(PullGateError::NotReady.into())
    }

    /// `waitForVaultIndexBuild`: the notes other devices wrote are found by `readwise_url`.
    fn await_index(&self, cancel: &CancellationToken) {
        while self.sync.indexing() && !cancel.is_cancelled() {
            self.sleep(cancel);
        }
    }

    fn sleep(&self, cancel: &CancellationToken) {
        if !cancel.is_cancelled() {
            std::thread::sleep(self.poll);
        }
    }
}

impl RunGate for PullGate {
    fn await_ready(&self, cancel: &CancellationToken) -> Result<(), RunError> {
        self.await_authority(cancel)?;
        self.await_index(cancel);
        Ok(())
    }

    fn claim_lost(&self) -> bool {
        self.claim.claim_lost()
    }

    fn on_claim_lost(&self) {
        self.claim.on_claim_lost();
    }
}
