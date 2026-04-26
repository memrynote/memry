//! Account-level state: cached user identity in `settings`, the OTP /
//! setup / refresh / sign-out flows, and recovery-confirmation
//! tracking.
//!
//! Persisted fields live under the canonical settings keys declared at
//! the top of this module. Renderer code never sees these keys
//! directly: M4 commands read/write through the helpers here so a
//! future migration can rename them without touching the renderer.
//!
//! HTTP-using flows expose two public entry points each. The
//! env-resolved variant (`request_otp`) is what production code calls;
//! the `_with_base` variant takes an explicit base URL so tests
//! coordinate against `httpmock` without racing on `SYNC_SERVER_URL`.
//!
//! Sign-out clears the access/refresh/setup tokens stored in the
//! keychain under `SERVICE_VAULT`. It deliberately leaves the master
//! key, recovery phrase, and any provider keys in place so that the
//! local vault remains usable after sign-out.

use base64::{
    engine::general_purpose::{STANDARD as B64STD, URL_SAFE_NO_PAD as B64URL},
    Engine as _,
};
use chacha20poly1305::aead::{rand_core::RngCore, OsRng};
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::auth::device::{
    self, sign_device_challenge, CurrentDeviceRecord, DeviceSigningKeyPair,
    KEYCHAIN_DEVICE_SIGNING_KEY,
};
use crate::auth::types::AuthStateKind;
use crate::auth::vault_keys::{
    read_vault_setup_material, setup_local_vault_key, update_session_metadata,
};
use crate::db::settings;
use crate::error::{AppError, AppResult};
use crate::keychain::{SERVICE_DEVICE, SERVICE_VAULT};
use crate::sync::auth_client;

/// Settings key for the cached server-issued user id.
pub const ACCOUNT_USER_ID: &str = "account.userId";
/// Settings key for the cached account email.
pub const ACCOUNT_EMAIL: &str = "account.email";
/// Settings key for the auth provider that minted the current session
/// (e.g. `otp`, `google`).
pub const ACCOUNT_AUTH_PROVIDER: &str = "account.authProvider";
/// Settings key for the user-confirmed recovery phrase flag.
pub const ACCOUNT_RECOVERY_CONFIRMED: &str = "account.recoveryConfirmed";

/// Keychain accounts under `SERVICE_VAULT` that sign-out clears.
pub const KEYCHAIN_ACCESS_TOKEN: &str = "access-token";
pub const KEYCHAIN_REFRESH_TOKEN: &str = "refresh-token";
pub const KEYCHAIN_SETUP_TOKEN: &str = "setup-token";
/// Keychain account under `SERVICE_VAULT` for the recovery phrase.
pub const KEYCHAIN_RECOVERY_PHRASE: &str = "recovery-phrase";

const RECOVERY_PHRASE_BYTES: usize = 32;

/// Persisted view of the signed-in account. `auth_provider` tracks
/// which provider issued the most recent session token so the renderer
/// can show the correct "Sign out from <provider>" affordance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountInfo {
    pub user_id: String,
    pub email: String,
    pub auth_provider: String,
}

pub fn set_account_info(state: &AppState, info: &AccountInfo) -> AppResult<()> {
    settings::set(&state.db, ACCOUNT_USER_ID, &info.user_id)?;
    settings::set(&state.db, ACCOUNT_EMAIL, &info.email)?;
    settings::set(&state.db, ACCOUNT_AUTH_PROVIDER, &info.auth_provider)?;
    Ok(())
}

/// Returns the cached account identity, if all three canonical fields
/// are set. A partial state (only email but no user id) returns
/// `Ok(None)` so callers do not act on an incomplete record.
pub fn get_account_info(state: &AppState) -> AppResult<Option<AccountInfo>> {
    let user_id = settings::get(&state.db, ACCOUNT_USER_ID)?;
    let email = settings::get(&state.db, ACCOUNT_EMAIL)?;
    let auth_provider = settings::get(&state.db, ACCOUNT_AUTH_PROVIDER)?;

    match (user_id, email, auth_provider) {
        (Some(user_id), Some(email), Some(auth_provider)) => Ok(Some(AccountInfo {
            user_id,
            email,
            auth_provider,
        })),
        _ => Ok(None),
    }
}

