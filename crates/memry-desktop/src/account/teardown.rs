//! Sign-out (`teardownSession('logout')`, Electron `sync/session-teardown.ts:36-170`).
//!
//! Stops the open vault's sync, revokes the server session (best effort), deletes the five
//! keychain secrets (the session's store holds exactly them: master key, device key and the three
//! tokens; a keychain error still signs out and names the entries that stay), removes the open
//! vault's at-rest key even while the agent holds it, ends the open vault's sync session state,
//! and empties `memry-config.json` `sync`
//! (`store.set('sync', {})`, `:119`). Vault files, the outbox and the CRDT store stay: editing
//! never depends on a session. The `integrity` reason (keeps the master key) and the Google
//! Calendar disconnect (Step 29) are not here.

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
    /// The session's own sign-out failed although every entry was deleted.
    pub session_error: Option<String>,
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
        Some(format!(
            "Failed to remove: {}",
            self.keychain_failures.join(", ")
        ))
    }
}

impl AccountService {
    /// `sync:auth-logout` and `account:signOut`, one teardown. Runs after any key-changing
    /// operation in flight, never beside one.
    pub async fn sign_out(&self, session: &Session) -> Result<SignedOut, AccountError> {
        let _op = self.key_op.lock().await;
        tracing::info!(scope = "SessionTeardown", "session teardown started");
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
        if let Err(error) = self.end_session().await {
            tracing::error!(scope = "SessionTeardown", "keychain clear failed: {error}");
            result.keychain_failures = self.undeletable_entries();
            result.session_error = Some(error.to_string());
        }
        // After the keychain is cleared, so no hold taken meanwhile reinstalls the key.
        self.at_rest_keys.clear();
        if let Some(open) = session.current()
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
