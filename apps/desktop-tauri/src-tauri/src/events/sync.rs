//! The sync events of `ipc-events.ts:8-32` the renderer listens to. Ids and small hints only:
//! a listener reads anything bigger through its command.

use memry_desktop::sync::error_category::SyncErrorCategory;
use memry_desktop::sync::events::{ItemOperation, SyncEvent};
use memry_desktop::sync::status::SyncStatus;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Wry};

use super::broadcast;

/// Sends the typed event of one supervisor event.
pub fn broadcast_sync_event(app: &AppHandle<Wry>, event: &SyncEvent) {
    match event {
        SyncEvent::Pulled {
            item_type,
            item_id,
            operation,
        } => broadcast(
            app,
            SyncItemSyncedEvent {
                item_id: item_id.clone(),
                item_type: item_type.clone(),
                operation: SyncDirection::Pull,
                item_operation: Some(match operation {
                    ItemOperation::Create => SyncItemOperation::Create,
                    ItemOperation::Update => SyncItemOperation::Update,
                    ItemOperation::Delete => SyncItemOperation::Delete,
                }),
            },
        ),
        SyncEvent::QueueCleared {
            item_count,
            duration_ms,
        } => broadcast(
            app,
            SyncQueueClearedEvent {
                item_count: *item_count,
                duration: *duration_ms,
            },
        ),
        SyncEvent::ClockSkew {
            local_s,
            server_s,
            skew_s,
        } => broadcast(
            app,
            SyncClockSkewWarningEvent {
                local_time: *local_s,
                server_time: *server_s,
                skew_seconds: *skew_s,
            },
        ),
        SyncEvent::SecurityWarning(warning) => broadcast(
            app,
            SyncSecurityWarningEvent {
                item_id: warning.item_id.clone(),
                item_type: warning.item_type.clone(),
                signer_device_id: warning.signer_device_id.clone(),
                reason: SecurityWarningReason::SignatureVerificationFailed,
                attempt_count: warning.attempt_count,
                permanent: warning.permanent,
            },
        ),
        SyncEvent::Corrupt {
            item_type,
            item_id,
            reason,
        } => broadcast(
            app,
            SyncItemCorruptEvent {
                item_id: item_id.clone(),
                item_type: item_type.clone(),
                error: reason.clone(),
            },
        ),
        SyncEvent::Recovered { item_type, item_id } => broadcast(
            app,
            SyncItemRecoveredEvent {
                item_id: item_id.clone(),
                item_type: item_type.clone(),
            },
        ),
        SyncEvent::AttachmentMaterialized { note_id } => broadcast(
            app,
            SyncAttachmentMaterializedEvent {
                note_id: note_id.clone(),
            },
        ),
        SyncEvent::AttachmentFailed {
            note_id,
            disk_path,
            error,
            category,
        } => broadcast(
            app,
            SyncAttachmentUploadFailedEvent {
                note_id: note_id.clone(),
                disk_path: disk_path.clone(),
                error: error.clone(),
                error_category: *category,
            },
        ),
    }
}

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

/// `sync:attachment-materialized`: a download of the note's attachment landed.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncAttachmentMaterializedEvent {
    pub note_id: String,
}

/// `sync:attachment-upload-failed`: an attachment of the note failed to download, or will not
/// upload. `errorCategory` is sent only for a file over the plan's limit (`file_too_large`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncAttachmentUploadFailedEvent {
    pub note_id: String,
    pub disk_path: String,
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = SyncErrorCategory)]
    pub error_category: Option<SyncErrorCategory>,
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