pub fn clear_account_info(state: &AppState) -> AppResult<()> {
    settings::set(&state.db, ACCOUNT_USER_ID, "")?;
    settings::set(&state.db, ACCOUNT_EMAIL, "")?;
    settings::set(&state.db, ACCOUNT_AUTH_PROVIDER, "")?;
    Ok(())
}

pub fn get_recovery_confirmed(state: &AppState) -> AppResult<bool> {
    Ok(settings::get_bool(&state.db, ACCOUNT_RECOVERY_CONFIRMED)?.unwrap_or(false))
}

pub fn set_recovery_confirmed(state: &AppState, value: bool) -> AppResult<()> {
    settings::set_bool(&state.db, ACCOUNT_RECOVERY_CONFIRMED, value)
}

/// Local sign-out: clears the access, refresh, and setup tokens from
/// the keychain. Leaves the master key, recovery phrase, provider
/// keys, and account settings intact so the user can sign back in
/// against the same local vault without re-derivation.
///
/// The auth runtime is *not* locked here: the caller decides whether a
/// soft sign-out (keep vault unlocked) or a hard sign-out (also lock
/// the runtime) makes sense for the calling flow.
pub fn sign_out(state: &AppState) -> AppResult<()> {
    let kc = state.auth.keychain();
    kc.delete_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN)?;
    kc.delete_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN)?;
    kc.delete_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN)?;
    Ok(())
}

/// Hard sign-out: runs `sign_out` and then locks the auth runtime so
/// the in-memory master/vault keys are dropped.
pub fn logout(state: &AppState) -> AppResult<()> {
    sign_out(state)?;
    state.auth.lock()?;
    Ok(())
}

// ---------------------------------------------------------------------
// Public API: response types for HTTP flows
// ---------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtpRequestResult {
    pub success: bool,
    /// Seconds until the OTP code expires. Mirrors the server's
    /// `expiresIn` field (a duration, not an absolute instant).
    pub expires_in: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtpVerifyResult {
    pub needs_setup: bool,
}

/// Input for the new-device setup flow. Combines local vault setup
/// (password + remember-device) with the device-registration metadata
/// the auth server stores under `/auth/devices`.
#[derive(Debug, Clone)]
pub struct SetupAccountInput {
    pub password: String,
    pub remember_device: bool,
    pub email: String,
    pub device_name: String,
    pub platform: String,
    pub os_version: Option<String>,
    pub app_version: String,
}

/// Result returned to the caller after `setup_new_account` succeeds.
/// The recovery phrase is also persisted in the keychain; this struct
/// re-emits it once so the renderer can show it inline.
#[derive(Debug, Clone)]
pub struct SetupAccountResult {
    pub device_id: String,
    pub recovery_phrase: String,
}

