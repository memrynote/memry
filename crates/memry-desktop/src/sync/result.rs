//! `TriggerSyncResult` and `SyncNowBlockedReason` (`ipc-sync-ops.ts`): what Sync Now answers.

use memry_core::api::errors::SyncError;
use serde::Serialize;

/// Why Sync Now sent and received nothing. `busy` is in the contract and never produced here:
/// the engine queues a pass behind the running one instead of refusing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SyncNowBlockedReason {
    Offline,
    SignedOut,
    Busy,
    Paused,
    Failed,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TriggerSyncResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<SyncNowBlockedReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TriggerSyncResult {
    pub fn ok() -> Self {
        Self {
            success: true,
            reason: None,
            error: None,
        }
    }

    pub fn blocked(reason: SyncNowBlockedReason, error: Option<SyncError>) -> Self {
        Self {
            success: false,
            reason: Some(reason),
            error: error.map(|error| error.to_string()),
        }
    }
}
