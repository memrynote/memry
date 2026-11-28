//! Does the keychain's master key still belong to the account? Ported from Electron's
//! `sync/key-verification.ts` (`checkLocalKeyAgainstAccount`), `crypto/vault-key-error.ts`
//! (`classifyVaultKeyError`, `vaultRecoveryReason`) and the account step of the startup integrity
//! check (`ipc/sync-core-handlers.ts:163-180`).
//!
//! A master key that does not match the account can never decrypt its data, and sync with it
//! would brand every pulled item corrupt and push data no other device can read. A confirmed
//! mismatch sends the user to recovery (`SyncVaultRecoveryNeededEvent`) and signs out the
//! `integrity` way, which keeps the master key and the queue; an uncertain read never acts.
//!
//! Departure: Electron stands down for 2 minutes after a flow touched key material
//! (`KEY_MATERIAL_ACTIVITY_WINDOW_MS`). Here every key-changing flow holds `key_op` from its first
//! key write to its last, so `Transition` means that lock is held, and the integrity check waits
//! for it and then reads the final key.

use std::sync::{Arc, Mutex};

use memry_core::api::errors::AuthError;
use memry_core::crypto::keys;
use memry_core::seams::secure_store::SecureStoreKey;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

use super::teardown::Reason;
use super::{AccountError, AccountService};
use crate::session::Session;

/// `AccountKeyCheck`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountKeyCheck {
    /// Verified against the account's verifier: safe to sync.
    Match,
    /// The local key can never decrypt this account's data: recovery, never sync.
    Mismatch,
    /// A key-changing flow runs now; its key may be mid-swap.
    Transition,
    /// Cannot tell now (no readable key, offline with no cached verifier): proceed, never act.
    Unknown,
}

/// `VaultKeyErrorKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultKeyErrorKind {
    /// The master key cannot decrypt this vault, or is gone while a verifier exists.
    RecoveryNeeded,
    /// A secret could not be read this run; a later read may succeed. Never a recovery case.
    Transient,
    Other,
}

/// `VaultRecoveryNeededEvent['reason']` (`packages/contracts/src/ipc-events.ts:250`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum VaultRecoveryReason {
    VaultKeyMismatch,
    MasterKeyMissing,
}

/// Told each time the user must recover the account's key.
pub type OnVaultRecoveryNeeded = Arc<dyn Fn(VaultRecoveryReason) + Send + Sync>;

/// The listener slot the shell fills (`broadcastToAllWindows(VAULT_RECOVERY_NEEDED)`).
#[derive(Default)]
pub(super) struct RecoveryListener(Mutex<Option<OnVaultRecoveryNeeded>>);

/// `classifyVaultKeyError` (`crypto/vault-key-error.ts:23-44`), over the error's message.
pub fn classify_vault_key_error(message: &str) -> VaultKeyErrorKind {
    if is_keychain_unreadable_error(message) {
        return VaultKeyErrorKind::Transient;
    }
    if message.contains("does not match this vault")
        || message.contains("verifier exists but master key is missing")
        || message.contains("cannot create a local vault key while sync credentials exist")
    {
        return VaultKeyErrorKind::RecoveryNeeded;
    }
    VaultKeyErrorKind::Other
}

/// `isKeychainUnreadableError` (`crypto/vault-key-error.ts:53-60`).
pub fn is_keychain_unreadable_error(message: &str) -> bool {
    message.contains("could not be read this run")
        || message.contains("OS keychain did not answer within")
        || message.contains("OS keychain is unavailable")
}

/// `vaultRecoveryReason` (`crypto/vault-key-error.ts:62-67`).
pub fn vault_recovery_reason(message: &str) -> VaultRecoveryReason {
    if message.contains("master key is missing") || message.contains("Master key not found") {
        VaultRecoveryReason::MasterKeyMissing
    } else {
        VaultRecoveryReason::VaultKeyMismatch
    }
}

impl AccountService {
    /// Sets the one listener [`Self::raise_vault_recovery_needed`] tells.
    pub fn on_vault_recovery_needed(&self, listener: OnVaultRecoveryNeeded) {
        *crate::session::lock(&self.recovery.0) = Some(listener);
    }

    /// Tells the listener when `error` (a vault key that failed to open) needs recovery, as
    /// `agent/bootstrap.ts:89` and `sync/runtime.ts:463` do; `true` when it did.
    pub fn raise_vault_recovery_needed(&self, error: &str) -> bool {
        if classify_vault_key_error(error) != VaultKeyErrorKind::RecoveryNeeded {
            return false;
        }
        self.emit_vault_recovery_needed(vault_recovery_reason(error));
        true
    }

    fn emit_vault_recovery_needed(&self, reason: VaultRecoveryReason) {
        let listener = crate::session::lock(&self.recovery.0).clone();
        match listener {
            Some(listener) => listener(reason),
            None => tracing::error!(
                scope = "Sync",
                ?reason,
                "vault recovery is needed and no window listens"
            ),
        }
    }

    /// `checkLocalKeyAgainstAccount`: `Transition` while a key-changing flow runs.
    pub async fn check_local_key_against_account(&self) -> AccountKeyCheck {
        let Ok(_op) = self.key_op.try_lock() else {
            return AccountKeyCheck::Transition;
        };
        self.compare_local_key().await
    }