/// Internal HTTP request bodies and response shapes. Kept private to
/// this module: the public API uses the typed structs above so future
/// changes to the wire format do not leak into renderer code.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OtpRequestBody<'a> {
    email: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OtpRequestResponse {
    success: bool,
    #[serde(default)]
    expires_in: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OtpVerifyBody<'a> {
    email: &'a str,
    code: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OtpVerifyResponse {
    needs_setup: bool,
    #[serde(default)]
    setup_token: Option<String>,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterDeviceBody<'a> {
    name: &'a str,
    platform: &'a str,
    os_version: Option<&'a str>,
    app_version: &'a str,
    auth_public_key: &'a str,
    challenge_signature: &'a str,
    challenge_nonce: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterDeviceResponse {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FirstDeviceSetupBody<'a> {
    kdf_salt: &'a str,
    key_verifier: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FirstDeviceSetupResponse {
    #[serde(default)]
    success: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshBody<'a> {
    refresh_token: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshResponse {
    access_token: String,
    refresh_token: String,
}

// ---------------------------------------------------------------------
// Public API: OTP flows
// ---------------------------------------------------------------------

/// Sends an OTP request for `email`. Resolves `SYNC_SERVER_URL` at
/// call time.
pub async fn request_otp(state: &AppState, email: &str) -> AppResult<OtpRequestResult> {
    let base = crate::sync::http::resolve_base_url()?;
    request_otp_with_base(&base, state, email).await
}

/// Same as `request_otp` but pinned to an explicit base URL. Used by
/// tests; production code calls `request_otp`.
pub async fn request_otp_with_base(
    base_url: &str,
    _state: &AppState,
    email: &str,
) -> AppResult<OtpRequestResult> {
    let body = OtpRequestBody { email };
    let resp: OtpRequestResponse = auth_client::request_otp_with_base(base_url, &body).await?;
    Ok(OtpRequestResult {
        success: resp.success,
        expires_in: resp.expires_in,
    })
}

/// Verifies an OTP code and stores the appropriate keychain artifact:
///
/// - new account: stores `setup_token` under `SERVICE_VAULT/setup-token`.
/// - existing account: stores `access_token` and `refresh_token` and
///   clears any stale setup token.
pub async fn verify_otp(
    state: &AppState,
    email: &str,
    code: &str,
) -> AppResult<OtpVerifyResult> {
    let base = crate::sync::http::resolve_base_url()?;
    verify_otp_with_base(&base, state, email, code).await
}

pub async fn verify_otp_with_base(
    base_url: &str,
    state: &AppState,
    email: &str,
    code: &str,
) -> AppResult<OtpVerifyResult> {
    let body = OtpVerifyBody { email, code };
    let resp: OtpVerifyResponse =
        auth_client::verify_otp_with_base(base_url, &body, None).await?;

    let kc = state.auth.keychain();

    // The server returns a setup token on every successful OTP verify
    // (both new and existing users). For new users it gates `/auth/devices`;
    // for existing users it gates the device-registration / recovery
    // follow-up that mints the access/refresh pair.
    if let Some(token) = resp.setup_token.as_deref() {
        kc.set_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN, token.as_bytes())?;
    } else if resp.needs_setup {
        return Err(AppError::Auth(
            "server did not return a setup token".into(),
        ));
    }

    // Some flows (post-setup re-auth on a known device) may eventually
    // ship access/refresh tokens directly. If both arrive, take the fast
    // path and clear the setup token: registration is unnecessary.
    if let (Some(access), Some(refresh)) = (
        resp.access_token.as_deref(),
        resp.refresh_token.as_deref(),
    ) {
        kc.set_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN, access.as_bytes())?;
        kc.set_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN, refresh.as_bytes())?;
        kc.delete_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN)?;

        if let Some(user_id) = resp.user_id {
            set_account_info(
                state,
                &AccountInfo {
                    user_id,
                    email: email.to_string(),
                    auth_provider: "otp".to_string(),
                },
            )?;
        }
    }

    Ok(OtpVerifyResult {
        needs_setup: resp.needs_setup,
    })
}

// ---------------------------------------------------------------------
// Public API: setup new account
// ---------------------------------------------------------------------

/// Full new-account setup flow: derives the local vault key, generates
/// a recovery phrase, registers the device with the auth server,
/// stores the issued tokens, and returns the recovery phrase.
///
/// Order of operations:
///
/// 1. Read setup token from keychain (`/auth/otp/verify` stored it).
/// 2. Derive local master key + verifier and persist them via
///    `setup_local_vault_key`. The runtime transitions to `Unlocked`.
/// 3. Generate the recovery phrase and persist it under
///    `SERVICE_VAULT/recovery-phrase`.
/// 4. Get-or-create the device signing keypair.
/// 5. POST `/auth/devices` with the public key and metadata.
/// 6. Persist access/refresh tokens, clear the setup token.
/// 7. Persist account info and upsert the current device row.
pub async fn setup_new_account(
    state: &AppState,
    input: SetupAccountInput,
) -> AppResult<SetupAccountResult> {
    let base = crate::sync::http::resolve_base_url()?;
    setup_new_account_with_base(&base, state, input).await
}

