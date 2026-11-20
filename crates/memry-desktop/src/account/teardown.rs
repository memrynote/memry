//! Sign-out (`teardownSession('logout')`, Electron `sync/session-teardown.ts:36-170`).
//!
//! Stops the open vault's sync, revokes the server session (best effort), deletes the five
//! keychain secrets (the session's store holds exactly them: master key, device key and the three
//! tokens; a keychain error still signs out and names the entries that stay), ends the open vault's sync session state, and empties `memry-config.json` `sync`
//! (`store.set('sync', {})`, `:119`). Vault files, the outbox and the CRDT store stay: editing
//! never depends on a session. The Google Calendar disconnect (Step 29) is not here.
//!
//! The `integrity` reason (`repairDeviceKeys` when the device cannot sign again, `:83-93`) keeps
//! the master key, makes no server call and keeps the vault's sync state: the queue, the sync
//! state and the history stay for the next sign-in. `memry-config.json` `sync` empties as for
//! `logout`.

use memry_core::api::auth::AuthState;
use memry_core::seams::secure_store::SecureStoreKey;
use serde_json::{Map, Value};

use super::{AccountError, AccountService};
use crate::seams::secure_store::account;
use crate::session::Session;

/// Electron's teardown order (`session-teardown.ts:82-94`), which the warning names entries in.
const TEARDOWN_ORDER: [SecureStoreKey; 5] = [
    SecureStoreKey::AccessToken,
    SecureStoreKey::RefreshToken,
    SecureStoreKey::SetupToken,
    SecureStoreKey::DeviceSigningKey,
    SecureStoreKey::MasterKey,
];

/// `TeardownResult`: the keychain entries that could not be removed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SignedOut {
    pub keychain_failures: Vec<String>,
    /// The session's own sign-out failed although every entry was deleted, and the session is
    /// not signed out.
    pub session_error: Option<String>,
    /// The sign-out marker could not be written while entries stayed: the next launch can
    /// restore the session the user ended (#4767).
    pub restore_risk: Option<String>,
}

impl SignedOut {
    /// `keychainWarning` (`ipc/account-handlers.ts:71-78`), or the session's own error when
    /// every entry went.
    pub fn keychain_warning(&self) -> Option<String> {
        if self.keychain_failures.is_empty() {
            return self
                .session_error
                .as_ref()
                .map(|error| format!("Sign-out did not finish: {error}"));
        }
        let failures = self.keychain_failures.join(", ");
        Some(match self.restore_risk {
            Some(_) => {
                format!("Failed to remove: {failures}; the app may sign back in at the next launch")
            }
            None => format!("Failed to remove: {failures}"),
        })
    }
}

/// `TeardownReason` without `shutdown` (quit stops sync elsewhere).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Reason {
    Logout,
    Integrity,
}

impl AccountService {
    /// `sync:auth-logout` and `account:signOut`, one teardown. Runs after any key-changing
    /// operation in flight, never beside one.
    pub async fn sign_out(&self, session: &Session) -> Result<SignedOut, AccountError> {
        // First: a write that started under this account and waits on the network lands nowhere,
        // and none starts until the teardown is done (the guard ends the term again on drop).
        let _term = self.epoch.end();
        let _op = self.key_op.lock().await;
        self.teardown(session, Reason::Logout).await
    }

