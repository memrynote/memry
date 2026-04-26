//! Route wrappers for the M4 auth/devices/linking HTTP surface.
//!
//! Each wrapper is a one-liner over the bare HTTP primitives in
//! `sync::http`; the wrappers exist so request and response types can
//! evolve in one place and so call sites cannot drift from the
//! canonical paths declared in the M4 plan.
//!
//! Both env-resolved and `_with_base` variants are exposed:
//! production code calls the env-resolved form, tests and any future
//! retry orchestration call the `_with_base` form. Request and
//! response payloads are intentionally generic over `Serialize` /
//! `DeserializeOwned`; concrete types land alongside the auth flows
//! in M4 Phase D and M5+.

use serde::{de::DeserializeOwned, Serialize};

use crate::error::AppResult;
use crate::sync::http;

// ----- /auth/otp/* ----------------------------------------------------

pub async fn request_otp<TReq, TResp>(body: &TReq) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json("/auth/otp/request", body, None).await
}

pub async fn request_otp_with_base<TReq, TResp>(base_url: &str, body: &TReq) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json_with_base(base_url, "/auth/otp/request", body, None).await
}

pub async fn verify_otp<TReq, TResp>(body: &TReq, setup_token: Option<&str>) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json("/auth/otp/verify", body, setup_token).await
}

pub async fn verify_otp_with_base<TReq, TResp>(
    base_url: &str,
    body: &TReq,
    setup_token: Option<&str>,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json_with_base(base_url, "/auth/otp/verify", body, setup_token).await
}

pub async fn resend_otp<TReq, TResp>(body: &TReq) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json("/auth/otp/resend", body, None).await
}

pub async fn resend_otp_with_base<TReq, TResp>(base_url: &str, body: &TReq) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json_with_base(base_url, "/auth/otp/resend", body, None).await
}

// ----- /auth/oauth/google -------------------------------------------

pub async fn init_google_oauth<TResp>(redirect_uri: &str) -> AppResult<TResp>
where
    TResp: DeserializeOwned,
{
    let path = format!("/auth/oauth/google?redirect_uri={redirect_uri}");
    http::get_json(&path, None).await
}

pub async fn init_google_oauth_with_base<TResp>(
    base_url: &str,
    redirect_uri: &str,
) -> AppResult<TResp>
where
    TResp: DeserializeOwned,
{
    let path = format!("/auth/oauth/google?redirect_uri={redirect_uri}");
    http::get_json_with_base(base_url, &path, None).await
}

pub async fn google_oauth_callback<TReq, TResp>(body: &TReq) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json("/auth/oauth/google/callback", body, None).await
}

pub async fn google_oauth_callback_with_base<TReq, TResp>(
    base_url: &str,
    body: &TReq,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json_with_base(base_url, "/auth/oauth/google/callback", body, None).await
}

// ----- /auth/devices /auth/recovery-info /auth/refresh --------------

pub async fn register_device<TReq, TResp>(
    body: &TReq,
    setup_token: &str,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json("/auth/devices", body, Some(setup_token)).await
}

pub async fn register_device_with_base<TReq, TResp>(
    base_url: &str,
    body: &TReq,
    setup_token: &str,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json_with_base(base_url, "/auth/devices", body, Some(setup_token)).await
}

pub async fn get_recovery_info<TResp>(access_token: &str) -> AppResult<TResp>
where
    TResp: DeserializeOwned,
{
    http::get_json("/auth/recovery-info", Some(access_token)).await
}

pub async fn get_recovery_info_with_base<TResp>(
    base_url: &str,
    access_token: &str,
) -> AppResult<TResp>
where
    TResp: DeserializeOwned,
{
    http::get_json_with_base(base_url, "/auth/recovery-info", Some(access_token)).await
}

pub async fn refresh_token<TReq, TResp>(
    body: &TReq,
    refresh_token: &str,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json("/auth/refresh", body, Some(refresh_token)).await
}

