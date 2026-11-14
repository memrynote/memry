//! Native provider sign-in, chapter 02 §2.13.
//!
//! Two methods and the two edges they drive: `SignedOut -> AwaitingProviderToken`
//! on [`AuthSession::begin_provider_sign_in`], and
//! `AwaitingProviderToken -> SetupPending` on
//! [`AuthSession::complete_provider_sign_in`]. Both edges were already drawn in
//! data-model §C.1 and already in [`super::machine`]; until now nothing
//! exported could reach either of them (spec-defect 114).
//!
//! **Why this is a core method and not a shell request.** Of the three fields
//! §2.13 requires, the shell holds one. `sessionNonce` is minted into this
//! session's pending state and must be the same value registration later sends
//! (§2.6); `devicePublicKey` is the tail of the Ed25519 signing key in the
//! core's `SecureStore`, which never leaves the core; and the `setupToken` that
//! comes back is signed over that nonce and has to land in the same token
//! manager `verify_email_code` stores into. A shell that posted this itself
//! would be a second protocol client the core cannot see.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;

use crate::api::errors::{ApiError, AuthError};
use crate::protocol::auth::{
    AuthRoutes, NativeOAuthRequest, OAuthCallbackRequest, OAuthSignInResponse, random_nonce,
};

use super::{AuthEvent, AuthSession, AuthState, state_name};

/// The providers this core will post an ID token for.
///
/// An enum rather than the free string the state carries, because the value
/// becomes a path segment of `/auth/oauth/:provider/native`: a caller-supplied
/// string there is a caller-supplied URL. It also means the core never walks
/// into the `400 AUTH_INVALID_PROVIDER` §2.13 defines, since the only value it
/// can send is the only value the server accepts. A second provider is an
/// added variant, here and on the server, in that order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum AuthProvider {
    Google,
}

impl AuthProvider {
    fn slug(self) -> &'static str {
        match self {
            AuthProvider::Google => "google",
        }
    }
}

/// What `POST /auth/oauth/:provider/native` answered, minus the parts the core
/// keeps.
///
/// `state` is the machine's new state, so a caller that only renders state can
/// ignore the rest. The other two are §2.13's `isNewUser` and `needsSetup`, and
/// they are carried across rather than dropped because they decide the next
/// screen: `needs_setup` true is "this account has no `kdf_salt` yet, create a
/// recovery phrase", false is "unlock with the phrase you have". A caller that
/// had to infer that from a later failing read would be guessing.
///
/// Absent flags read as `false`, which is the conservative direction for
/// `needs_setup`: it sends the user to unlock, where a real mismatch is
/// reported, rather than to setup, where it would overwrite account key
/// material.
#[derive(Debug, Clone, uniffi::Record)]
pub struct ProviderSignInOutcome {
    pub state: AuthState,
    pub is_new_user: bool,
    pub needs_setup: bool,
}

#[uniffi::export(async_runtime = "tokio")]
impl AuthSession {
    /// `SignedOut -> AwaitingProviderToken`. Mints this attempt's
    /// `sessionNonce` (chapter 02 §2.6), exactly as `request_email_code` does.
    ///
    /// **Synchronous**: it makes no request. The shell's own half — the
    /// `ASWebAuthenticationSession` that ends holding an ID token — happens
    /// between this call and the next, and the core neither opens nor sees it
    /// (research R14 forbids the Google iOS SDK).
    pub fn begin_provider_sign_in(&self, provider: AuthProvider) -> Result<AuthState, AuthError> {
        let next = self.apply(
            AuthEvent::ProviderSheetOpened {
                provider: provider.slug().to_string(),
            },
            "open a provider sheet",
        )?;
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.session_nonce = Some(random_nonce());
        // A native sheet takes no browser callback.
        pending.web_callback = None;
        Ok(next)
    }

