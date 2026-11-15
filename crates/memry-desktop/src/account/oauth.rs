//! Google sign-in over the loopback (`apps/desktop/src/main/ipc/auth-oauth-handlers.ts`).
//!
//! 1. Bind a [`OneShotCallback`] and ask the server for the Google URL with its `redirect_uri`
//!    (`GET /auth/oauth/google?redirect_uri=`), redirects off, reading `location` and its `state`.
//! 2. Open the session's attempt with that `state` and `redirect_uri`
//!    (`begin_provider_web_sign_in`); the shell opens the browser.
//! 3. The loopback's code reaches the renderer as an event, and the renderer hands it back to
//!    [`AccountService::setup_first_device`], which exchanges it once
//!    (`complete_provider_web_callback`) and runs setup or the known-device path.
//!
//! A declined consent or ten minutes without a callback ends the attempt. The code, the `state`
//! and the Google URL (which carries the `state`) are never logged.

use std::sync::{Arc, PoisonError};
use std::time::Duration;

use memry_core::api::auth::{AuthProvider, AuthState};
use memry_core::api::errors::ApiError;
use memry_core::seams::transport::HttpRequest;
use url::Url;

use super::{AccountError, AccountService};
use crate::oauth::loopback::{CallbackOutcome, OneShotCallback};
use crate::seams::transport::NoRedirect;

/// `OAUTH_SESSION_TIMEOUT_MS` (`ipc/auth-oauth-state.ts:14`).
pub const OAUTH_ATTEMPT_TTL: Duration = Duration::from_secs(10 * 60);
/// `OAUTH_INIT_REQUEST_TIMEOUT_MS` (`ipc/auth-oauth-handlers.ts:50`).
const INIT_TIMEOUT_MS: u64 = 15_000;

/// The attempt the browser was sent to.
#[derive(Clone, PartialEq, Eq)]
pub struct OAuthStarted {
    pub state: String,
    pub authorization_url: String,
}

/// What the loopback heard, for the renderer (`sync:oauth-callback`, `sync:oauth-error`).
#[derive(Clone, PartialEq, Eq)]
pub enum OAuthEvent {
    Callback {
        code: String,
        state: String,
    },
    /// The user declined consent in the browser.
    Cancelled,
    /// Nothing came back within [`OAUTH_ATTEMPT_TTL`].
    Expired,
}

impl std::fmt::Debug for OAuthEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Callback { .. } => f.write_str("Callback { <redacted> }"),
            Self::Cancelled => f.write_str("Cancelled"),
            Self::Expired => f.write_str("Expired"),
        }
    }
}

/// `SETUP_FIRST_DEVICE`'s answer (`ipc/auth-oauth-handlers.ts:244-273`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirstDevice {
    pub needs_recovery_setup: bool,
    pub needs_recovery_input: bool,
    pub device_id: Option<String>,
}

/// The browser attempt in flight: its `state`, the URL a retry reopens (retired once a code
/// arrived) and the task waiting on its loopback.
pub(super) struct OAuthAttempt {
    state: String,
    authorization_url: Option<String>,
    waiter: tokio::task::AbortHandle,
}

impl OAuthAttempt {
    /// Closes its loopback and silences its event.
    fn cancel(self) {
        self.waiter.abort();
    }
}

impl AccountService {
    /// `AUTH_INIT_OAUTH`: ends any sign-in in flight, binds the loopback, reads the Google URL
    /// and opens the session's attempt. `on_event` hears the loopback's one answer.
    pub async fn init_oauth(
        self: &Arc<Self>,
        probe: &dyn NoRedirect,
        on_event: impl Fn(OAuthEvent) + Send + Sync + 'static,
    ) -> Result<OAuthStarted, AccountError> {
        self.end_pending_sign_in()?;
        let callback = OneShotCallback::bind(OAUTH_ATTEMPT_TTL)
            .await
            .map_err(|error| {
                tracing::warn!(
                    scope = "Account",
                    "the sign-in loopback did not bind: {error}"
                );
                AccountError::OAuthLoopback
            })?;
        let redirect_uri = callback.redirect_uri();
        let mut url = Url::parse(&format!("{}/auth/oauth/google", self.base_url))
            .map_err(|_| AccountError::OAuthInvalidResponse)?;
        url.query_pairs_mut()
            .append_pair("redirect_uri", &redirect_uri);
        let response = probe
            .send_no_redirect(HttpRequest {
                method: "GET".into(),
                url: url.into(),
                headers: Default::default(),
                body: None,
                timeout_ms: INIT_TIMEOUT_MS,
            })
            .await
            .map_err(ApiError::from)?;
        let (authorization_url, state) = response
            .headers
            .get("location")
            .and_then(|location| provider_url(location))
            .ok_or_else(|| {
                tracing::warn!(
                    scope = "Account",
                    status = response.status,
                    "the server answered the sign-in request with no usable provider URL"
                );
                AccountError::OAuthInvalidResponse
            })?;
        self.session.begin_provider_web_sign_in(
            AuthProvider::Google,
            state.clone(),
            redirect_uri,
        )?;
        callback.expect_state(&state);

        let service = Arc::clone(self);
        let attempt_state = state.clone();
        let waiter = tokio::spawn(async move {
            match callback.outcome().await {
                CallbackOutcome::Code { code, state } => {
                    service.retire_retry(&attempt_state);
                    on_event(OAuthEvent::Callback { code, state });
                }
                CallbackOutcome::Denied => {
                    if service.end_attempt(&attempt_state) {
                        on_event(OAuthEvent::Cancelled);
                    }
                }
                CallbackOutcome::Expired => {
                    if service.end_attempt(&attempt_state) {
                        on_event(OAuthEvent::Expired);
                    }
                }
            }
        });
        let replaced = self
            .oauth
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .replace(OAuthAttempt {
                state: state.clone(),
                authorization_url: Some(authorization_url.clone()),
                waiter: waiter.abort_handle(),
            });
        // Two starts at once: the later one is the user's attempt.
        if let Some(replaced) = replaced {
            replaced.cancel();
        }
        Ok(OAuthStarted {
            state,
            authorization_url,
        })
    }

