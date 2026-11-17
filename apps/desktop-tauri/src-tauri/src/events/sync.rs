//! The sync events of `ipc-events.ts:8-32` the renderer listens to. Ids and small hints only:
//! a listener reads anything bigger through its command.

use memry_desktop::sync::status::SyncStatus;
use serde::{Deserialize, Serialize};

/// `sync:status-changed`, the shape of `SyncStatusChangedEvent` (and of `sync_get_status`).
/// At most one per 100 ms, the latest winning (the supervisor's throttle).
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
pub struct SyncStatusChangedEvent(pub SyncStatus);

/// `ItemSyncedEvent.operation`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum SyncDirection {
    Push,
    Pull,
}

/// `ItemSyncedEvent.itemOperation`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum SyncItemOperation {
    Create,
    Update,
    Delete,
}

/// `sync:item-synced`: one item went up or came down.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncItemSyncedEvent {
    pub item_id: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub operation: SyncDirection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_operation: Option<SyncItemOperation>,
}

/// `sync:queue-cleared`: a push emptied the queue.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncQueueClearedEvent {
    pub item_count: u32,
    /// Milliseconds the push took.
    pub duration: i64,
}

/// `InitialSyncPhase`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum InitialSyncPhase {
    Manifest,
    Packs,
    Notes,
    Tasks,
    Attachments,
    Complete,
}

/// `sync:initial-sync-progress`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncInitialSyncProgressEvent {
    pub phase: InitialSyncPhase,
    pub total_items: u32,
    pub processed_items: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_item_type: Option<String>,
}

/// `sync:clock-skew-warning`: the local clock is off from the server's; sync paused.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncClockSkewWarningEvent {
    pub local_time: i64,
    pub server_time: i64,
    pub skew_seconds: i64,
}

/// `sync:item-corrupt`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncItemCorruptEvent {
    pub item_id: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub error: String,
}

/// `sync:item-recovered`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncItemRecoveredEvent {
    pub item_id: String,
    #[serde(rename = "type")]
    pub item_type: String,
}

/// `SecurityWarningEvent.reason`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SecurityWarningReason {
    SignatureVerificationFailed,
}

/// `sync:security-warning`: a pulled item failed its signature check and was quarantined.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncSecurityWarningEvent {
    pub item_id: String,
    pub item_type: String,
    pub signer_device_id: String,
    pub reason: SecurityWarningReason,
    pub attempt_count: i64,
    pub permanent: bool,
}

/// `sync:certificate-pin-failed`: the sync host's certificate matches none of its pins.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncCertificatePinFailedEvent {
    pub hostname: String,
    pub actual_hash: String,
    pub expected_hashes: Vec<String>,
}