    /// `AwaitingProviderToken -> SignedOut`. The sheet closed without a token.
    ///
    /// **Nothing exported could draw this edge, and the shell needs it.**
    /// §C.1 draws "cancelled, expired, or rejected" as one edge out of either
    /// awaiting state, and `complete_provider_sign_in` applies it for
    /// *rejected*. Cancelled is the shell's fact, not the server's: research
    /// R14 makes `canceledLogin` and `error=access_denied` an outcome rather
    /// than an error precisely because a user closing the consent sheet is a
    /// normal thing to do — and before this there was no method that moved the
    /// machine afterwards. `sign_out` is not it: §C.1 draws no
    /// `AwaitingProviderToken -> SignedOut` for `SignedOutByUser`, so the one
    /// call a shell would reach for answers `InvalidState` and leaves the
    /// session stranded in a state whose own screen offers no way out.
    ///
    /// No new state and no new event: this applies `SignInFailed`, the edge
    /// that was already drawn and already reachable for the other two thirds
    /// of its meaning.
    ///
    /// **Synchronous**: it makes no request. From any other state it is
    /// `InvalidState`, because abandoning a sheet that was never opened is a
    /// caller bug rather than a no-op — unlike `restore`, which the process
    /// lifecycle drives rather than the user.
    pub fn abandon_provider_sign_in(&self) -> Result<AuthState, AuthError> {
        let state = self.state_now();
        if !matches!(state, AuthState::AwaitingProviderToken { .. }) {
            return Err(AuthError::InvalidState {
                action: "abandon a provider sign-in".to_string(),
                state: state_name(&state),
            });
        }
        {
            // The nonce belongs to the attempt that just ended. Leaving it in
            // place would let a later registration present a nonce no setup
            // token was signed over (chapter 02 §2.6).
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            pending.session_nonce = None;
            pending.web_callback = None;
        }
        self.apply(AuthEvent::SignInFailed, "abandon a provider sign-in")
    }

    /// `AwaitingProviderToken -> SetupPending`, or `-> SignedOut` when the
    /// provider token is refused.
    ///
    /// The provider is read from the state rather than taken as an argument:
    /// the nonce this posts belongs to the attempt `begin_provider_sign_in`
    /// opened, and a second provider spent on it would be a different attempt.
    /// Calling this from any other state is `InvalidState`, not a sign-in that
    /// skipped the sheet.
    pub async fn complete_provider_sign_in(
        &self,
        id_token: String,
    ) -> Result<ProviderSignInOutcome, AuthError> {
        let state = self.state_now();
        let AuthState::AwaitingProviderToken { provider } = &state else {
            return Err(AuthError::InvalidState {
                action: "complete a provider sign-in".to_string(),
                state: state_name(&state),
            });
        };
        let provider = provider.clone();

        let session_nonce = {
            let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            pending.session_nonce.clone()
        };
        // The nonce is minted by `begin_provider_sign_in` on the same edge that
        // produced this state, so its absence is a core bug, not a server
        // answer — and posting without it would earn a setup token that
        // registration could not then match (§2.6).
        let Some(session_nonce) = session_nonce else {
            return Err(AuthError::InvalidState {
                action: "complete a provider sign-in that minted no nonce".to_string(),
                state: state_name(&state),
            });
        };

        let secret = self.signing_secret_key()?;
        let public = Self::signing_public_key(&secret)?;
        let request = NativeOAuthRequest {
            id_token,
            session_nonce,
            device_public_key: BASE64_STANDARD.encode(public),
        };

        let answer = AuthRoutes::sign_in_with_provider(&self.http, &provider, &request).await;
        let (state, response) = self.accept_provider_answer(answer)?;
        Ok(ProviderSignInOutcome {
            state,
            is_new_user: response.is_new_user.unwrap_or(false),
            needs_setup: response.needs_setup.unwrap_or(false),
        })
    }
}

/// The browser callback one web attempt waits for: the `state` the server
/// signed into the authorization URL, and the loopback redirect it was signed
/// for.
#[derive(Debug, Clone)]
pub(super) struct ExpectedCallback {
    state: String,
    redirect_uri: String,
}

/// What the browser callback answered: [`ProviderSignInOutcome`] plus
/// `knownDevice`, which decides whether the recovery phrase is asked for
/// (`apps/desktop/src/main/ipc/auth-oauth-handlers.ts:265`). Absent flags read
/// as `false`, `knownDevice` included (chapter 02: servers before the field
/// omit it).
///
/// Rust-only, as the two methods that produce it: desktop is the one shell with
/// a loopback redirect, and iOS uses the native route (chapter 02 §2.13).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebSignInOutcome {
    pub state: AuthState,
    pub is_new_user: bool,
    pub needs_setup: bool,
    pub known_device: bool,
}

