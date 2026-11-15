//! `GET /auth/recovery-info` for the session's setup token, chapter 02 §2.7.
//!
//! The read a client makes between sign-in and registration to check a master
//! key it already holds, or a phrase the user typed, against the account's
//! verifier (Electron: `sync/device-registration.ts:294`,
//! `ipc/auth-device-handlers.ts:446`). Rust-only: the setup token never leaves
//! the core, so the shell cannot make this request itself.

use crate::api::errors::{ApiError, AuthError};
use crate::protocol::account::{self, KeyMaterial};
use crate::protocol::auth::{TokenClaims, now_unix_s};

use super::{AuthEvent, AuthSession, AuthState};

impl AuthSession {
    /// The account's `{ kdfSalt, keyVerifier }`, read with the setup token this
    /// session holds. No setup token is [`AuthError::NoSetupToken`] with no
    /// request; a spent or expired one is the server's `401`, unchanged, which
    /// the caller answers with [`Self::renew_setup_token`].
    ///
    /// From `SetupPending` that `401` also takes the `SetupExpired` edge, as
    /// `register_device` does: the token can age out while the user looks for
    /// the phrase, and renewal is only drawn out of `SetupExpired`.
    pub async fn recovery_info(&self) -> Result<KeyMaterial, AuthError> {
        let Some(setup_token) = self.tokens.setup_token()? else {
            return Err(AuthError::NoSetupToken);
        };
        match account::recovery_info(&self.http, &setup_token).await {
            Err(error @ ApiError::Unauthorized { .. })
                if self.state_now() == AuthState::SetupPending =>
            {
                self.apply(AuthEvent::SetupTokenExpired, "expire a setup token")?;
                Err(error.into())
            }
            answer => Ok(answer?),
        }
    }

    /// Electron's `ensureLiveSetupToken` (`sync/setup-token.ts:109-113`): a
    /// setup token whose own `exp` has passed takes the `SetupExpired` edge and
    /// is renewed before anything spends it, so the first call after a long
    /// hunt for the phrase is not a `401`. From `SetupExpired` it renews; from
    /// any other state it reports the state and sends nothing. Rust-only.
    pub async fn live_setup_token(&self) -> Result<AuthState, AuthError> {
        if self.state_now() == AuthState::SetupPending
            && let Some(token) = self.tokens.setup_token()?
            && TokenClaims::parse(&token)?.is_expired(now_unix_s())
        {
            self.apply(AuthEvent::SetupTokenExpired, "expire a setup token")?;
        }
        if self.state_now() == AuthState::SetupExpired {
            return self.renew_setup_token().await;
        }
        Ok(self.state_now())
    }
}
