//! Authentication and session over the wire, chapter 02.
//!
//! Three things live here: the wire shapes of the `/auth` routes this feature
//! uses, the device challenge, and the token lifecycle — the part of chapter 02
//! that is policy rather than JSON.
//!
//! **The rejection latch is the load-bearing piece.** Chapter 02 §2.9: outside
//! a ten-second grace window an unknown refresh token revokes every token for
//! the device, so a client that retries a refused refresh locks itself out.
//! §2.10 therefore forbids retrying a 401 inline, backs off 60 s then 300 s,
//! and blocks refresh permanently after the third. The reason is on record:
//! fifteen demand-driven callers on one install produced 58 requests in 47
//! minutes once the access token was permanently dead.
//!
//! **Refresh is single-flighted.** One in-flight attempt is shared by every
//! concurrent caller; a second caller that arrives while the first is on the
//! wire takes the first's result rather than starting its own.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};

use crate::api::errors::{ApiError, AuthError, CryptoError};
use crate::crypto::sodium;
use crate::protocol::http::{ApiRequest, Auth, HttpClient, RetryPolicy, TokenProvider};
use crate::seams::secure_store::{SecureStore, SecureStoreKey};

mod oauth;

pub use oauth::{NativeOAuthRequest, NativeOAuthResponse};