impl AuthSession {
    /// `SignedOut -> AwaitingProviderToken` for a browser sign-in, recording the
    /// callback the attempt waits for.
    ///
    /// The shell calls it once the server has answered the authorization
    /// request (`GET /auth/oauth/:provider?redirect_uri=`) with the provider
    /// URL, whose `state` it passes here with the loopback `redirect_uri` it
    /// asked for — Electron's `oauthSessions.set(state, …)`
    /// (`ipc/auth-oauth-handlers.ts:147-154`). Mints the §2.6 nonce as
    /// [`Self::begin_provider_sign_in`] does. Makes no request.
    pub fn begin_provider_web_sign_in(
        &self,
        provider: AuthProvider,
        state: String,
        redirect_uri: String,
    ) -> Result<AuthState, AuthError> {
        let next = self.begin_provider_sign_in(provider)?;
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.web_callback = Some(ExpectedCallback {
            state,
            redirect_uri,
        });
        Ok(next)
    }

    /// `AwaitingProviderToken -> SetupPending`, or `-> SignedOut` when the
    /// server refuses the code: the browser callback's `code` exchanged with
    /// this attempt's nonce and device key.
    ///
    /// **Once, and only for the attempt's own `state`.** A `state` this attempt
    /// did not open is refused before any request and leaves the attempt
    /// waiting, so a forged callback cannot cancel the user's sign-in; the
    /// matching callback spends the expectation before it posts, so a second
    /// delivery — concurrent, after success, or after a refusal — is refused
    /// without a request. Electron's `consumeOAuthSession`
    /// (`ipc/auth-oauth-state.ts:27-38`) has the same rule. The server checks
    /// the `state` signature and its five-minute expiry
    /// (`apps/sync-server/src/routes/auth.ts:172-207`) but keeps no record of
    /// spent states, so the single use is the client's to enforce.
    pub async fn complete_provider_web_callback(
        &self,
        code: String,
        state: String,
    ) -> Result<WebSignInOutcome, AuthError> {
        let current = self.state_now();
        let AuthState::AwaitingProviderToken { provider } = &current else {
            return Err(AuthError::InvalidState {
                action: "complete a provider callback".to_string(),
                state: state_name(&current),
            });
        };
        let provider = provider.clone();
        // Read before the expectation is spent, so a locked store leaves the
        // attempt intact for a retry.
        let secret = self.signing_secret_key()?;
        let public = Self::signing_public_key(&secret)?;

        let (expected, session_nonce) = {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            match pending.web_callback.take() {
                Some(expected) if expected.state == state => {
                    (expected, pending.session_nonce.clone())
                }
                other => {
                    pending.web_callback = other;
                    return Err(AuthError::InvalidState {
                        action: "complete a provider callback this attempt is not waiting for"
                            .to_string(),
                        state: state_name(&current),
                    });
                }
            }
        };
        let Some(session_nonce) = session_nonce else {
            return Err(AuthError::InvalidState {
                action: "complete a provider callback that minted no nonce".to_string(),
                state: state_name(&current),
            });
        };

        let request = OAuthCallbackRequest {
            code,
            state: expected.state,
            redirect_uri: expected.redirect_uri,
            session_nonce,
            device_public_key: BASE64_STANDARD.encode(public),
        };
        let answer = AuthRoutes::sign_in_with_web_callback(&self.http, &provider, &request).await;
        let (state, response) = self.accept_provider_answer(answer)?;
        Ok(WebSignInOutcome {
            state,
            is_new_user: response.is_new_user.unwrap_or(false),
            needs_setup: response.needs_setup.unwrap_or(false),
            known_device: response.known_device.unwrap_or(false),
        })
    }

    /// The one way out of `AwaitingProviderToken` for both provider routes: a
    /// setup token moves to `SetupPending`, anything else takes the failure
    /// edge. §C.1 draws two edges out of the state, and a response with no
    /// setup token is not the one to `SetupPending` — the same rule
    /// `verify_email_code` applies to its own answer.
    fn accept_provider_answer(
        &self,
        answer: Result<OAuthSignInResponse, ApiError>,
    ) -> Result<(AuthState, OAuthSignInResponse), AuthError> {
        let response = match answer {
            Ok(response) => response,
            Err(error) => {
                self.apply(AuthEvent::SignInFailed, "fail a sign-in")?;
                return Err(error.into());
            }
        };
        let Some(setup_token) = response.setup_token.as_deref() else {
            self.apply(AuthEvent::SignInFailed, "fail a sign-in")?;
            return Err(AuthError::NoSetupToken);
        };
        self.tokens.store_setup_token(setup_token)?;
        let state = self.apply(AuthEvent::SetupTokenIssued, "accept a setup token")?;
        Ok((state, response))
    }
}
