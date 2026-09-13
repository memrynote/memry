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

use crate::api::errors::AuthError;
use crate::protocol::auth::{AuthRoutes, NativeOAuthRequest, random_nonce};

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
        Ok(next)
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

        let response =
            match AuthRoutes::sign_in_with_provider(&self.http, &provider, &request).await {
                Ok(response) => response,
                Err(error) => {
                    self.apply(AuthEvent::SignInFailed, "fail a sign-in")?;
                    return Err(error.into());
                }
            };

        // §C.1 draws two edges out of `AwaitingProviderToken`, and a response
        // with no setup token is not the one to `SetupPending` — the same rule
        // `verify_email_code` applies to its own answer.
        let Some(setup_token) = response.setup_token else {
            self.apply(AuthEvent::SignInFailed, "fail a sign-in")?;
            return Err(AuthError::NoSetupToken);
        };
        self.tokens.store_setup_token(&setup_token)?;
        let state = self.apply(AuthEvent::SetupTokenIssued, "accept a setup token")?;
        Ok(ProviderSignInOutcome {
            state,
            is_new_user: response.is_new_user.unwrap_or(false),
            needs_setup: response.needs_setup.unwrap_or(false),
        })
    }
}
