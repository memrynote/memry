//! The authentication surface the shells call, and the machine behind it.
//!
//! The machine is data-model §C.1, edge for edge. It is here rather than in the
//! shell because FR-037 says the shell renders state and computes none of it:
//! two shells that each decide when a session is expired will disagree, and the
//! one that decides wrong signs a user out who was fine.
//!
//! **Only the drawn edges exist.** A call that is not an edge from the current
//! state is `AuthError::InvalidState`, not a silent no-op and not a second
//! sign-in racing the first. That includes the failure edges: "cancelled,
//! expired, or rejected" from either awaiting state is the same edge back to
//! `SignedOut`, and `Revoked` is terminal until the user acts.
//!
//! **What the machine does not decide is when.** The proactive refresh
//! schedule is chapter 02 §2.10 arithmetic
//! (`protocol::auth::refresh_delay_ms`); whoever drives the timer calls
//! `refresh` and the machine records the transition.

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;

use crate::api::errors::{ApiError, AuthError, SecureStoreError};
use crate::crypto::sodium;
use crate::protocol::auth::{
    AuthRoutes, DevicePlatform, DeviceRegisterRequest, RenewSetupTokenRequest, TokenClaims,
    TokenManager, VerifyOtpRequest, random_nonce, sign_device_challenge,
};
use crate::protocol::http::{ClientIdentity, HttpClient};
use crate::seams::secure_store::{SecureStore, SecureStoreKey};
use crate::seams::transport::Transport;

mod oauth;
mod restore;

pub use oauth::{AuthProvider, ProviderSignInOutcome};

/// Data-model §C.1, one variant per drawn state.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum AuthState {
    SignedOut,
    /// A code was requested. The email is carried so the shell can render
    /// "we sent a code to …" without holding its own copy.
    AwaitingOtp {
        email: String,
    },
    AwaitingProviderToken {
        provider: String,
    },
    /// A setup token is held and no device is registered yet.
    SetupPending,
    /// The setup token aged out. Recoverable **only** when a
    /// `devicePublicKey` was committed at sign-in (chapter 02 §2.5).
    SetupExpired,
    Registered,
    Refreshing,
    SessionExpired,
    /// Terminal until the user acts. Local vault content is removed **before**
    /// this is shown, not after (data-model §C.1).
    Revoked,
}

/// The events that drive it. One per labelled edge.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum AuthEvent {
    OtpRequested {
        email: String,
    },
    ProviderSheetOpened {
        provider: String,
    },
    SetupTokenIssued,
    /// Cancelled, expired, or rejected: §C.1 draws one edge for all three.
    SignInFailed,
    DeviceRegistered,
    SetupTokenExpired,
    SetupTokenRenewed,
    SetupNotRenewable,
    RefreshStarted,
    RefreshSucceeded,
    RefreshRefused,
    DeviceRevoked,
    SignedOutByUser,
    /// The process restarted and the secure store still holds a refresh token
    /// (spec-defect 121). **Appended last**, so every variant that existed
    /// before keeps its discriminant and its meaning: nothing that used to be
    /// `SignedOutByUser` is now this, and a shell built against the previous
    /// binding still lifts every value it could lift before.
    SessionRestored,
}

