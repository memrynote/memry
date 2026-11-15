//! The seams the supervisor runs through: [`SyncBackend`] opens a driver for the open vault, and
//! [`SyncPasses`] is the driver as the supervisor uses it. `SyncDriver` and [`VaultSyncBackend`]
//! are the real ones; tests put fakes behind both.

use std::sync::{Arc, Mutex};

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
    async fn auth_facts(&self) -> AuthFacts;
    /// A driver for the open vault. Fails offline (it fetches the device directory) and on a
    /// vault bound to no server vault; the supervisor retries on the next trigger.
    async fn open(&self) -> Result<Arc<dyn SyncPasses>, SyncError>;
    /// The driver was dropped, or never kept: forget the at-rest key.
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
    /// Bumped by each close, under this lock: a key install that a close overtook (the pass was
    /// aborted, its blocking install was not) installs nothing.
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
    ) -> Self {
        Self {
            vault,
            session,
            store,
            reachability,
            seeds,
            account,
            closes: Arc::default(),
        }
    }
}

#[async_trait::async_trait]
impl SyncBackend for VaultSyncBackend {
    async fn auth_facts(&self) -> AuthFacts {
        let (signed_in, recovery_confirmed) = (self.account)();
        // The keychain can block on an access prompt: off the async workers, and the key it
        // hands back is zeroed on drop.
        let store = Arc::clone(&self.store);
        let key_verified = tokio::task::spawn_blocking(move || {
            store
                .get(SecureStoreKey::MasterKey)
                .map(|key| key.map(Zeroizing::new).is_some())
        })
        .await;
        AuthFacts {
            signed_in,
            key_verified: matches!(key_verified, Ok(Ok(true))),
            recovery_confirmed,
        }
    }

    async fn open(&self) -> Result<Arc<dyn SyncPasses>, SyncError> {
        let vault = Arc::clone(&self.vault);
        let store = Arc::clone(&self.store);
        let closes = Arc::clone(&self.closes);
        let generation = *crate::session::lock(&self.closes);
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
            let closed = crate::session::lock(&closes);
            if *closed != generation {
                return Err(SyncError::Locked);
            }
            vault.set_at_rest_key(Some(Zeroizing::new(key)))?;
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
            )
            .await
            .inspect_err(|_| self.close())?;
        Ok(Arc::new(driver))
    }

    fn close(&self) {
        let mut closes = crate::session::lock(&self.closes);
        *closes += 1;
        if let Err(error) = self.vault.set_at_rest_key(None) {
            tracing::warn!(%error, "could not clear the at-rest key");
        }
    }
}
