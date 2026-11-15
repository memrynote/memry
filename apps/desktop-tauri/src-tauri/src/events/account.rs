//! The account's events: sign-in, session and device linking.

use serde::Serialize;

/// A six-digit code was copied while the email code screen waits for one (`sync:otp-detected`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct AuthOtpDetectedEvent {
    pub code: String,
}

/// The browser sign-in came back with its code (`sync:oauth-callback`). The renderer passes both
/// to `sync_setup_first_device`; neither is logged.
#[derive(Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct AuthOauthCallbackEvent {
    pub code: String,
    pub state: String,
}

impl std::fmt::Debug for AuthOauthCallbackEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AuthOauthCallbackEvent { <redacted> }")
    }
}

/// The browser sign-in ended without a code: declined or timed out (`sync:oauth-error`). `error`
/// is the translated sentence.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct AuthOauthErrorEvent {
    pub error: String,
}

/// The access token was renewed (`sync:token-refreshed`; the name keeps the secret scan off it).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct AuthSessionRefreshedEvent {}

/// A linked device finished registering, or failed to (`sync:linking-finalized`). The new device's
/// link finalizes in the background after the approval; `error` is the failure's message.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncLinkingFinalizedEvent {
    pub device_id: Option<String>,
    pub error: Option<String>,
}
