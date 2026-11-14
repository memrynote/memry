//! The two provider sign-in routes of chapter 02: `POST /auth/oauth/:provider/native`
//! (§2.13) and the browser callback `POST /auth/oauth/:provider/callback`.
//!
//! The native route skips the authorization-code exchange and picks the flow
//! up at ID token validation, after which it is the same path — user lookup,
//! entitlement, setup token — that the callback takes, so both answer
//! [`OAuthSignInResponse`].
//!
//! They live beside [`super::AuthRoutes`]'s other routes rather than inside
//! `auth.rs` because that file is at its line ceiling; the split is by
//! responsibility — the routes whose requests the shell cannot assemble,
//! because the nonce and the device key are core-private.

use serde::{Deserialize, Serialize};

use crate::api::errors::ApiError;
use crate::protocol::http::{ApiRequest, HttpClient};

use super::AuthRoutes;

/// Chapter 02 §2.13: all three fields are required. `session_nonce` is the one
/// minted for this attempt — the setup token that comes back is signed over
/// it, and registration must present the same value (§2.6).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOAuthRequest {
    pub id_token: String,
    pub session_nonce: String,
    pub device_public_key: String,
}

/// The browser callback's body: `OAuthCallbackSchema`
/// (`packages/contracts/src/auth-api.ts:53`) plus `redirectUri`.
///
/// `redirectUri` is not in the schema and the server takes the redirect from
/// the signed `state` instead (`apps/sync-server/src/routes/auth.ts:346-347`);
/// it is sent because Electron sends it
/// (`apps/desktop/src/main/ipc/auth-oauth-handlers.ts:239-246`), so both
/// clients put the same body on the wire.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCallbackRequest {
    pub code: String,
    pub state: String,
    pub redirect_uri: String,
    pub session_nonce: String,
    pub device_public_key: String,
}

/// `{ success, isNewUser, needsSetup, knownDevice, setupToken }`, the answer of
/// both provider routes (`OAuthCallbackResponseSchema`,
/// `packages/contracts/src/auth-api.ts:131`).
///
/// The flags are read as options for the same reason
/// [`super::VerifyOtpResponse`] reads them that way: a body that omits one is
/// still a body, and the missing `setupToken` — never a missing flag — is what
/// the caller reports.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthSignInResponse {
    pub success: bool,
    pub is_new_user: Option<bool>,
    /// True when the account has no `kdf_salt` yet, which is the difference
    /// between "create a recovery phrase" and "unlock with the one you have".
    pub needs_setup: Option<bool>,
    /// The account still lists this device's signing key. Servers before the
    /// field omit it, which reads as false (chapter 02, `POST /auth/otp/verify`).
    pub known_device: Option<bool>,
    pub setup_token: Option<String>,
}

impl AuthRoutes {
    /// `POST /auth/oauth/:provider/native`. Unauthenticated: the ID token is
    /// the credential, and there is no session yet to bear.
    ///
    /// The default retry ladder is the right one here: chapter 00 §0.5 makes
    /// only 500, 502 and 503 retryable, so the `501` a deployment without
    /// `GOOGLE_IOS_CLIENT_ID` answers is fatal on the first attempt rather than
    /// retried into a ladder that cannot change its mind — and §2.13 is
    /// explicit that the `501` is not a fallback to the web OAuth client.
    pub async fn sign_in_with_provider(
        http: &HttpClient,
        provider: &str,
        request: &NativeOAuthRequest,
    ) -> Result<OAuthSignInResponse, ApiError> {
        http.send_json(ApiRequest::post(&format!("/auth/oauth/{provider}/native")).json(request))
            .await
    }

    /// `POST /auth/oauth/:provider/callback`. Unauthenticated, like the native
    /// route: the authorization code is the credential. Same retry ladder, for
    /// the same reason — a refused code is fatal on the first answer.
    pub async fn sign_in_with_web_callback(
        http: &HttpClient,
        provider: &str,
        request: &OAuthCallbackRequest,
    ) -> Result<OAuthSignInResponse, ApiError> {
        http.send_json(ApiRequest::post(&format!("/auth/oauth/{provider}/callback")).json(request))
            .await
    }
}
