//! The account's events: sign-in, session and device linking.

use memry_desktop::account::VaultRecoveryReason;
use memry_desktop::account::binding::BindingState;
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

/// Why the session ended (`SessionExpiredReason`); sync reports only a refused refresh.
#[derive(Debug, Clone, Copy, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SessionExpiredReason {
    RefreshRejected,
}

/// The server refused the session for good (`auth:session-expired`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct AuthSessionExpiredEvent {
    pub reason: SessionExpiredReason,
}

/// This device was revoked (`sync:device-removed`, `DeviceRevokedEvent`). Sync stopped; every
/// secret and queued edit stays, `unsynced_count` of them in the open vault.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncDeviceRemovedEvent {
    pub unsynced_count: u32,
}

/// The master key cannot decrypt the account's data: the user must restore it with the recovery
/// phrase (`sync:vault-recovery-needed`, `VaultRecoveryNeededEvent`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct SyncVaultRecoveryNeededEvent {
    pub reason: VaultRecoveryReason,
}

/// Another device asks to be linked (`sync:linking-request`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncLinkingRequestedEvent {
    pub session_id: String,
    pub new_device_name: String,
    pub new_device_platform: String,
}

/// A link this device started was approved (`sync:linking-approved`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncLinkingApprovedEvent {
    pub session_id: String,
}

/// The account vault a merge would join.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultMergeTarget {
    pub vault_uuid: String,
    pub name: Option<String>,
}

/// `VaultBindingState` (`ipc-sync-ops.ts:114`): whether the open vault syncs with the account.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum VaultBindingState {
    Bound,
    LocalOnly,
    Foreign,
    Unknown,
    NeedsDecision {
        #[serde(rename = "accountVaultCount")]
        account_vault_count: u32,
        #[serde(rename = "mergeTarget")]
        merge_target: Option<VaultMergeTarget>,
    },
}

impl From<&BindingState> for VaultBindingState {
    fn from(state: &BindingState) -> Self {
        match state {
            BindingState::Bound => Self::Bound,
            BindingState::LocalOnly => Self::LocalOnly,
            BindingState::Foreign => Self::Foreign,
            BindingState::Unknown => Self::Unknown,
            BindingState::NeedsDecision {
                account_vault_count,
                merge_target,
            } => Self::NeedsDecision {
                account_vault_count: u32::try_from(*account_vault_count).unwrap_or(u32::MAX),
                merge_target: merge_target.as_ref().map(|t| VaultMergeTarget {
                    vault_uuid: t.vault_uuid.clone(),
                    name: t.name.clone(),
                }),
            },
        }
    }
}

/// The open vault's binding changed (`sync:vault-binding-changed`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct SyncVaultBindingChangedEvent(pub VaultBindingState);