pub async fn setup_new_account_with_base(
    base_url: &str,
    state: &AppState,
    input: SetupAccountInput,
) -> AppResult<SetupAccountResult> {
    let kc = state.auth.keychain();
    let setup_token_bytes = kc
        .get_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN)?
        .ok_or_else(|| AppError::Auth("missing setup token; verify OTP first".into()))?;
    let setup_token = String::from_utf8(setup_token_bytes)
        .map_err(|err| AppError::Auth(format!("setup token is not valid utf-8: {err}")))?;
    let setup_jti = extract_jwt_jti(&setup_token)?;

    setup_local_vault_key(state, input.password.clone(), input.remember_device).await?;

    let recovery_phrase = generate_recovery_phrase();
    kc.set_item(
        SERVICE_VAULT,
        KEYCHAIN_RECOVERY_PHRASE,
        recovery_phrase.as_bytes(),
    )?;

    let kp = device::get_or_create_device_signing_key(state)?;
    let signing_public_key_b64 = encode_public_key_b64(&kp.public_key);

    // Server-side challenge: payload = "<challengeNonce>:<setupTokenJti>",
    // signed with the device Ed25519 secret key. The auth_public_key we
    // upload is the same key used to verify this signature.
    let challenge_nonce = generate_challenge_nonce();
    let challenge_payload = format!("{challenge_nonce}:{setup_jti}");
    let challenge_signature = sign_device_challenge(&kp.secret_key, &challenge_payload)?;

    let body = RegisterDeviceBody {
        name: &input.device_name,
        platform: &input.platform,
        os_version: input.os_version.as_deref(),
        app_version: &input.app_version,
        auth_public_key: &signing_public_key_b64,
        challenge_signature: &challenge_signature,
        challenge_nonce: &challenge_nonce,
    };
    let resp: RegisterDeviceResponse =
        auth_client::register_device_with_base(base_url, &body, &setup_token).await?;

    if !resp.success {
        return Err(AppError::Auth(format!(
            "device registration failed: {}",
            resp.error.as_deref().unwrap_or("unknown error"),
        )));
    }
    let device_id = resp.device_id.ok_or_else(|| {
        AppError::Auth("server did not return a deviceId".into())
    })?;
    let access_token = resp.access_token.ok_or_else(|| {
        AppError::Auth("server did not return an access token".into())
    })?;
    let refresh_token = resp.refresh_token.ok_or_else(|| {
        AppError::Auth("server did not return a refresh token".into())
    })?;

    kc.set_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN, access_token.as_bytes())?;
    kc.set_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN, refresh_token.as_bytes())?;
    kc.delete_item(SERVICE_VAULT, KEYCHAIN_SETUP_TOKEN)?;

    // First-device setup: hand the server the kdf salt + key verifier so
    // future OTP verifies for this account no longer report `needsSetup`.
    // The values are the same base64 strings persisted by
    // `setup_local_vault_key`; the server only stores them.
    let (kdf_salt, key_verifier) = read_vault_setup_material(state)?;
    let setup_body = FirstDeviceSetupBody {
        kdf_salt: &kdf_salt,
        key_verifier: &key_verifier,
    };
    let setup_resp: FirstDeviceSetupResponse =
        auth_client::first_device_setup_with_base(base_url, &setup_body, &access_token).await?;
    if !setup_resp.success {
        return Err(AppError::Auth("server rejected first-device setup".into()));
    }

    // The server doesn't echo the user id from `/auth/devices`; resolve
    // it from the access token's `sub` claim so account info stays
    // populated for downstream sync/IPC consumers.
    let user_id = extract_jwt_sub(&access_token).unwrap_or_default();

    set_account_info(
        state,
        &AccountInfo {
            user_id,
            email: input.email.clone(),
            auth_provider: "otp".to_string(),
        },
    )?;

    device::upsert_current_device(
        state,
        CurrentDeviceRecord {
            id: device_id.clone(),
            name: input.device_name.clone(),
            platform: input.platform.clone(),
            os_version: input.os_version.clone(),
            app_version: input.app_version.clone(),
            linked_at: now_secs(),
            signing_public_key: signing_public_key_b64.clone(),
        },
    )?;

    update_session_metadata(state, Some(device_id.clone()), Some(input.email.clone()))?;

    Ok(SetupAccountResult {
        device_id,
        recovery_phrase,
    })
}

