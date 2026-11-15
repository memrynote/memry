//! The seams the supervisor runs through: [`SyncBackend`] opens a driver for the open vault, and
//! [`SyncPasses`] is the driver as the supervisor uses it. `SyncDriver` and [`VaultSyncBackend`]
//! are the real ones; tests put fakes behind both.

use std::sync::Arc;

use memry_core::api::auth::AuthSession;
use memry_core::api::errors::SyncError;
use memry_core::api::vault::Vault;
use memry_core::crypto::keys::derive_vault_key;
use memry_core::seams::reachability::Reachability;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::sync::driver::{DriverConfig, SyncDriver};
use memry_core::sync::engine::{PassReport, PassSeed};
use memry_core::sync::policy::ServerClock;
use memry_core::sync::state::PassTrigger;
use zeroize::Zeroizing;

use super::gate::AuthFacts;

#[async_trait::async_trait]
pub trait SyncPasses: Send + Sync {
    /// One pass; `None` while paused.
    async fn run_pass(&self, trigger: PassTrigger) -> Option<PassReport>;
    fn pause(&self);
    fn resume(&self);
    fn set_entitled(&self, entitled: bool);
    fn server_clock(&self) -> Option<ServerClock>;
}

#[async_trait::async_trait]
impl SyncPasses for SyncDriver {
    async fn run_pass(&self, trigger: PassTrigger) -> Option<PassReport> {
        SyncDriver::run_pass(self, trigger).await
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
}

#[async_trait::async_trait]
pub trait SyncBackend: Send + Sync {
    /// The account side of the gate, read at each start attempt.
    fn auth_facts(&self) -> AuthFacts;
    /// A driver for the open vault. Fails offline (it fetches the device directory) and on a
    /// vault bound to no server vault; the supervisor retries on the next trigger.
    async fn open(&self) -> Result<Arc<dyn SyncPasses>, SyncError>;
    /// The driver was dropped: forget the at-rest key.
    fn close(&self);
}

/// The open vault's backend over the app's session and keychain.
pub struct VaultSyncBackend {
    pub vault: Arc<Vault>,
    pub session: Arc<AuthSession>,
    pub store: Arc<dyn SecureStore>,
    pub reachability: Arc<dyn Reachability>,
    pub seeds: Vec<Arc<dyn PassSeed>>,
    /// `sync.recoveryPhraseConfirmed != false` and signed in, read from the account service.
    pub account: Arc<dyn Fn() -> (bool, bool) + Send + Sync>,
}

#[async_trait::async_trait]
impl SyncBackend for VaultSyncBackend {
    fn auth_facts(&self) -> AuthFacts {
        let (signed_in, recovery_confirmed) = (self.account)();
        AuthFacts {
            signed_in,
            key_verified: matches!(self.store.get(SecureStoreKey::MasterKey), Ok(Some(_))),
            recovery_confirmed,
        }
    }

    async fn open(&self) -> Result<Arc<dyn SyncPasses>, SyncError> {
        let vault = Arc::clone(&self.vault);
        let store = Arc::clone(&self.store);
        // The at-rest key is the vault key, installed only while the master key is readable.
        tokio::task::spawn_blocking(move || -> Result<(), SyncError> {
            let master = Zeroizing::new(
                store
                    .get(SecureStoreKey::MasterKey)?
                    .ok_or(SyncError::Locked)?,
            );
            let vault_key = derive_vault_key(&master)?;
            let key: [u8; 32] = vault_key
                .as_slice()
                .try_into()
                .map_err(|_| SyncError::Locked)?;
            vault.set_at_rest_key(Some(Zeroizing::new(key)))?;
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
            )
            .await?;
        Ok(Arc::new(driver))
    }

    fn close(&self) {
        if let Err(error) = self.vault.set_at_rest_key(None) {
            tracing::warn!(%error, "could not clear the at-rest key");
        }
    }
}
