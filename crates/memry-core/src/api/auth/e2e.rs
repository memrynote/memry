//! The desktop e2e build's sign-in (`e2e_bootstrap_sync_device`, Electron's
//! `bootstrapSyncDevice` in `apps/desktop/src/main/test-hooks.ts:280-306`):
//! the harness signs a setup token with the local test server's key, and that
//! token takes the place of an email code. Compiled only with the `e2e`
//! feature; the iOS build and every release build link none of it.

use crate::api::errors::AuthError;

use super::{AuthEvent, AuthSession, AuthState, PendingSignIn};

impl AuthSession {
    /// `SignedOut -> AwaitingOtp -> SetupPending` with `setup_token` stored:
    /// the two edges an email sign-in walks, with no code sent or verified.
    /// The attempt carries no §2.6 nonce, as the harness token names none.
    /// Registration ([`Self::register_device`]) follows as for any sign-in.
    /// Rust-only.
    pub fn accept_e2e_setup_token(
        &self,
        email: String,
        setup_token: &str,
    ) -> Result<AuthState, AuthError> {
        self.apply(
            AuthEvent::OtpRequested {
                email: email.clone(),
            },
            "start an e2e sign-in",
        )?;
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = PendingSignIn {
            email: Some(email),
            ..PendingSignIn::default()
        };
        if let Err(error) = self.tokens.store_setup_token(setup_token) {
            self.apply(AuthEvent::SignInFailed, "fail a sign-in")?;
            return Err(error);
        }
        self.apply(AuthEvent::SetupTokenIssued, "accept an e2e setup token")
    }
}
