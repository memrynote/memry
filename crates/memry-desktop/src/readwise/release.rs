//! The old device's side of a takeover (`apps/desktop/src/main/readwise/release.ts`, D8): once
//! another device holds the claim, this one deletes its copy of the token and its run state, so
//! it can neither pull nor resume from a stale cursor if the user takes Readwise back later.
//! Every note and link stays (D9).
//!
//! [`ClaimGate`] is the claim half of the run's [`RunGate`]: the engine reads
//! [`RunGate::claim_lost`] before each book and stops there, then calls
//! [`RunGate::on_claim_lost`]. The scheduler (33e) calls
//! [`ClaimGate::release_if_claimed_elsewhere`] when the claim moves while no run is in flight.

use std::sync::Arc;

use memry_core::api::errors::{SecureStoreError, StorageError};
use memry_core::api::readwise::ReadwiseStore;

use super::claim::Claim;
use super::run_types::RunGate;
use super::token::ReadwiseToken;

const SCOPE: &str = "Readwise:Release";

/// The registered sync device id while sync is on, else `None` ([`Claim::held_elsewhere`]).
pub type ThisDevice = Arc<dyn Fn() -> Option<String> + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum ReleaseError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Keychain(#[from] SecureStoreError),
}

pub struct ClaimGate {
    store: ReadwiseStore,
    token: ReadwiseToken,
    this_device: ThisDevice,
}

impl ClaimGate {
    pub fn new(store: ReadwiseStore, token: ReadwiseToken, this_device: ThisDevice) -> Self {
        Self {
            store,
            token,
            this_device,
        }
    }

    fn held_elsewhere(&self) -> Result<bool, StorageError> {
        Ok(Claim::read(&self.store)?.held_elsewhere((self.this_device)().as_deref()))
    }

    /// `releaseTokenIfClaimedElsewhere`: true when it dropped a token. Blocking (the keychain).
    pub fn release_if_claimed_elsewhere(&self) -> Result<bool, ReleaseError> {
        if !self.held_elsewhere()? {
            return Ok(false);
        }
        let had_token = self.token.read()?.is_some();
        self.token.disconnect()?;
        self.store.clear_run_state()?;
        if had_token {
            tracing::info!(
                scope = SCOPE,
                "Readwise now syncs on another device; this device dropped its token"
            );
        }
        Ok(had_token)
    }
}

impl RunGate for ClaimGate {
    /// A claim that cannot be read stops the run: pulling beside another device rewrites its
    /// notes, a stopped run only waits for the next one. The release reads it again.
    fn claim_lost(&self) -> bool {
        self.held_elsewhere().unwrap_or_else(|error| {
            tracing::warn!(scope = SCOPE, "could not read the Readwise claim: {error}");
            true
        })
    }

    fn on_claim_lost(&self) {
        if let Err(error) = self.release_if_claimed_elsewhere() {
            tracing::warn!(
                scope = SCOPE,
                "could not drop the Readwise token after a takeover: {error}"
            );
        }
    }
}
