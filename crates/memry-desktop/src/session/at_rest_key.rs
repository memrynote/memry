//! The one owner of the open vault's at-rest key (Step 28, #3545, D3): the vault key the agent
//! conversation and message records are sealed under (`Vault::set_at_rest_key`, chapter 04
//! §4.17). Sync and the agent each hold an [`AtRestKeyGuard`] while they need the key. The first
//! guard installs it, and the key is removed when the last guard drops, the vault closes, or the
//! account signs out. Before this owner, sync removed the key whenever it stopped, which would
//! strip it from an agent in the middle of a session. A closed vault gets no key again, and a
//! vault never takes the key from another one that still has guards out.
//!
//! Sign-out removes the key but keeps the guards out as holders. The next acquire, after the next
//! sign-in, reads the keychain again and installs the key for all of them, so the key of the
//! account that signed out never outlives it. The agent's store (28d) acquires again on sign-in:
//! sync never acquires for an account it does not start for.
//!
//! It never mints a key: the vault key is derived from the master key in the keychain, and
//! `Vault::set_at_rest_key` refuses one that does not match the vault's stored verifier, so
//! another account's key never opens this vault's records.

use std::sync::{Arc, Mutex, Weak};

use memry_core::api::errors::{CryptoError, SecureStoreError, StorageError, SyncError};
use memry_core::api::vault::Vault;
use memry_core::crypto::keys::derive_vault_key;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use zeroize::Zeroizing;

/// Why the at-rest key could not be installed.
#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    /// The keychain holds no master key: the device is not set up for this account.
    #[error("the keychain holds no master key")]
    Absent,
    /// The keychain did not answer, or refused (`Locked` while a prompt is open).
    #[error(transparent)]
    SecureStore(#[from] SecureStoreError),
    #[error(transparent)]
    Crypto(#[from] CryptoError),
    /// The vault refused the key (its verifier differs) or could not seal pending records.
    #[error(transparent)]
    Storage(#[from] StorageError),
    /// The vault closed; a caller that comes late gets no key for it.
    #[error("the vault is closed")]
    Closed,
    /// Another vault holds the key and has guards out.
    #[error("another vault holds the at-rest key")]
    Busy,
}

impl From<KeyError> for SyncError {
    fn from(error: KeyError) -> Self {
        match error {
            KeyError::Absent => SyncError::Locked,
            KeyError::SecureStore(error) => error.into(),
            KeyError::Crypto(error) => error.into(),
            KeyError::Storage(error) => error.into(),
            // The vault is closing or another one is open: this sync session has ended, as the
            // backend's own closed-generation check reports.
            KeyError::Closed | KeyError::Busy => SyncError::Locked,
        }
    }
}

/// The session's at-rest key owner, shared by sync and the agent.
pub struct AtRestKeys {
    store: Arc<dyn SecureStore>,
    slot: Mutex<Slot>,
}

/// The vault the key is for, how many guards hold it, and whether it is installed (sign-out
/// removes it under its guards). `generation` changes when the vault changes or closes, so a
/// guard of an earlier one releases nothing. `closed` names the vaults that closed while
/// something still holds them.
#[derive(Default)]
struct Slot {
    vault: Weak<Vault>,
    holders: usize,
    installed: bool,
    generation: u64,
    closed: Vec<Weak<Vault>>,
}

impl Slot {
    /// Forgets the vault and invalidates every guard out.
    fn reset(&mut self) {
        self.vault = Weak::new();
        self.holders = 0;
        self.installed = false;
        self.generation += 1;
    }

    /// Removes the key from the vault, leaving the guards out.
    fn uninstall(&mut self) {
        if std::mem::take(&mut self.installed)
            && let Some(vault) = self.vault.upgrade()
        {
            remove(&vault);
        }
    }
}

/// Holds the key installed in its vault. Dropping the last one removes it.
pub struct AtRestKeyGuard {
    keys: Arc<AtRestKeys>,
    generation: u64,
}

impl AtRestKeys {
    pub fn new(store: Arc<dyn SecureStore>) -> Arc<Self> {
        Arc::new(Self {
            store,
            slot: Mutex::default(),
        })
    }

    /// Installs the key in `vault` unless it is installed there. Blocking: the keychain
    /// can wait on an access prompt, and installing seals the records a pull stored without a key.
    /// Installs run one at a time, so two callers never read the keychain twice for one vault.
    pub fn acquire(self: &Arc<Self>, vault: &Arc<Vault>) -> Result<AtRestKeyGuard, KeyError> {
        let mut slot = crate::session::lock(&self.slot);
        // A dropped vault can never be acquired again, so its entry is no longer needed.
        slot.closed.retain(|closed| closed.strong_count() > 0);
        let target = Arc::downgrade(vault);
        if slot.closed.iter().any(|closed| closed.ptr_eq(&target)) {
            return Err(KeyError::Closed);
        }
        if !slot.vault.ptr_eq(&target) {
            if slot.holders > 0 && slot.vault.strong_count() > 0 {
                return Err(KeyError::Busy);
            }
            slot.uninstall();
            slot.reset();
            slot.vault = target;
        }
        if !slot.installed {
            self.install(vault)?;
            slot.installed = true;
        }
        slot.holders += 1;
        Ok(AtRestKeyGuard {
            keys: Arc::clone(self),
            generation: slot.generation,
        })
    }

    /// The vault closes: its key goes now, whatever guards are still out, and it gets no key
    /// again. Those guards release nothing.
    pub fn close(&self, vault: &Arc<Vault>) {
        let mut slot = crate::session::lock(&self.slot);
        let closed = Arc::downgrade(vault);
        if slot.vault.ptr_eq(&closed) {
            slot.uninstall();
            slot.reset();
        }
        slot.closed.push(closed);
    }

    /// Sign-out: the key goes now, whatever guards are still out. Those stay holders: the vault
    /// stays open, and the next [`acquire`](Self::acquire) reads the keychain again and installs
    /// the key for every holder.
    pub fn clear(&self) {
        crate::session::lock(&self.slot).uninstall();
    }

    fn install(&self, vault: &Vault) -> Result<(), KeyError> {
        let master = Zeroizing::new(
            self.store
                .get(SecureStoreKey::MasterKey)?
                .ok_or(KeyError::Absent)?,
        );
        let vault_key = derive_vault_key(&master)?;
        let key: [u8; 32] = vault_key.as_slice().try_into().map_err(|_| {
            KeyError::Crypto(CryptoError::InvalidLength {
                what: "vault key".to_owned(),
                expected: 32,
                actual: vault_key.len() as u64,
            })
        })?;
        let sealed = vault.set_at_rest_key(Some(Zeroizing::new(key)))?;
        if sealed.wal_kept {
            tracing::info!(
                records = sealed.records,
                "sealed pending agent records; the WAL keeps their old pages until a checkpoint"
            );
        }
        Ok(())
    }
}

impl Drop for AtRestKeyGuard {
    fn drop(&mut self) {
        let mut slot = crate::session::lock(&self.keys.slot);
        if slot.generation != self.generation {
            return;
        }
        slot.holders = slot.holders.saturating_sub(1);
        if slot.holders == 0 {
            slot.uninstall();
        }
    }
}

fn remove(vault: &Vault) {
    if let Err(error) = vault.set_at_rest_key(None) {
        tracing::warn!(%error, "could not clear the at-rest key");
    }
}