/// The transition table. `None` is "not an edge", which the caller reports
/// rather than swallows.
pub fn transition(state: &AuthState, event: &AuthEvent) -> Option<AuthState> {
    use AuthEvent as E;
    use AuthState as S;
    Some(match (state, event) {
        (S::SignedOut, E::OtpRequested { email }) => S::AwaitingOtp {
            email: email.clone(),
        },
        (S::SignedOut, E::ProviderSheetOpened { provider }) => S::AwaitingProviderToken {
            provider: provider.clone(),
        },
        // spec-defect 121. The third and last edge out of `SignedOut`, and the
        // only one that is not a user action: the other two need an OTP or a
        // consent sheet, so before this a registered user who quit the app was
        // shown the sign-in screen with a working session in their keychain.
        //
        // It lands in `Registered` rather than in a tenth "maybe signed in"
        // state because `Registered` is a *claim* the server adjudicates, not
        // an assertion that the token is good: `SessionExpired` and `Revoked`
        // are both edges **out of** `Registered`, so restoring here is what
        // makes them reachable at all. Restoring into `SignedOut` — today's
        // behaviour — is what collapses the three.
        (S::SignedOut, E::SessionRestored) => S::Registered,

        (S::AwaitingOtp { .. } | S::AwaitingProviderToken { .. }, E::SetupTokenIssued) => {
            S::SetupPending
        }
        (S::AwaitingOtp { .. } | S::AwaitingProviderToken { .. }, E::SignInFailed) => S::SignedOut,

        (S::SetupPending, E::DeviceRegistered) => S::Registered,
        (S::SetupPending, E::SetupTokenExpired) => S::SetupExpired,

        (S::SetupExpired, E::SetupTokenRenewed) => S::SetupPending,
        (S::SetupExpired, E::SetupNotRenewable) => S::SignedOut,

        (S::Registered, E::RefreshStarted) => S::Refreshing,
        (S::Registered, E::RefreshRefused) => S::SessionExpired,
        (S::Registered, E::DeviceRevoked) => S::Revoked,
        (S::Registered, E::SignedOutByUser) => S::SignedOut,

        (S::Refreshing, E::RefreshSucceeded) => S::Registered,
        (S::Refreshing, E::RefreshRefused) => S::SessionExpired,

        (S::SessionExpired, E::RefreshSucceeded) => S::Registered,
        (S::SessionExpired, E::SignedOutByUser) => S::SignedOut,

        (S::Revoked, E::SignedOutByUser) => S::SignedOut,

        _ => return None,
    })
}

fn state_name(state: &AuthState) -> String {
    match state {
        AuthState::SignedOut => "SignedOut",
        AuthState::AwaitingOtp { .. } => "AwaitingOtp",
        AuthState::AwaitingProviderToken { .. } => "AwaitingProviderToken",
        AuthState::SetupPending => "SetupPending",
        AuthState::SetupExpired => "SetupExpired",
        AuthState::Registered => "Registered",
        AuthState::Refreshing => "Refreshing",
        AuthState::SessionExpired => "SessionExpired",
        AuthState::Revoked => "Revoked",
    }
    .to_string()
}

/// What `POST /auth/devices` needs that only the shell knows.
#[derive(Debug, Clone, uniffi::Record)]
pub struct DeviceDescriptor {
    /// 1 to 255 characters; the server sanitises and rejects an empty result.
    pub name: String,
    /// Chapter 02 §2.12: the registration enum, not `CLIENT_PLATFORMS`.
    pub platform: DevicePlatform,
    pub os_version: Option<String>,
    pub app_version: String,
    /// Defaults to `default` server-side when absent.
    pub vault_id: Option<String>,
}

/// What one sign-in attempt carries between its two calls.
#[derive(Debug, Default)]
struct PendingSignIn {
    email: Option<String>,
    /// Chapter 02 §2.6: minted locally, sent on the sign-in call **and** on
    /// registration, and it MUST be the same value on both — a token that
    /// carries a nonce rejects a registration that omits it.
    session_nonce: Option<String>,
}

/// The session. One per account on the device.
#[derive(uniffi::Object)]
pub struct AuthSession {
    http: Arc<HttpClient>,
    tokens: Arc<TokenManager>,
    store: Arc<dyn SecureStore>,
    device: DeviceDescriptor,
    state: Mutex<AuthState>,
    pending: Mutex<PendingSignIn>,
}

impl AuthSession {
    /// The session-authenticated HTTP client.
    ///
    /// Exposed so that a caller which already built a session reuses its token
    /// manager instead of building a second one: two managers over the same
    /// keychain entries would each refresh, and chapter 02 §2.9 revokes a
    /// device whose refresh token is presented twice outside the grace window.
    /// Not part of the FFI surface — `HttpClient` is internal to the core.
    pub fn http(&self) -> Arc<HttpClient> {
        self.http.clone()
    }

    /// The secure store this session was built over. Internal, like `http`.
    pub(crate) fn secure_store(&self) -> Arc<dyn SecureStore> {
        self.store.clone()
    }

    /// The master key this device unlocked with, or `None` when nothing has
    /// unlocked it.
    ///
    /// **Not part of the FFI surface, and it never will be.** `core-api.md`'s
    /// rule is that no exported object exposes a key; the sync tier needs the
    /// key to derive a vault key, and it gets it here, inside the core, from
    /// the store this session was built over. A `SecureStoreError::Locked` is
    /// returned unchanged rather than folded into `None`, for the same reason
    /// [`AuthSession::signing_secret_key`] does it: "locked" and "absent" have
    /// different remedies and only one of them is the user's.
    pub(crate) fn master_key(&self) -> Result<Option<Vec<u8>>, SecureStoreError> {
        self.store.get(SecureStoreKey::MasterKey)
    }