    /// `performTeardown(reason)`. The caller holds `key_op` and has ended the account's term.
    pub(super) async fn teardown(
        &self,
        session: &Session,
        reason: Reason,
    ) -> Result<SignedOut, AccountError> {
        tracing::info!(
            scope = "SessionTeardown",
            ?reason,
            "session teardown started"
        );
        let stopping = session.clone();
        // The supervisor stops within `STOP_WAIT`; blocking, so off the async workers.
        if let Err(error) = tokio::task::spawn_blocking(move || stopping.detach_sync()).await {
            tracing::warn!(scope = "SessionTeardown", "sync did not stop: {error}");
        }
        if let Err(error) = self.end_oauth_attempt() {
            tracing::warn!(
                scope = "SessionTeardown",
                "the Google attempt did not end: {error}"
            );
        }
        self.linking.forget_pending().await;
        crate::session::lock(&self.phrase).take();

        let mut result = SignedOut::default();
        if reason == Reason::Integrity {
            result.keychain_failures = self.end_session_keeping_master_key();
        } else if let Err(error) = self.end_session().await {
            tracing::error!(scope = "SessionTeardown", "keychain clear failed: {error}");
            result.keychain_failures = self.undeletable_entries();
            if result.keychain_failures.is_empty() {
                // Every entry went one by one: nothing of this account is left for the next
                // sign-in to delete, so a key minted offline after this sign-out is kept.
                self.session.note_store_cleared();
            }
            if self.session.state() != AuthState::SignedOut {
                result.session_error = Some(error.to_string());
            }
        }
        if let Some(fault) = self.session.take_sign_out_marker_fault() {
            tracing::error!(scope = "SessionTeardown", "{fault}");
            if !result.keychain_failures.is_empty() {
                result.restore_risk = Some(fault);
            }
        }
        if reason == Reason::Logout
            && let Some(open) = session.current()
            && let Err(error) = open.vault.clear_sync_session_state()
        {
            tracing::warn!(scope = "SessionTeardown", "vault sync state kept: {error}");
        }
        self.config.update(|config| {
            config.insert("sync".into(), Value::Object(Map::new()));
            Ok::<_, crate::registry::config::ConfigError>(())
        })?;
        tracing::info!(
            scope = "SessionTeardown",
            keychain_failures = result.keychain_failures.len(),
            "session teardown complete"
        );
        Ok(result)
    }

    /// The `integrity` keychain step: a setup in flight ends first (only its setup token goes),
    /// then every secret but the master key, named when it stays.
    fn end_session_keeping_master_key(&self) -> Vec<String> {
        if matches!(
            self.session.state(),
            AuthState::SetupPending | AuthState::SetupExpired
        ) && let Err(error) = self.session.abandon_setup()
        {
            tracing::warn!(scope = "SessionTeardown", "the setup did not end: {error}");
        }
        self.session
            .sign_out_keeping_master_key()
            .into_iter()
            .map(|(key, error)| {
                tracing::error!(
                    scope = "SessionTeardown",
                    "failed to delete keychain entry {}: {error}",
                    account(key, None)
                );
                account(key, None)
            })
            .collect()
    }

    /// Deletes each entry on its own after a failed clear and names the ones that stay
    /// (Electron's per-entry `deleteKey`, `session-teardown.ts:95-101`).
    fn undeletable_entries(&self) -> Vec<String> {
        TEARDOWN_ORDER
            .into_iter()
            .filter(|key| match self.store.delete(*key) {
                Ok(()) => false,
                Err(error) => {
                    tracing::error!(
                        scope = "SessionTeardown",
                        "failed to delete keychain entry {}: {error}",
                        account(*key, None)
                    );
                    true
                }
            })
            .map(|key| account(key, None))
            .collect()
    }

    /// The session's own sign-out where the machine has the edge (it revokes the server session
    /// and clears the store); otherwise the attempt in flight ends and the store is cleared
    /// without an edge, so no secret outlives a sign-out from any state and none restores it.
    /// From `Refreshing` (§C.1 draws no sign-out edge there) the store clears and the core latches
    /// the sign-out with no state edge; the latch only refuses a restore, and the cleared store
    /// has nothing to restore, so it has no effect until a device registers and clears it.
    async fn end_session(&self) -> Result<(), AccountError> {
        match self.session.state() {
            AuthState::Registered | AuthState::SessionExpired | AuthState::Revoked => {
                self.session.sign_out().await?;
                return Ok(());
            }
            AuthState::AwaitingOtp { .. } => {
                self.session.abandon_email_sign_in()?;
            }
            AuthState::SetupPending | AuthState::SetupExpired => {
                self.session.abandon_setup()?;
            }
            AuthState::AwaitingProviderToken { .. }
            | AuthState::SignedOut
            | AuthState::Refreshing => {}
        }
        Ok(self.session.clear_without_edge()?)
    }
}