/// Chapter 02 §2.10 and §2.11, verbatim.
pub const ACCESS_TOKEN_EXPIRY_SECONDS: u64 = 900;
pub const EXPIRY_SAFETY_MARGIN_SECONDS: u64 = 60;
pub const REFRESH_MAX_RETRIES: u32 = 3;
pub const REFRESH_BACKOFF_BASE_MS: u64 = 1_000;
pub const FALLBACK_RETRY_THRESHOLD_S: u64 = 60;
pub const REFRESH_REJECT_TERMINAL_ATTEMPTS: u32 = 3;
pub const REFRESH_REJECT_BACKOFF_MS: [u64; 2] = [60_000, 300_000];
/// Chapter 02 §2.11: the OTP is six digits and lives ten minutes.
pub const OTP_LENGTH: usize = 6;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct RequestOtpRequest {
    pub email: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestOtpResponse {
    pub success: bool,
    pub expires_in: Option<u64>,
    pub message: Option<String>,
}

/// `sessionNonce` and `devicePublicKey` are omitted rather than sent as null:
/// both are `z.string().optional()` server-side, which rejects an explicit
/// null (chapter 02 §2.5, §2.6).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyOtpRequest {
    pub email: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_public_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyOtpResponse {
    pub success: bool,
    pub setup_token: Option<String>,
    pub user_id: Option<String>,
    pub is_new_user: Option<bool>,
    pub needs_setup: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenewSetupTokenRequest {
    pub setup_token: String,
    pub challenge_nonce: String,
    pub challenge_signature: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenewSetupTokenResponse {
    pub success: bool,
    pub setup_token: String,
}

/// Chapter 02 §2.12: **not** `CLIENT_PLATFORMS`. A desktop registers as
/// `macos`, `windows` or `linux` here and identifies itself as `desktop` in
/// `x-memry-client`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum DevicePlatform {
    Macos,
    Windows,
    Linux,
    Ios,
    Android,
    Web,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRegisterRequest {
    pub name: String,
    pub platform: DevicePlatform,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    pub app_version: String,
    pub auth_public_key: String,
    pub challenge_signature: String,
    pub challenge_nonce: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRegisterResponse {
    pub success: bool,
    pub device_id: Option<String>,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshTokenRequest {
    pub refresh_token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshTokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// The claims chapter 02 §2.2 requires, read out of a token this client holds.
///
/// **Never verified here.** The signing key is the server's Ed25519 key and a
/// client does not hold it; the client reads its own token only to learn the
/// `jti` it must sign and the `exp` it must schedule against
/// (chapter 02 §2.2).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TokenClaims {
    #[serde(default)]
    pub sub: String,
    #[serde(default)]
    pub jti: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub exp: Option<u64>,
    #[serde(rename = "type", default)]
    pub token_type: Option<String>,
}

impl TokenClaims {
    /// Decodes the payload segment. base64url without padding, as JWT requires.
    pub fn parse(token: &str) -> Result<Self, AuthError> {
        let mut segments = token.split('.');
        let (Some(_header), Some(payload), Some(_signature), None) = (
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
        ) else {
            return Err(AuthError::MalformedToken {
                what: "a JWT has exactly three dot-separated segments".to_string(),
            });
        };
        let bytes = URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|e| AuthError::MalformedToken {
                what: e.to_string(),
            })?;
        serde_json::from_slice(&bytes).map_err(|e| AuthError::MalformedToken {
            what: e.to_string(),
        })
    }

    /// The `jti` a device challenge signs over (chapter 02 §2.3.1).
    pub fn require_jti(&self) -> Result<&str, AuthError> {
        self.jti.as_deref().ok_or(AuthError::MalformedToken {
            what: "setup token carries no jti".to_string(),
        })
    }

    /// Chapter 02 §2.10: a token within `EXPIRY_SAFETY_MARGIN_SECONDS` of its
    /// `exp` counts as expired. A token with no `exp` is treated as expired
    /// too — §2.2 requires the claim, so its absence is not a reason to trust
    /// the token for longer.
    pub fn is_expired(&self, now_s: u64) -> bool {
        match self.exp {
            Some(exp) => exp <= now_s.saturating_add(EXPIRY_SAFETY_MARGIN_SECONDS),
            None => true,
        }
    }

    pub fn remaining_life_s(&self, now_s: u64) -> u64 {
        self.exp.unwrap_or(0).saturating_sub(now_s)
    }
}

pub fn now_unix_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

/// Chapter 02 §2.10: proactive refresh at 50 % to 70 % of the token's life,
/// `floor(expiresIn * (0.5 + rand * 0.2))` seconds.
///
/// The draw is a parameter so the schedule is testable; `refresh_delay_ms`
/// supplies it from the CSPRNG.
pub fn refresh_delay_ms_with(expires_in_s: u64, draw: f64) -> u64 {
    let fraction = 0.5 + draw.clamp(0.0, 1.0) * 0.2;
    ((expires_in_s as f64 * fraction).floor() as u64).saturating_mul(1_000)
}

pub fn refresh_delay_ms(expires_in_s: u64) -> u64 {
    refresh_delay_ms_with(expires_in_s, unit_draw())
}

/// A uniform draw in `[0, 1)` from libsodium's CSPRNG, so no second random
/// source enters the crate.
fn unit_draw() -> f64 {
    let bytes = sodium::random_bytes(4);
    let raw = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    f64::from(raw) / f64::from(u32::MAX)
}

/// Chapter 02 §2.10's `FALLBACK_RETRY_THRESHOLD_S`: after the ladder is spent,
/// one late retry is worth scheduling only while the token still has enough
/// life to be worth saving.
pub fn fallback_retry_worthwhile(remaining_life_s: u64) -> bool {
    remaining_life_s >= FALLBACK_RETRY_THRESHOLD_S
}

// ---------------------------------------------------------------------------
// The device challenge
// ---------------------------------------------------------------------------

/// The bytes `POST /auth/devices` and `POST /auth/setup-token/renew` sign.
///
/// Chapter 02 §2.3.1: the UTF-8 of `` `${challengeNonce}:${jti}` ``. **No
/// domain separation prefix and no CBOR** — and §2.3.2 closes Q02.2 on the
/// condition that any *third* signing context for this key carries one.
pub fn device_challenge_message(challenge_nonce: &str, jti: &str) -> Vec<u8> {
    format!("{challenge_nonce}:{jti}").into_bytes()
}

/// Ed25519 detached over the challenge, standard base64 (chapter 02 §2.3.1).
pub fn sign_device_challenge(
    challenge_nonce: &str,
    jti: &str,
    signing_secret_key: &[u8],
) -> Result<String, CryptoError> {
    let message = device_challenge_message(challenge_nonce, jti);
    let signature = sodium::sign_detached(&message, signing_secret_key)?;
    Ok(BASE64_STANDARD.encode(signature))
}

/// A client-minted nonce, chapter 02 §2.3.2: from a CSPRNG, and **never** one a
/// server supplied. Shaped as a v4 UUID because that is what the reference
/// client sends; the contract only requires a non-empty string.
pub fn random_nonce() -> String {
    let b = sodium::random_bytes(16);
    let (v, r) = ((b[6] & 0x0f) | 0x40, (b[8] & 0x3f) | 0x80);
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{v:02x}{:02x}-{r:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[7], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
}

// ---------------------------------------------------------------------------
// The token manager
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct RejectionLatch {
    /// Consecutive 401s on refresh.
    count: u32,
    /// When the current window ends. `tokio`'s clock rather than the wall
    /// clock, because this is a duration the runtime measures and a device
    /// whose wall clock is wrong (chapter 05 §5.16) must not get a different
    /// backoff for it.
    blocked_until: Option<tokio::time::Instant>,
}

/// Holds the session's tokens and owns chapter 02 §2.10's lifecycle.
///
/// The `HttpClient` it refreshes over carries **no** `TokenProvider`, which is
/// what keeps a 401 on `/auth/refresh` from re-entering refresh.
pub struct TokenManager {
    store: Arc<dyn SecureStore>,
    http: Arc<HttpClient>,
    /// The single-flight gate. Held across the network call on purpose: a
    /// second caller waits and then finds the token already replaced.
    flight: tokio::sync::Mutex<()>,
    latch: Mutex<RejectionLatch>,
}

impl TokenManager {
    pub fn new(store: Arc<dyn SecureStore>, http: Arc<HttpClient>) -> Self {
        Self {
            store,
            http,
            flight: tokio::sync::Mutex::new(()),
            latch: Mutex::new(RejectionLatch::default()),
        }
    }

    fn read(&self, key: SecureStoreKey) -> Result<Option<String>, AuthError> {
        let Some(bytes) = self.store.get(key)? else {
            return Ok(None);
        };
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| AuthError::MalformedToken {
                what: "secure store entry is not UTF-8".to_string(),
            })
    }

    fn write(&self, key: SecureStoreKey, value: &str) -> Result<(), AuthError> {
        self.store.set(key, value.as_bytes().to_vec())?;
        Ok(())
    }

    pub fn access_token_sync(&self) -> Result<Option<String>, AuthError> {
        self.read(SecureStoreKey::AccessToken)
    }

    pub fn refresh_token(&self) -> Result<Option<String>, AuthError> {
        self.read(SecureStoreKey::RefreshToken)
    }

    pub fn setup_token(&self) -> Result<Option<String>, AuthError> {
        self.read(SecureStoreKey::SetupToken)
    }

    pub fn store_setup_token(&self, token: &str) -> Result<(), AuthError> {
        self.write(SecureStoreKey::SetupToken, token)
    }

    /// Stores a fresh pair and retires the setup token: chapter 02 §2.3.3
    /// makes a setup token single-use, so keeping it is keeping a spent
    /// secret.
    pub fn store_session(&self, access: &str, refresh: &str) -> Result<(), AuthError> {
        self.write(SecureStoreKey::AccessToken, access)?;
        self.write(SecureStoreKey::RefreshToken, refresh)?;
        self.store.delete(SecureStoreKey::SetupToken)?;
        self.reset_latch();
        Ok(())
    }

    /// Sign-out and revocation, data-model §B: every entry goes.
    pub fn clear(&self) -> Result<(), AuthError> {
        self.store.clear()?;
        self.reset_latch();
        Ok(())
    }

    fn reset_latch(&self) {
        let mut latch = self.latch.lock().unwrap_or_else(|e| e.into_inner());
        *latch = RejectionLatch::default();
    }

    /// How long refresh is blocked for, or `None` when it may run.
    /// `Some(0)` means the latch is permanent (chapter 02 §2.10).
    pub fn refresh_block_ms(&self) -> Option<u64> {
        let latch = self.latch.lock().unwrap_or_else(|e| e.into_inner());
        if latch.count >= REFRESH_REJECT_TERMINAL_ATTEMPTS {
            return Some(0);
        }
        let until = latch.blocked_until?;
        let now = tokio::time::Instant::now();
        (until > now).then(|| (until - now).as_millis() as u64)
    }

    /// Records a 401 and arms the next window.
    fn reject(&self) -> AuthError {
        let mut latch = self.latch.lock().unwrap_or_else(|e| e.into_inner());
        latch.count += 1;
        if latch.count >= REFRESH_REJECT_TERMINAL_ATTEMPTS {
            latch.blocked_until = None;
            return AuthError::SessionExpired;
        }
        let backoff = REFRESH_REJECT_BACKOFF_MS[(latch.count as usize - 1).min(1)];
        latch.blocked_until = Some(tokio::time::Instant::now() + Duration::from_millis(backoff));
        AuthError::RefreshBlocked {
            retry_in_ms: backoff,
        }
    }

    /// One refresh, single-flighted and latched.
    ///
    /// `stale` is the access token the caller sent. A caller that arrives after
    /// another has already replaced it gets the current token for free, which
    /// is the whole point of the single flight.
    pub async fn refresh(&self, stale: Option<&str>) -> Result<String, AuthError> {
        let _flight = self.flight.lock().await;

        if let Some(stale) = stale
            && let Some(current) = self.access_token_sync()?
            && current != stale
        {
            return Ok(current);
        }

        match self.refresh_block_ms() {
            Some(0) => return Err(AuthError::SessionExpired),
            Some(retry_in_ms) => return Err(AuthError::RefreshBlocked { retry_in_ms }),
            None => {}
        }

        let Some(refresh_token) = self.refresh_token()? else {
            return Err(AuthError::SessionExpired);
        };

        let mut attempt = 0u32;
        loop {
            let request = ApiRequest::post("/auth/refresh")
                .json(&RefreshTokenRequest {
                    refresh_token: refresh_token.clone(),
                })
                // §2.10 owns this ladder, so the HTTP client's own one stays
                // out of the way: two ladders on the same call would multiply.
                .retry(RetryPolicy::never());

            match self.http.send_json::<RefreshTokenResponse>(request).await {
                Ok(response) => {
                    self.store_session(&response.access_token, &response.refresh_token)?;
                    return Ok(response.access_token);
                }
                // Never retried inline (chapter 02 §2.9): outside the ten
                // second grace window an unknown refresh token revokes every
                // token this device holds.
                Err(ApiError::Unauthorized { .. }) => return Err(self.reject()),
                Err(error) => {
                    if attempt >= REFRESH_MAX_RETRIES {
                        return Err(AuthError::Api { source: error });
                    }
                    let delay = REFRESH_BACKOFF_BASE_MS.saturating_mul(1u64 << attempt);
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
            }
        }
    }
}

#[async_trait::async_trait]
impl TokenProvider for TokenManager {
    async fn access_token(&self) -> Option<String> {
        self.access_token_sync().ok().flatten()
    }

    async fn refresh(&self, stale: &str) -> Result<String, ApiError> {
        match TokenManager::refresh(self, Some(stale)).await {
            Ok(token) => Ok(token),
            Err(AuthError::Api { source }) => Err(source),
            Err(other) => Err(ApiError::Unauthorized {
                code: "AUTH_INVALID_TOKEN".to_string(),
                message: other.to_string(),
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

/// The `/auth` calls this feature makes, as plain functions over a client.
pub struct AuthRoutes;

impl AuthRoutes {
    pub async fn request_otp(
        http: &HttpClient,
        email: &str,
    ) -> Result<RequestOtpResponse, ApiError> {
        http.send_json(
            ApiRequest::post("/auth/otp/request").json(&RequestOtpRequest {
                email: email.to_string(),
            }),
        )
        .await
    }

    pub async fn resend_otp(http: &HttpClient, email: &str) -> Result<(), ApiError> {
        http.send(
            ApiRequest::post("/auth/otp/resend").json(&RequestOtpRequest {
                email: email.to_string(),
            }),
        )
        .await
        .map(|_| ())
    }

    pub async fn verify_otp(
        http: &HttpClient,
        request: &VerifyOtpRequest,
    ) -> Result<VerifyOtpResponse, ApiError> {
        http.send_json(ApiRequest::post("/auth/otp/verify").json(request))
            .await
    }

    /// `POST /auth/devices`, authorised by the **setup token**.
    pub async fn register_device(
        http: &HttpClient,
        setup_token: &str,
        request: &DeviceRegisterRequest,
    ) -> Result<DeviceRegisterResponse, ApiError> {
        http.send_json(
            ApiRequest::post("/auth/devices")
                .json(request)
                .auth(Auth::Bearer(setup_token.to_string())),
        )
        .await
    }

    /// `POST /auth/setup-token/renew`. **Not** a bearer operation: chapter 02
    /// §2.5 authorises it by proof of possession of the committed device key,
    /// so an intercepted setup token is worth the same five minutes it was
    /// worth before.
    pub async fn renew_setup_token(
        http: &HttpClient,
        request: &RenewSetupTokenRequest,
    ) -> Result<RenewSetupTokenResponse, ApiError> {
        http.send_json(ApiRequest::post("/auth/setup-token/renew").json(request))
            .await
    }

    pub async fn logout(http: &HttpClient) -> Result<(), ApiError> {
        http.send(ApiRequest::post("/auth/logout").auth(Auth::Session))
            .await
            .map(|_| ())
    }
}
