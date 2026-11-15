//! "Join the iPhone beta" (`apps/desktop/src/main/ios-beta/join-ios-beta.ts`): the sync server
//! adds the address to the TestFlight group (Apple sends the invite) and to the iOS beta list.
//! The install id rides along only while telemetry is on, so a user who opted out is never
//! linked to their email.

use memry_core::seams::transport::Transport;
use serde::{Deserialize, Serialize};

use super::report::{is_schema_email, refusal_message, send_json};
use super::service::Service;

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

/// Posts the join request to `url` (the server's `/ios-beta/join`), with the account's token when
/// the user is signed in (`join-ios-beta.ts:32-33`). `telemetry` is `None` until its launch stage
/// has run, and the join then fails.
pub async fn join(
    transport: &dyn Transport,
    url: &str,
    input: IosBetaJoinInput,
    telemetry: Option<&Service>,
    bearer: Option<&str>,
) -> IosBetaJoinResult {
    let email = input.email.trim();
    // `IosBetaJoinInputSchema`: `z.string().trim().email().max(254)`.
    if !is_schema_email(email, 254) {
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
    let error = match send_json(transport, url, body, bearer).await {
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