pub async fn refresh_token_with_base<TReq, TResp>(
    base_url: &str,
    body: &TReq,
    refresh_token: &str,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json_with_base(base_url, "/auth/refresh", body, Some(refresh_token)).await
}

// ----- /devices ------------------------------------------------------

pub async fn get_devices<TResp>(access_token: &str) -> AppResult<TResp>
where
    TResp: DeserializeOwned,
{
    http::get_json("/devices", Some(access_token)).await
}

pub async fn get_devices_with_base<TResp>(
    base_url: &str,
    access_token: &str,
) -> AppResult<TResp>
where
    TResp: DeserializeOwned,
{
    http::get_json_with_base(base_url, "/devices", Some(access_token)).await
}

pub async fn remove_device<TResp>(device_id: &str, access_token: &str) -> AppResult<TResp>
where
    TResp: DeserializeOwned,
{
    let path = format!("/devices/{device_id}");
    http::delete_json(&path, Some(access_token)).await
}

pub async fn remove_device_with_base<TResp>(
    base_url: &str,
    device_id: &str,
    access_token: &str,
) -> AppResult<TResp>
where
    TResp: DeserializeOwned,
{
    let path = format!("/devices/{device_id}");
    http::delete_json_with_base(base_url, &path, Some(access_token)).await
}

pub async fn rename_device<TReq, TResp>(
    device_id: &str,
    body: &TReq,
    access_token: &str,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    let path = format!("/devices/{device_id}");
    http::patch_json(&path, body, Some(access_token)).await
}

pub async fn rename_device_with_base<TReq, TResp>(
    base_url: &str,
    device_id: &str,
    body: &TReq,
    access_token: &str,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    let path = format!("/devices/{device_id}");
    http::patch_json_with_base(base_url, &path, body, Some(access_token)).await
}

// ----- /auth/linking/* ----------------------------------------------

pub async fn initiate_linking<TReq, TResp>(
    body: &TReq,
    access_token: &str,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json("/auth/linking/initiate", body, Some(access_token)).await
}

pub async fn initiate_linking_with_base<TReq, TResp>(
    base_url: &str,
    body: &TReq,
    access_token: &str,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json_with_base(base_url, "/auth/linking/initiate", body, Some(access_token)).await
}

pub async fn scan_linking<TReq, TResp>(
    body: &TReq,
    access_token: Option<&str>,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json("/auth/linking/scan", body, access_token).await
}

pub async fn scan_linking_with_base<TReq, TResp>(
    base_url: &str,
    body: &TReq,
    access_token: Option<&str>,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json_with_base(base_url, "/auth/linking/scan", body, access_token).await
}

pub async fn get_linking_session<TResp>(
    session_id: &str,
    access_token: &str,
) -> AppResult<TResp>
where
    TResp: DeserializeOwned,
{
    let path = format!("/auth/linking/session/{session_id}");
    http::get_json(&path, Some(access_token)).await
}

pub async fn get_linking_session_with_base<TResp>(
    base_url: &str,
    session_id: &str,
    access_token: &str,
) -> AppResult<TResp>
where
    TResp: DeserializeOwned,
{
    let path = format!("/auth/linking/session/{session_id}");
    http::get_json_with_base(base_url, &path, Some(access_token)).await
}

pub async fn approve_linking<TReq, TResp>(
    body: &TReq,
    access_token: &str,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json("/auth/linking/approve", body, Some(access_token)).await
}

pub async fn approve_linking_with_base<TReq, TResp>(
    base_url: &str,
    body: &TReq,
    access_token: &str,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json_with_base(base_url, "/auth/linking/approve", body, Some(access_token)).await
}

pub async fn complete_linking<TReq, TResp>(body: &TReq) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json("/auth/linking/complete", body, None).await
}

pub async fn complete_linking_with_base<TReq, TResp>(
    base_url: &str,
    body: &TReq,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    http::post_json_with_base(base_url, "/auth/linking/complete", body, None).await
}
