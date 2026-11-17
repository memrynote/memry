//! Opening the store on the vault key. The key comes from the session's owner
//! ([`crate::session::at_rest_key`]), which derives it from the keychain's master key and refuses
//! one that does not match the vault's verifier; this module never mints one. A keychain that does
//! not answer (`Locked`, a timeout) is retried when it recovers, and new writes then go to disk.
//! An absent master key or a refused key leaves the store in memory for the session.

use std::sync::{Arc, Weak};

use memry_core::api::vault::Vault;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;

use super::ephemeral::Ephemeral;
use super::gate::EntitlementGate;
use super::sealed::Sealed;
use super::{AgentStore, ChatRecords};
use crate::session::at_rest_key::{AtRestKeyGuard, AtRestKeys, KeyError};

/// What [`AgentStore::open`] is built from.
pub struct StoreParts {
    pub vault: Arc<Vault>,
    pub keys: Arc<AtRestKeys>,
    /// This device's id, the clock key of its writes.
    pub device_id: String,
    pub gate: EntitlementGate,
    /// Fired by `KeyringStore::subscribe_recovered`.
    pub keychain_recovered: broadcast::Receiver<()>,
}

impl AgentStore {
    /// Opens the store. Blocking: reading the keychain can wait on a prompt. `runtime` runs the
    /// retry after a keychain that did not answer.
    pub fn open(parts: StoreParts, runtime: &tokio::runtime::Handle) -> Arc<Self> {
        let StoreParts {
            vault,
            keys,
            device_id,
            gate,
            keychain_recovered,
        } = parts;
        let sealed = SealedParts {
            vault: Arc::clone(&vault),
            device_id,
            gate,
        };
        let error = match keys.acquire(&vault) {
            Ok(guard) => return Arc::new(Self::over(sealed.with(guard), true)),
            Err(error) => error,
        };
        let store = Arc::new(Self::over(Arc::new(Ephemeral::default()), false));
        if let KeyError::SecureStore(_) = error {
            tracing::warn!(%error, "agent chat history kept in memory until the keychain answers");
            runtime.spawn(retry_on_recovery(
                Arc::downgrade(&store),
                keys,
                sealed,
                keychain_recovered,
            ));
        } else {
            tracing::warn!(%error, "agent chat history kept in memory: no usable vault key");
        }
        store
    }
}

/// What the on-disk records are built from once a key is held.
struct SealedParts {
    vault: Arc<Vault>,
    device_id: String,
    gate: EntitlementGate,
}

impl SealedParts {
    fn with(&self, guard: AtRestKeyGuard) -> Arc<dyn ChatRecords> {
        Arc::new(Sealed {
            db: self.vault.db_handle(),
            key: self.vault.at_rest_key(),
            device_id: self.device_id.clone(),
            gate: self.gate.clone(),
            _guard: guard,
        })
    }
}

/// Waits for the keychain to recover, then moves the store to disk. Ends when the store is gone,
/// the key is installed, or the read fails for a reason a retry does not fix.
async fn retry_on_recovery(
    store: Weak<AgentStore>,
    keys: Arc<AtRestKeys>,
    sealed: SealedParts,
    mut recovered: broadcast::Receiver<()>,
) {
    loop {
        match recovered.recv().await {
            Ok(()) | Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => return,
        }
        if store.strong_count() == 0 {
            return;
        }
        let (keys, vault) = (Arc::clone(&keys), Arc::clone(&sealed.vault));
        let acquired = tokio::task::spawn_blocking(move || keys.acquire(&vault)).await;
        let Some(store) = store.upgrade() else {
            return;
        };
        match acquired {
            Ok(Ok(guard)) => {
                store.persist(sealed.with(guard));
                tracing::info!("agent chat history persists again");
                return;
            }
            Ok(Err(KeyError::SecureStore(error))) => {
                tracing::warn!(%error, "the keychain still does not give the vault key");
            }
            Ok(Err(error)) => {
                tracing::warn!(%error, "agent chat history stays in memory");
                return;
            }
            Err(error) => {
                tracing::warn!(%error, "the at-rest key task failed");
                return;
            }
        }
    }
}
