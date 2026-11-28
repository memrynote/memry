//! Vault events: status, errors, settings, the registry list, the index, locks, notices and
//! the activity log.

use memry_desktop::notes::index::IndexProgress;
use memry_desktop::session::response::VaultStatus;
use memry_desktop::vault::config::VaultConfig;
use serde::Serialize;

use crate::commands::vault_locks::VaultLockStateView;

/// The open vault changed (`vault:status-changed`). The renderer reads the status once after
/// it subscribes, because events before that are not replayed.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultStatusChangedEvent(pub VaultStatus);

/// A vault operation failed (`vault:error`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct VaultErrorEvent {
    pub message: String,
}

/// Entries of the vault activity log were added or removed, or the vault closed
/// (`vault-activity:changed`). No payload; the renderer refetches. Throttled by the log.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultActivityChangedEvent;

/// The open vault's notices changed, or a vault opened or closed. No payload; the renderer
/// reads `vault_notices_list`.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultNoticesChangedEvent;

/// The open vault's settings changed (`vault:config-changed`), with the settings after it: an
/// in-app write, from any window, as Electron's `updateConfig` broadcasts it.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultConfigChangedEvent(pub VaultConfig);

/// A lock was set or lifted on this device, or a vault opened (`vault-locks:changed`): every
/// locked note id and folder path now.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct VaultLocksChangedEvent {
    pub notes: Vec<String>,
    pub folders: Vec<String>,
}

impl From<VaultLockStateView> for VaultLocksChangedEvent {
    fn from(state: VaultLockStateView) -> Self {
        Self {
            notes: state.notes,
            folders: state.folders,
        }
    }
}

/// A locked note's file changed or was removed outside the app, and its locked text was written
/// back; the outside text is a version of the note (`vault-locks:external-edit-restored`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct VaultLocksExternalEditRestoredEvent {
    pub note_id: String,
    pub path: String,
    pub title: String,
}

/// The registry list or a vault's icon changed (`vault:list-changed`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultListChangedEvent;

/// A reindex, or an open's first index pass, measured `index_built` of `index_total` notes
/// (`vault:index-progress`). At most one per 250 ms and never backwards within a pass. A pass
/// that read every file ends with `index_built == index_total` (`0` of `0` for an open with
/// nothing to measure); one a close or a failed write stops ends without it.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct VaultIndexProgressEvent {
    pub index_built: u32,
    pub index_total: u32,
}

impl From<IndexProgress> for VaultIndexProgressEvent {
    fn from(step: IndexProgress) -> Self {
        let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
        Self {
            index_built: count(step.built),
            index_total: count(step.total),
        }
    }
}

/// `index.db` was rebuilt empty (`vault:index-recovered`). `reason` is `missing` for a first
/// open (nothing was repaired) and `corrupt` otherwise; `detail` is the core's text.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct VaultIndexRecoveredEvent {
    pub reason: String,
    pub detail: String,
}