// ---------------------------------------------------------------------
// Public API: refresh and recovery phrase
// ---------------------------------------------------------------------

/// Rotates the access/refresh token pair using the currently-stored
/// refresh token. Replaces both keychain items on success. Returns
/// `AppError::Auth` if no refresh token is present.
pub async fn refresh_session(state: &AppState) -> AppResult<()> {
    let base = crate::sync::http::resolve_base_url()?;
    refresh_session_with_base(&base, state).await
}

pub async fn refresh_session_with_base(base_url: &str, state: &AppState) -> AppResult<()> {
    let kc = state.auth.keychain();
    let refresh_bytes = kc
        .get_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN)?
        .ok_or_else(|| AppError::Auth("no refresh token in keychain".into()))?;
    let refresh = String::from_utf8(refresh_bytes)
        .map_err(|err| AppError::Auth(format!("refresh token is not valid utf-8: {err}")))?;

    let body = RefreshBody {
        refresh_token: &refresh,
    };
    let resp: RefreshResponse = auth_client::refresh_token_with_base(base_url, &body).await?;

    kc.set_item(SERVICE_VAULT, KEYCHAIN_ACCESS_TOKEN, resp.access_token.as_bytes())?;
    kc.set_item(SERVICE_VAULT, KEYCHAIN_REFRESH_TOKEN, resp.refresh_token.as_bytes())?;
    Ok(())
}

/// Returns the recovery phrase from the keychain. Requires the auth
/// runtime to be `Unlocked`; otherwise surfaces `AppError::VaultLocked`.
pub fn get_recovery_phrase(state: &AppState) -> AppResult<String> {
    if state.auth.status().state != AuthStateKind::Unlocked {
        return Err(AppError::VaultLocked);
    }
    let bytes = state
        .auth
        .keychain()
        .get_item(SERVICE_VAULT, KEYCHAIN_RECOVERY_PHRASE)?
        .ok_or_else(|| AppError::NotFound("recovery phrase".into()))?;
    String::from_utf8(bytes)
        .map_err(|err| AppError::Crypto(format!("recovery phrase is not valid utf-8: {err}")))
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/// Generates a recovery phrase: 32 random bytes encoded as URL-safe
/// base64 (no padding). Phase D treats the encoded string as the
/// canonical phrase. A future polishing pass can convert this to a
/// human-friendly mnemonic without changing the storage contract.
fn generate_recovery_phrase() -> String {
    let mut bytes = [0u8; RECOVERY_PHRASE_BYTES];
    OsRng.fill_bytes(&mut bytes);
    B64URL.encode(bytes)
}

fn encode_public_key_b64(public_key: &[u8]) -> String {
    B64STD.encode(public_key)
}

/// 32-byte random nonce used in the `/auth/devices` challenge payload.
/// The encoding (URL-safe base64, no padding) mirrors what the server
/// expects in `challengeNonce`.
fn generate_challenge_nonce() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    B64URL.encode(bytes)
}

/// Decodes a JWT WITHOUT verifying its signature and returns a
/// claim by name as a `String`. The setup-token middleware on the
/// server validates the token before us, so the client only needs the
/// claim values (jti, sub) to compose follow-up requests.
fn extract_jwt_claim(token: &str, claim: &str) -> Option<String> {
    let payload_segment = token.split('.').nth(1)?;
    let bytes = B64URL.decode(payload_segment).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value.get(claim)?.as_str().map(|s| s.to_string())
}

fn extract_jwt_jti(token: &str) -> AppResult<String> {
    extract_jwt_claim(token, "jti")
        .ok_or_else(|| AppError::Auth("setup token missing jti claim".into()))
}

fn extract_jwt_sub(token: &str) -> Option<String> {
    extract_jwt_claim(token, "sub")
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// Suppress unused-warning for re-exports needed by command modules in
// future phases (Phase E adds Tauri command wrappers; these constants
// are part of the contract those wrappers respect).
#[allow(dead_code)]
fn _retain_constants() {
    let _ = (
        SERVICE_DEVICE,
        KEYCHAIN_DEVICE_SIGNING_KEY,
        std::any::type_name::<DeviceSigningKeyPair>(),
    );
}
