//! `POST /auth/oauth/:provider/native`, chapter 02 §2.13.
//!
//! The mobile counterpart of the browser callback: it skips the
//! authorization-code exchange and picks the flow up at ID token validation,
//! after which it is the same path — user lookup, entitlement, setup token —
//! that `POST /auth/oauth/:provider/callback` takes.
//!
//! It lives beside [`super::AuthRoutes`]'s other routes rather than inside
//! `auth.rs` because that file is at its line ceiling; the split is by
//! responsibility — one route, the one whose request the shell cannot
//! assemble, because two of its three fields are core-private.

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

/// `{ success, isNewUser, needsSetup, setupToken }`.
///
/// The flags are read as options for the same reason
/// [`super::VerifyOtpResponse`] reads them that way: a body that omits one is
/// still a body, and the missing `setupToken` — never a missing flag — is what
/// the caller reports.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOAuthResponse {
    pub success: bool,
    pub is_new_user: Option<bool>,
    /// True when the account has no `kdf_salt` yet, which is the difference
    /// between "create a recovery phrase" and "unlock with the one you have".
    pub needs_setup: Option<bool>,
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
    ) -> Result<NativeOAuthResponse, ApiError> {
        http.send_json(ApiRequest::post(&format!("/auth/oauth/{provider}/native")).json(request))
            .await
    }
}
