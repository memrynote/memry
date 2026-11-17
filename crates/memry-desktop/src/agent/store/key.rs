//! Opening the store on the vault key. The key comes from the session's owner
//! ([`crate::session::at_rest_key`]), which derives it from the keychain's master key and refuses
//! one that does not match the vault's verifier; this module never mints one. A keychain that does
//! not answer (`Locked`, a timeout) is retried when it recovers, and the store then moves to disk
//! with what it kept in memory. An absent master key or a refused key leaves the store in memory
//! for the session. The retry holds neither the store nor the vault, and ends with the store.

use std::sync::{Arc, Weak};

use memry_core::api::vault::Vault;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;

use super::ephemeral::Ephemeral;
use super::gate::EntitlementGate;
use super::sealed::Sealed;
use super::{AgentStore, Records};
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
            vault: Arc::downgrade(&vault),
            device_id,
            gate,
        };
        let error = match keys.acquire(&vault) {
            Ok(guard) => return Arc::new(Self::over(Records::Disk(sealed.with(&vault, guard)))),
            Err(error) => error,
        };
        let store = Arc::new(Self::over(Records::Memory(Ephemeral::default())));
        if let KeyError::SecureStore(_) = error {
            tracing::warn!(%error, "agent chat history kept in memory until the keychain answers");
            let retry = runtime.spawn(retry_on_recovery(
                Arc::downgrade(&store),
                keys,
                Arc::new(sealed),
                keychain_recovered,
            ));
            // Set once, here, before anyone else sees the store.
            let _ = store.retry.set(retry.abort_handle());
        } else {
            tracing::warn!(%error, "agent chat history kept in memory: no usable vault key");
        }
        store
    }
}

/// What the on-disk records are built from once a key is held.
struct SealedParts {
    vault: Weak<Vault>,
    device_id: String,
    gate: EntitlementGate,
}

impl SealedParts {
    fn with(&self, vault: &Vault, guard: AtRestKeyGuard) -> Sealed {
        Sealed {
            db: vault.db_handle(),
            key: vault.at_rest_key(),
            device_id: self.device_id.clone(),
            gate: self.gate.clone(),
            _guard: guard,
        }
    }
}

/// Waits for the keychain to recover, then moves the store to disk. Ends when the store or the
/// vault is gone, the store is on disk, or the read fails for a reason a retry does not fix.
async fn retry_on_recovery(
    store: Weak<AgentStore>,
    keys: Arc<AtRestKeys>,
    sealed: Arc<SealedParts>,
    mut recovered: broadcast::Receiver<()>,
) {
    loop {
        match recovered.recv().await {
            Ok(()) | Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => return,
        }
        let Some(store) = store.upgrade() else {
            return;
        };
        let (keys, sealed) = (Arc::clone(&keys), Arc::clone(&sealed));
        match tokio::task::spawn_blocking(move || move_to_disk(&store, &keys, &sealed)).await {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                tracing::warn!(%error, "the at-rest key task failed");
                return;
            }
        }
    }
}

/// One attempt to move the store to disk. `true` when the keychain may answer later.
fn move_to_disk(store: &AgentStore, keys: &Arc<AtRestKeys>, sealed: &SealedParts) -> bool {
    let Some(vault) = sealed.vault.upgrade() else {
        return false;
    };
    match keys.acquire(&vault) {
        Ok(guard) => match store.persist(sealed.with(&vault, guard)) {
            Ok(()) => tracing::info!("agent chat history persists again"),
            Err(error) => {
                tracing::warn!(%error, "agent chat history stays in memory: it could not be written");
            }
        },
        Err(KeyError::SecureStore(error)) => {
            tracing::warn!(%error, "the keychain still does not give the vault key");
            return true;
        }
        Err(error) => tracing::warn!(%error, "agent chat history stays in memory"),
    }
    false
}
