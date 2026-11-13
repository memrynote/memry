//! "Join the iPhone beta" (`apps/desktop/src/main/ios-beta/join-ios-beta.ts`): the sync server
//! adds the address to the TestFlight group (Apple sends the invite) and to the iOS beta list.
//! The install id rides along only while telemetry is on, so a user who opted out is never
//! linked to their email.

use memry_core::seams::transport::Transport;
use serde::{Deserialize, Serialize};

use super::report::{looks_like_email, post_json};
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

/// Posts the join request to `url` (the server's `/ios-beta/join`). Step 19 (#3536) adds the
/// account's bearer when signed in; until then it goes without one, as Electron does signed out.
pub async fn join(
    transport: &dyn Transport,
    url: &str,
    input: IosBetaJoinInput,
    telemetry: &Service,
) -> IosBetaJoinResult {
    let email = input.email.trim();
    if email.chars().count() > 254 || !looks_like_email(email) {
        return IosBetaJoinResult::failed("INVALID_IOS_BETA_JOIN");
    }
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
    match post_json(transport, url, body, None).await {
        Ok(()) => IosBetaJoinResult {
            success: true,
            error: None,
        },
        Err(error) => {
            tracing::error!(scope = "IosBeta", "iPhone beta join failed: {error}");
            IosBetaJoinResult::failed(error)
        }
    }
}