    fn state_now(&self) -> AuthState {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Applies an edge, or reports that the call was not one.
    fn apply(&self, event: AuthEvent, action: &str) -> Result<AuthState, AuthError> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match transition(&state, &event) {
            Some(next) => {
                *state = next.clone();
                Ok(next)
            }
            None => Err(AuthError::InvalidState {
                action: action.to_string(),
                state: state_name(&state),
            }),
        }
    }

    /// The device's Ed25519 signing key, created on first use.
    ///
    /// Random, never derived (data-model §B), so a device that loses it must
    /// register anew. A `SecureStoreError::Locked` on the read is **not**
    /// "absent": returning it unchanged is what stops a locked keychain from
    /// silently minting a second identity.
    pub(crate) fn signing_secret_key(&self) -> Result<Vec<u8>, AuthError> {
        if let Some(existing) = self.store.get(SecureStoreKey::DeviceSigningKey)? {
            return Ok(existing);
        }
        let (_public, secret) = sodium::sign_keypair()?;
        self.store
            .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())?;
        Ok(secret.to_vec())
    }

    /// The id the server registered this device under: the access token's
    /// `device_id` claim (chapter 02 §2.2).
    ///
    /// **Not** [`Self::device_id`]. That one is derived locally from the
    /// signing key and names this device in field clocks; the server never
    /// sees it as a device. A pushed record is signed as its sender, and the
    /// server looks the signer up among the account's registered devices, so
    /// signing with the local id is refused as `AUTH_DEVICE_NOT_FOUND`.
    pub(crate) fn registered_device_id(&self) -> Result<String, AuthError> {
        let token = self
            .tokens
            .access_token_sync()?
            .ok_or_else(|| AuthError::InvalidState {
                action: "sign a push".to_string(),
                state: "signed out".to_string(),
            })?;
        TokenClaims::parse(&token)?
            .device_id
            .filter(|id| !id.is_empty())
            .ok_or_else(|| AuthError::MalformedToken {
                what: "access token has no device_id claim".to_string(),
            })
    }

    /// This device's id, chapter 01 §1.5.
    ///
    /// Derived from the signing key rather than stored beside it, for the
    /// reason the key's own doc gives: a second entry is a second thing that
    /// can fall out of step, and a device id that disagreed with the key it
    /// was minted from would sign manifests nobody can attribute.
    pub(crate) fn device_id(&self) -> Result<String, AuthError> {
        let secret = self.signing_secret_key()?;
        let public = Self::signing_public_key(&secret)?;
        Ok(crate::crypto::keys::local_device_id_hex(&public)?)
    }

    /// libsodium keeps the 32-byte public key in the tail of the 64-byte
    /// secret key, so there is no second entry to keep in step.
    fn signing_public_key(secret: &[u8]) -> Result<Vec<u8>, AuthError> {
        secret
            .get(32..64)
            .map(<[u8]>::to_vec)
            .ok_or(AuthError::MalformedToken {
                what: "device signing key is not 64 bytes".to_string(),
            })
    }

    fn signed_challenge(&self, jti: &str) -> Result<(String, String, String), AuthError> {
        let secret = self.signing_secret_key()?;
        let public = Self::signing_public_key(&secret)?;
        let nonce = random_nonce();
        let signature = sign_device_challenge(&nonce, jti, &secret)?;
        Ok((BASE64_STANDARD.encode(public), nonce, signature))
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl AuthSession {
    /// Builds a session over the shell's seams.
    ///
    /// `client_platform` is `ios | android | desktop` (chapter 11 §11.2) and is
    /// validated here: chapter 11 §11.3 says a malformed header opts the client
    /// out of the write gate silently, so it never leaves this constructor.
    #[uniffi::constructor]
    pub fn new(
        transport: Arc<dyn Transport>,
        secure_store: Arc<dyn SecureStore>,
        base_url: String,
        client_platform: String,
        device: DeviceDescriptor,
    ) -> Result<Self, ApiError> {
        let identity = ClientIdentity::new(&client_platform, &device.app_version)?;
        // The refresh client carries no token provider, so a 401 on
        // `/auth/refresh` cannot re-enter refresh (chapter 02 §2.10).
        let refresh_http = Arc::new(HttpClient::new(
            transport.clone(),
            &base_url,
            identity.clone(),
        ));
        let tokens = Arc::new(TokenManager::new(secure_store.clone(), refresh_http));
        let http =
            Arc::new(HttpClient::new(transport, &base_url, identity).with_tokens(tokens.clone()));
        Ok(Self {
            http,
            tokens,
            store: secure_store,
            device,
            state: Mutex::new(AuthState::SignedOut),
            pending: Mutex::new(PendingSignIn::default()),
        })
    }

    pub fn state(&self) -> AuthState {
        self.state_now()
    }

    /// `SignedOut -> AwaitingOtp`. Mints the `sessionNonce` this attempt will
    /// carry on both calls (chapter 02 §2.6).
    pub async fn request_email_code(&self, email: String) -> Result<AuthState, AuthError> {
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
            Ok(_) => Ok(next),
            Err(error) => {
                self.apply(AuthEvent::SignInFailed, "fail a sign-in")?;
                Err(error.into())
            }
        }
    }

    /// Asks for the same code again. Not a state transition: chapter 02 §2.11
    /// caps it at three per ten minutes and the state is unchanged either way.
    pub async fn resend_email_code(&self) -> Result<(), AuthError> {
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
        AuthRoutes::resend_otp(&self.http, &email).await?;
        Ok(())
    }

    /// `AwaitingOtp -> SetupPending`, or `-> SignedOut` when the code is
    /// rejected.
    ///
    /// Commits `devicePublicKey`, which is what makes `SetupExpired`
    /// recoverable: without it the grant is a single non-renewable five
    /// minutes (chapter 02 §2.5), and a user hunting for a 24-word phrase
    /// routinely outlasts that.
    pub async fn verify_email_code(&self, code: String) -> Result<AuthState, AuthError> {
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

        let response = match AuthRoutes::verify_otp(&self.http, &request).await {
            Ok(response) => response,
            Err(error) => {
                self.apply(AuthEvent::SignInFailed, "fail a sign-in")?;
                return Err(error.into());
            }
        };

        // §C.1 draws exactly two edges out of `AwaitingOtp`, and a response
        // with no setup token is not the one to `SetupPending`.
        let Some(setup_token) = response.setup_token else {
            self.apply(AuthEvent::SignInFailed, "fail a sign-in")?;
            return Err(AuthError::NoSetupToken);
        };
        self.tokens.store_setup_token(&setup_token)?;
        self.apply(AuthEvent::SetupTokenIssued, "accept a setup token")
    }

    /// `SetupPending -> Registered`, or `-> SetupExpired` when the grant aged
    /// out.
    ///
    /// The challenge is chapter 02 §2.3.1: Ed25519 over `nonce:jti`, standard
    /// base64, with the `jti` read out of the setup token the client holds. The
    /// nonce is minted here from the CSPRNG and never taken from a server
    /// (§2.3.2).
    pub async fn register_device(&self) -> Result<AuthState, AuthError> {
        if self.state_now() != AuthState::SetupPending {
            return Err(AuthError::InvalidState {
                action: "register a device".to_string(),
                state: state_name(&self.state_now()),
            });
        }
        let Some(setup_token) = self.tokens.setup_token()? else {
            return Err(AuthError::NoSetupToken);
        };
        let claims = TokenClaims::parse(&setup_token)?;
        let jti = claims.require_jti()?.to_string();
        let (auth_public_key, challenge_nonce, challenge_signature) =
            self.signed_challenge(&jti)?;
        let session_nonce = {
            let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            pending.session_nonce.clone()
        };

        let request = DeviceRegisterRequest {
            name: self.device.name.clone(),
            platform: self.device.platform,
            os_version: self.device.os_version.clone(),
            app_version: self.device.app_version.clone(),
            auth_public_key,
            challenge_signature,
            challenge_nonce,
            session_nonce,
            vault_id: self.device.vault_id.clone(),
        };

        match AuthRoutes::register_device(&self.http, &setup_token, &request).await {
            Ok(response) => {
                let (Some(access), Some(refresh)) = (response.access_token, response.refresh_token)
                else {
                    return Err(AuthError::Api {
                        source: ApiError::MalformedResponse {
                            path: "/auth/devices".to_string(),
                            what: "registration returned no token pair".to_string(),
                        },
                    });
                };
                self.tokens.store_session(&access, &refresh)?;
                self.apply(AuthEvent::DeviceRegistered, "register a device")
            }
            // A spent or aged-out setup token is `401 AUTH_INVALID_TOKEN`
            // (chapter 02 §2.3.3), which is the `SetupExpired` edge: renewal,
            // not a new sign-in, is what recovers it.
            Err(ApiError::Unauthorized { code, message }) => {
                self.apply(AuthEvent::SetupTokenExpired, "expire a setup token")?;
                Err(AuthError::Api {
                    source: ApiError::Unauthorized { code, message },
                })
            }
            Err(error) => Err(error.into()),
        }
    }

    /// `SetupExpired -> SetupPending`, or `-> SignedOut` when the chain is
    /// spent.
    ///
    /// Renewal signs the same `nonce:jti` challenge with the committed device
    /// key; the renewed token carries a **new** `jti`, so registration re-reads
    /// it rather than reusing the one it signed here.
    pub async fn renew_setup_token(&self) -> Result<AuthState, AuthError> {
        if self.state_now() != AuthState::SetupExpired {
            return Err(AuthError::InvalidState {
                action: "renew a setup token".to_string(),
                state: state_name(&self.state_now()),
            });
        }
        let Some(setup_token) = self.tokens.setup_token()? else {
            self.apply(AuthEvent::SetupNotRenewable, "abandon a setup token")?;
            return Err(AuthError::NoSetupToken);
        };
        let claims = TokenClaims::parse(&setup_token)?;
        let jti = claims.require_jti()?.to_string();
        let (_public, challenge_nonce, challenge_signature) = self.signed_challenge(&jti)?;

        let request = RenewSetupTokenRequest {
            setup_token,
            challenge_nonce,
            challenge_signature,
        };
        match AuthRoutes::renew_setup_token(&self.http, &request).await {
            Ok(response) => {
                self.tokens.store_setup_token(&response.setup_token)?;
                self.apply(AuthEvent::SetupTokenRenewed, "renew a setup token")
            }
            Err(error) => {
                self.apply(AuthEvent::SetupNotRenewable, "abandon a setup token")?;
                Err(error.into())
            }
        }
    }

    /// `Registered -> Refreshing -> Registered`, or to `SessionExpired`.
    ///
    /// Also the `SessionExpired -> Registered` edge: a later refresh that
    /// succeeds brings the session back without a new sign-in.
    pub async fn refresh(&self) -> Result<AuthState, AuthError> {
        let entering = self.state_now();
        if entering == AuthState::Registered {
            self.apply(AuthEvent::RefreshStarted, "refresh")?;
        } else if entering != AuthState::SessionExpired {
            return Err(AuthError::InvalidState {
                action: "refresh".to_string(),
                state: state_name(&entering),
            });
        }

        match self.tokens.refresh(None).await {
            Ok(_) => self.apply(AuthEvent::RefreshSucceeded, "finish a refresh"),
            Err(error) => {
                // Only a refusal moves the machine. A transport failure leaves
                // a `Refreshing` session refreshing: the token is still good
                // and the next attempt is the ordinary one.
                let refused = matches!(
                    error,
                    AuthError::SessionExpired | AuthError::RefreshBlocked { .. }
                );
                // A session already in `SessionExpired` stays there: §C.1 draws
                // no self-edge, and reporting the absent edge would mask the
                // refusal the caller actually needs to see.
                if refused && self.state_now() != AuthState::SessionExpired {
                    self.apply(AuthEvent::RefreshRefused, "refuse a refresh")?;
                }
                Err(error)
            }
        }
    }

    /// The server says this device is revoked. Terminal until the user acts,
    /// and the caller removes local vault content **before** rendering it.
    pub fn mark_revoked(&self) -> Result<AuthState, AuthError> {
        self.tokens.clear()?;
        self.apply(AuthEvent::DeviceRevoked, "revoke this device")
    }

    /// FR-025. Every secure store entry goes; the databases and `images/` are
    /// the caller's to remove, because this type does not own them.
    pub async fn sign_out(&self) -> Result<AuthState, AuthError> {
        if self.state_now() == AuthState::Registered {
            // Best effort: a server that cannot be reached does not get to
            // keep the user signed in on this device.
            let _ = AuthRoutes::logout(&self.http).await;
        }
        self.tokens.clear()?;
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            *pending = PendingSignIn::default();
        }
        self.apply(AuthEvent::SignedOutByUser, "sign out")
    }
}