    /// `AUTH_RETRY_OAUTH`: the Google URL of the attempt still waiting for its browser.
    pub fn oauth_retry_url(&self, state: &str) -> Result<String, AccountError> {
        self.oauth
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .filter(|attempt| attempt.state == state)
            .and_then(|attempt| attempt.authorization_url.clone())
            .ok_or(AccountError::OAuthExpired)
    }

    /// `SETUP_FIRST_DEVICE`: the code exchanged once, then setup for a new account or the
    /// known-device path. A setup another device finished first sends the user to the phrase,
    /// as an email sign-in does.
    pub async fn setup_first_device(
        &self,
        code: String,
        state: String,
    ) -> Result<FirstDevice, AccountError> {
        // The attempt is spent whatever the exchange answers (`consumeOAuthSession`).
        {
            let mut attempt = self.oauth.lock().unwrap_or_else(PoisonError::into_inner);
            if attempt.as_ref().is_some_and(|a| a.state == state)
                && let Some(spent) = attempt.take()
            {
                spent.cancel();
            }
        }
        let outcome = self
            .session
            .complete_provider_web_callback(code, state)
            .await?;
        if outcome.needs_setup {
            return match self.setup_new_account().await {
                Ok(device_id) => Ok(FirstDevice {
                    needs_recovery_setup: true,
                    needs_recovery_input: false,
                    device_id: Some(device_id),
                }),
                Err(AccountError::SetupConflict) => Ok(FirstDevice {
                    needs_recovery_setup: true,
                    needs_recovery_input: true,
                    device_id: None,
                }),
                Err(error) => Err(error),
            };
        }
        let device_id = if outcome.known_device {
            self.sign_in_known_device().await?
        } else {
            None
        };
        Ok(FirstDevice {
            needs_recovery_setup: device_id.is_none(),
            needs_recovery_input: device_id.is_none(),
            device_id,
        })
    }

    /// Ends the browser attempt in flight, if any: its loopback closes and the session leaves
    /// `AwaitingProviderToken`.
    pub(super) fn end_oauth_attempt(&self) -> Result<(), AccountError> {
        let attempt = self
            .oauth
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(attempt) = attempt {
            attempt.cancel();
        }
        if matches!(
            self.session.state(),
            AuthState::AwaitingProviderToken { .. }
        ) {
            self.session.abandon_provider_sign_in()?;
        }
        Ok(())
    }

    /// A code arrived: the browser is not reopened for this attempt any more.
    fn retire_retry(&self, state: &str) {
        if let Some(attempt) = self
            .oauth
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_mut()
            .filter(|attempt| attempt.state == state)
        {
            attempt.authorization_url = None;
        }
    }

    /// The loopback gave up on `state` (declined or expired): the attempt ends, unless a newer one
    /// replaced it. `true` when it ended here.
    fn end_attempt(&self, state: &str) -> bool {
        {
            let mut attempt = self.oauth.lock().unwrap_or_else(PoisonError::into_inner);
            if !attempt
                .as_ref()
                .is_some_and(|current| current.state == state)
            {
                return false;
            }
            // Not cancelled: the waiter is the task running this.
            attempt.take();
        }
        if matches!(
            self.session.state(),
            AuthState::AwaitingProviderToken { .. }
        ) && let Err(error) = self.session.abandon_provider_sign_in()
        {
            tracing::warn!(
                scope = "Account",
                "the sign-in attempt did not end: {error}"
            );
        }
        true
    }
}

/// `https` and a non-empty `state`, or nothing (`auth-oauth-handlers.ts:128-146`).
fn provider_url(location: &str) -> Option<(String, String)> {
    let url = Url::parse(location).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    let state = url
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .filter(|state| !state.is_empty())?;
    Some((url.into(), state))
}
