//! "Join the iPhone beta" (`apps/desktop/src/main/ios-beta/join-ios-beta.ts`): the sync server
//! adds the address to the TestFlight group (Apple sends the invite) and to the iOS beta list.
//! The install id rides along only while telemetry is on, so a user who opted out is never
//! linked to their email.

use std::sync::LazyLock;

use memry_core::seams::transport::Transport;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::report::send_json;
use super::service::Service;

/// zod 4's `.email()` pattern, which `IosBetaJoinInputSchema` applies. The `regex` crate has no
/// lookahead, so `is_schema_email` checks zod's `(?!\.)(?!.*\.\.)` by hand.
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9_'+\-.]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$")
        .expect("email pattern")
});

/// `z.string().trim().email().max(254)` on an already trimmed address.
fn is_schema_email(email: &str) -> bool {
    !email.starts_with('.')
        && !email.contains("..")
        && email.chars().count() <= 254
        && EMAIL.is_match(email)
}

/// The message Electron's `syncFetch` (`apps/desktop/src/main/sync/http-client.ts`) throws for a
/// non-2xx answer, which `joinIosBeta` hands to the renderer.
fn refusal_message(status: u16, body: &[u8]) -> String {
    if status == 429 {
        return "Too many requests. Please try again later.".to_owned();
    }
    let Ok(body) = serde_json::from_slice::<Value>(body) else {
        return format!("Server returned {status}");
    };
    fn text(v: Option<&Value>) -> Option<&str> {
        v.and_then(Value::as_str).filter(|s| !s.is_empty())
    }
    let error = body.get("error");
    text(error)
        .or_else(|| text(error.and_then(|e| e.get("message"))))
        .or_else(|| text(body.get("message")))
        .map_or_else(|| format!("Server error ({status})"), str::to_owned)
}

/// Where in the app the user asked for the invite (`IOS_BETA_SOURCES`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum IosBetaSource {
    LaunchPrompt,
    Settings,
    HelpMenu,
}

/// What the user typed and where (`IosBetaJoinInputSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IosBetaJoinInput {
    pub email: String,
    pub source: IosBetaSource,
}

/// The body of `POST /ios-beta/join` (`IosBetaJoinRequestSchema`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IosBetaJoinRequest<'a> {
    email: &'a str,
    source: IosBetaSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    install_id: Option<&'a str>,
    app_version: &'a str,
    platform: &'a str,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IosBetaJoinResult {
    pub success: bool,
    pub error: Option<String>,
}

impl IosBetaJoinResult {
    fn failed(error: impl Into<String>) -> Self {
        Self {
            success: false,
            error: Some(error.into()),
        }
    }
}

/// Posts the join request to `url` (the server's `/ios-beta/join`). Step 19 (#3536) adds the
/// account's bearer when signed in; until then it goes without one, as Electron does signed out.
/// `telemetry` is `None` until its launch stage has run, and the join then fails.
pub async fn join(
    transport: &dyn Transport,
    url: &str,
    input: IosBetaJoinInput,
    telemetry: Option<&Service>,
) -> IosBetaJoinResult {
    let email = input.email.trim();
    if !is_schema_email(email) {
        return IosBetaJoinResult::failed("INVALID_IOS_BETA_JOIN");
    }
    let Some(telemetry) = telemetry else {
        return IosBetaJoinResult::failed("TELEMETRY_NOT_INITIALIZED");
    };
    let context = telemetry.context();
    let request = IosBetaJoinRequest {
        email,
        source: input.source,
        install_id: telemetry.enabled().then_some(context.install_id.as_str()),
        app_version: &context.app_version,
        platform: &context.platform,
    };
    let body = match serde_json::to_string(&request) {
        Ok(body) => body,
        Err(error) => return IosBetaJoinResult::failed(error.to_string()),
    };
    let error = match send_json(transport, url, body, None).await {
        Ok(response) if (200..300).contains(&response.status) => {
            return IosBetaJoinResult {
                success: true,
                error: None,
            };
        }
        Ok(response) => refusal_message(response.status, &response.body),
        Err(error) => error,
    };
    tracing::error!(scope = "IosBeta", "iPhone beta join failed: {error}");
    IosBetaJoinResult::failed(error)
}
