//! The email-code half of sign-in that needs more than the state: the server's
//! answer, which says whether the account is set up and whether it still lists
//! this device's key (Electron: `ipc/auth-device-handlers.ts:316-339`).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;

use crate::api::errors::{ApiError, AuthError};
use crate::protocol::auth::{AuthRoutes, VerifyOtpRequest, VerifyOtpResponse, random_nonce};

use super::{AuthEvent, AuthSession, AuthState, PendingSignIn, state_name};

impl AuthSession {
    /// [`Self::request_email_code`] with the code's lifetime in seconds
    /// (`expiresIn`), which the shell's countdown shows. Rust-only.
    pub async fn request_email_code_answer(
        &self,
        email: String,
    ) -> Result<(AuthState, Option<u64>), AuthError> {
        let next = self.apply(
            AuthEvent::OtpRequested {
                email: email.clone(),
            },
            "request an email code",
        )?;
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            pending.email = Some(email.clone());
            pending.session_nonce = Some(random_nonce());
        }
        match AuthRoutes::request_otp(&self.http, &email).await {
            Ok(answer) => Ok((next, answer.expires_in)),
            Err(error) => {
                self.apply(AuthEvent::SignInFailed, "fail a sign-in")?;
                Err(error.into())
            }
        }
    }

    /// [`Self::resend_email_code`] with the new code's lifetime in seconds,
    /// `None` when the server does not say. Rust-only.
    pub async fn resend_email_code_answer(&self) -> Result<Option<u64>, AuthError> {
        let email = {
            let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            pending.email.clone()
        };
        let Some(email) = email else {
            return Err(AuthError::InvalidState {
                action: "resend an email code".to_string(),
                state: state_name(&self.state_now()),
            });
        };
        Ok(AuthRoutes::resend_otp(&self.http, &email).await?)
    }

    /// [`Self::verify_email_code`] with the server's answer: `needsSetup`,
    /// `knownDevice` and `isNewUser` decide which screen follows. Rust-only;
    /// the setup token in the answer is already stored and is never returned
    /// to a shell.
    ///
    /// Commits `devicePublicKey`, which is what makes `SetupExpired`
    /// recoverable: without it the grant is a single non-renewable five
    /// minutes (chapter 02 §2.5), and a user hunting for a 24-word phrase
    /// routinely outlasts that.
    pub async fn verify_email_code_answer(
        &self,
        code: String,
    ) -> Result<(AuthState, VerifyOtpResponse), AuthError> {
        let (email, session_nonce) = {
            let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            (pending.email.clone(), pending.session_nonce.clone())
        };
        let Some(email) = email else {
            return Err(AuthError::InvalidState {
                action: "verify an email code".to_string(),
                state: state_name(&self.state_now()),
            });
        };

        let secret = self.signing_secret_key()?;
        let public = Self::signing_public_key(&secret)?;
        let request = VerifyOtpRequest {
            email,
            code,
            session_nonce,
            device_public_key: Some(BASE64_STANDARD.encode(public)),
        };

        let mut response = match AuthRoutes::verify_otp(&self.http, &request).await {
            Ok(response) => response,
            Err(error @ ApiError::RateLimited { .. }) => return Err(error.into()), // #2940
            Err(error) => {
                self.apply(AuthEvent::SignInFailed, "fail a sign-in")?;
                return Err(error.into());
            }
        };

        // §C.1 draws exactly two edges out of `AwaitingOtp`, and a response
        // with no setup token is not the one to `SetupPending`.
        let Some(setup_token) = response.setup_token.take() else {
            self.apply(AuthEvent::SignInFailed, "fail a sign-in")?;
            return Err(AuthError::NoSetupToken);
        };
        self.tokens.store_setup_token(&setup_token)?;
        let state = self.apply(AuthEvent::SetupTokenIssued, "accept a setup token")?;
        Ok((state, response))
    }

    /// Ends an email-code attempt that is still waiting for its code, so the
    /// user can ask for a code at another address. Nothing is cleared: the
    /// keys a known device signs back in with stay. Rust-only.
    pub fn abandon_email_sign_in(&self) -> Result<AuthState, AuthError> {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if !matches!(self.state_now(), AuthState::AwaitingOtp { .. }) {
            return Err(AuthError::InvalidState {
                action: "abandon an email sign-in".to_string(),
                state: state_name(&self.state_now()),
            });
        }
        *pending = PendingSignIn::default();
        self.apply(AuthEvent::SignInFailed, "abandon an email sign-in")
    }

    /// The edge is checked before anything is cleared. An attempt still waiting
    /// for its code or provider answer ends on its own failure edge, as
    /// [`Self::abandon_provider_sign_in`] ends it. Any other state with no
    /// `SignedOutByUser` edge (`SetupPending`, `SetupExpired`, `Refreshing`,
    /// `SignedOut`) is `InvalidState` and leaves the store, the attempt and the
    /// state as they were. Pending, then state, the order of every edge out of
    /// an attempt, held through the clear so a provider answer lands before it
    /// or finds its attempt ended.
    pub(super) fn clear_and_sign_out(&self) -> Result<AuthState, AuthError> {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let event = match *state {
            AuthState::AwaitingOtp { .. } | AuthState::AwaitingProviderToken { .. } => {
                AuthEvent::SignInFailed
            }
            _ => AuthEvent::SignedOutByUser,
        };
        let Some(next) = super::transition(&state, &event) else {
            return Err(AuthError::InvalidState {
                action: "sign out".to_string(),
                state: state_name(&state),
            });
        };
        self.tokens.clear()?;
        *pending = PendingSignIn::default();
        *state = next.clone();
        Ok(next)
    }
}
