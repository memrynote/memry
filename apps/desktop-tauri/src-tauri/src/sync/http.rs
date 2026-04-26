//! Bare JSON HTTP client for M4 auth/devices/linking flows.
//!
//! Two layers:
//!
//! - Public `post_json`, `get_json`, `delete_json`, `patch_json`: env
//!   var driven. They call `resolve_base_url` per invocation, so
//!   updating `SYNC_SERVER_URL` between calls is observable
//!   immediately. Production code uses these.
//! - Public `*_with_base` variants: take an explicit base URL. Tests
//!   use them to bypass env var coordination; M6 may also use them
//!   when it composes its own retry orchestration.
//!
//! Error mapping:
//!
//! - HTTP 429 -> `AppError::RateLimited(retry_after_secs)`. The
//!   `Retry-After` header is parsed when present; missing headers
//!   yield `RateLimited(None)`.
//! - Any other non-2xx -> `AppError::Network`. The error message
//!   includes the status code but never the response body bytes; the
//!   body is drained but discarded.
//! - Transport errors -> `AppError::Network` via the existing
//!   `From<reqwest::Error>`.

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{de::DeserializeOwned, Serialize};

use crate::error::{AppError, AppResult};

const DEFAULT_DEBUG_BASE_URL: &str = "http://localhost:8787";

/// POST `<resolve_base_url()><path>` with a JSON body. Adds
/// `Authorization: Bearer <token>` when supplied.
pub async fn post_json<TReq, TResp>(
    path: &str,
    body: &TReq,
    token: Option<&str>,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    let base = resolve_base_url()?;
    post_json_with_base(&base, path, body, token).await
}

/// GET `<resolve_base_url()><path>`.
pub async fn get_json<TResp>(path: &str, token: Option<&str>) -> AppResult<TResp>
where
    TResp: DeserializeOwned,
{
    let base = resolve_base_url()?;
    get_json_with_base(&base, path, token).await
}

/// DELETE `<resolve_base_url()><path>`.
pub async fn delete_json<TResp>(path: &str, token: Option<&str>) -> AppResult<TResp>
where
    TResp: DeserializeOwned,
{
    let base = resolve_base_url()?;
    delete_json_with_base(&base, path, token).await
}

/// PATCH `<resolve_base_url()><path>` with a JSON body.
pub async fn patch_json<TReq, TResp>(
    path: &str,
    body: &TReq,
    token: Option<&str>,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    let base = resolve_base_url()?;
    patch_json_with_base(&base, path, body, token).await
}

/// POST against an explicit base URL. Production callers use the
/// env-resolving `post_json`; tests and orchestration code pass a
/// pre-resolved base.
pub async fn post_json_with_base<TReq, TResp>(
    base_url: &str,
    path: &str,
    body: &TReq,
    token: Option<&str>,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    let url = build_url(base_url, path);
    let mut req = reqwest::Client::new()
        .post(&url)
        .header(CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        req = req.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    let resp = req.json(body).send().await?;
    handle_response(resp).await
}

pub async fn get_json_with_base<TResp>(
    base_url: &str,
    path: &str,
    token: Option<&str>,
) -> AppResult<TResp>
where
    TResp: DeserializeOwned,
{
    let url = build_url(base_url, path);
    let mut req = reqwest::Client::new().get(&url);
    if let Some(token) = token {
        req = req.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    let resp = req.send().await?;
    handle_response(resp).await
}

pub async fn delete_json_with_base<TResp>(
    base_url: &str,
    path: &str,
    token: Option<&str>,
) -> AppResult<TResp>
where
    TResp: DeserializeOwned,
{
    let url = build_url(base_url, path);
    let mut req = reqwest::Client::new().delete(&url);
    if let Some(token) = token {
        req = req.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    let resp = req.send().await?;
    handle_response(resp).await
}

pub async fn patch_json_with_base<TReq, TResp>(
    base_url: &str,
    path: &str,
    body: &TReq,
    token: Option<&str>,
) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned,
{
    let url = build_url(base_url, path);
    let mut req = reqwest::Client::new()
        .patch(&url)
        .header(CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        req = req.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    let resp = req.json(body).send().await?;
    handle_response(resp).await
}

/// Resolves the sync server base URL fresh on every call. Production
/// builds require `SYNC_SERVER_URL`; debug builds default to
/// `http://localhost:8787` when the env var is unset or empty.
pub fn resolve_base_url() -> AppResult<String> {
    if let Ok(value) = std::env::var("SYNC_SERVER_URL") {
        if !value.is_empty() {
            return Ok(value);
        }
    }
    if cfg!(debug_assertions) {
        Ok(DEFAULT_DEBUG_BASE_URL.to_string())
    } else {
        Err(AppError::Network(
            "SYNC_SERVER_URL is not set; production builds require explicit configuration"
                .to_string(),
        ))
    }
}

fn build_url(base: &str, path: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if path.starts_with('/') {
        format!("{trimmed}{path}")
    } else {
        format!("{trimmed}/{path}")
    }
}

async fn handle_response<TResp>(resp: reqwest::Response) -> AppResult<TResp>
where
    TResp: DeserializeOwned,
{
    let status = resp.status();
    if status.as_u16() == 429 {
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok());
        // Drain the body to release the connection without echoing bytes.
        let _ = resp.bytes().await;
        return Err(AppError::RateLimited(retry_after));
    }
    if !status.is_success() {
        let _ = resp.bytes().await;
        return Err(AppError::Network(format!(
            "http error: status={} body=<redacted>",
            status.as_u16()
        )));
    }
    let bytes = resp.bytes().await?;
    let parsed: TResp = serde_json::from_slice(&bytes)?;
    Ok(parsed)
}