    /// The account step of `checkSyncIntegrity`, run before sync attaches: after any key-changing
    /// flow in flight, a registered device whose master key is confirmed not the account's asks
    /// for recovery and signs out the `integrity` way. Returns what the check found.
    pub async fn check_sync_integrity(
        &self,
        session: &Session,
    ) -> Result<AccountKeyCheck, AccountError> {
        // `sync_devices` holds no current-device row: nothing is registered to check.
        if self.device_id().is_none() {
            return Ok(AccountKeyCheck::Unknown);
        }
        let op = self.key_op.lock().await;
        let check = self.compare_local_key().await;
        if check != AccountKeyCheck::Mismatch {
            return Ok(check);
        }
        tracing::error!(
            scope = "Sync",
            "master key does not match the account, signing out so recovery can restore it"
        );
        self.emit_vault_recovery_needed(VaultRecoveryReason::VaultKeyMismatch);
        let _term = self.epoch.end();
        let signed_out = self.teardown(session, Reason::Integrity).await?;
        drop(op);
        if let Some(warning) = signed_out.keychain_warning() {
            tracing::warn!(scope = "Sync", "{warning}");
        }
        Ok(check)
    }

    /// The keychain's master key against the account verifier. The caller holds `key_op`.
    async fn compare_local_key(&self) -> AccountKeyCheck {
        let store = Arc::clone(&self.store);
        // The keychain can block on an access prompt: off the async workers. A failed read is
        // never an absent key, so it is `Unknown` too.
        let local = tokio::task::spawn_blocking(move || {
            let key = Zeroizing::new(store.get(SecureStoreKey::MasterKey).ok()??);
            keys::account_key_verifier(&key).ok()
        })
        .await
        .ok()
        .flatten();
        let Some(local) = local else {
            return AccountKeyCheck::Unknown;
        };
        let Some(account) = self.account_key_verifier().await else {
            return AccountKeyCheck::Unknown;
        };
        if keys::account_key_verifier_matches(&local, &account) {
            AccountKeyCheck::Match
        } else {
            AccountKeyCheck::Mismatch
        }
    }

    /// `resolveAccountKeyVerifier`: `sync.accountKeyVerifier`, else `GET /auth/key-verifier`
    /// cached there for offline checks; `None` when it cannot be known now.
    async fn account_key_verifier(&self) -> Option<String> {
        let cached = self.config.read(|config| {
            config
                .get("sync")
                .and_then(|sync| sync.get("accountKeyVerifier"))
                .and_then(Value::as_str)
                .filter(|verifier| !verifier.is_empty())
                .map(str::to_owned)
        });
        if cached.is_some() {
            return cached;
        }
        let term = self.term()?;
        match self.session.valid_access_token().await {
            Ok(Some(_)) => {}
            Ok(None) | Err(AuthError::SessionExpired) => return None,
            Err(error) => {
                tracing::debug!(scope = "Sync", "no token for the key verifier: {error}");
                return None;
            }
        }
        let verifier = match self.session.key_material().await {
            Ok(material) if !material.key_verifier.is_empty() => material.key_verifier,
            Ok(_) => return None,
            Err(error) => {
                tracing::debug!(scope = "Sync", "account key verifier unavailable: {error}");
                return None;
            }
        };
        let cache = self.write_in_term(term, || {
            self.write_sync(|sync| {
                sync.insert("accountKeyVerifier".into(), Value::from(verifier.as_str()));
            })
        });
        match cache {
            // Signed out meanwhile: the verifier belongs to an account this install left.
            None => return None,
            Some(Err(error)) => tracing::warn!(
                scope = "Sync",
                "the account key verifier could not be cached: {error}"
            ),
            Some(Ok(())) => {}
        }
        Some(verifier)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MISMATCH: &str = "Current master key does not match this vault";
    const MISSING: &str = "Vault key verifier exists but master key is missing";

    /// `vault-key-error.test.ts`, message for message.
    #[test]
    fn classifies_every_message_as_electron_does() {
        use VaultKeyErrorKind::*;
        assert_eq!(classify_vault_key_error(MISMATCH), RecoveryNeeded);
        assert_eq!(classify_vault_key_error(MISSING), RecoveryNeeded);
        assert_eq!(
            classify_vault_key_error(
                "Secret com.memry.sync/master-key exists in the secret store but could not be read this run; refusing to report it as absent"
            ),
            Transient
        );
        for unreadable in [
            "Failed to retrieve key from keychain (master-key): OS keychain did not answer within 5000ms for com.memry.sync/master-key",
            "Failed to retrieve key from keychain (refresh-token): OS keychain is unavailable until it answers an earlier request (com.memry.sync/refresh-token)",
            "Failed to retrieve key from keychain (refresh-token): OS keychain is unavailable for the rest of this run (com.memry.sync/refresh-token)",
        ] {
            assert!(is_keychain_unreadable_error(unreadable));
            assert_eq!(classify_vault_key_error(unreadable), Transient);
        }
        for readable in [MISMATCH, MISSING, "network down"] {
            assert!(!is_keychain_unreadable_error(readable));
        }
        assert_eq!(classify_vault_key_error("network down"), Other);
        assert_eq!(classify_vault_key_error("not an error object"), Other);
    }

    #[test]
    fn maps_the_reason_for_the_renderer_event() {
        assert_eq!(
            vault_recovery_reason(MISMATCH),
            VaultRecoveryReason::VaultKeyMismatch
        );
        assert_eq!(
            vault_recovery_reason(MISSING),
            VaultRecoveryReason::MasterKeyMissing
        );
        let restorable = "Master key not found in keychain \u{2014} cannot create a local vault key while sync credentials exist";
        assert_eq!(
            classify_vault_key_error(restorable),
            VaultKeyErrorKind::RecoveryNeeded
        );
        assert_eq!(
            vault_recovery_reason(restorable),
            VaultRecoveryReason::MasterKeyMissing
        );
        assert_eq!(
            serde_json::to_value(VaultRecoveryReason::MasterKeyMissing).unwrap(),
            "master-key-missing"
        );
    }
}
