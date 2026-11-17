//! The open vault's sync (`ipc/sync-core-handlers.ts`): status, Sync Now, pause, history, the
//! queue, the quarantine and note lists, and the synced settings. Each command is one call of
//! `memry_desktop::sync::ops`; device, binding, wipe, key-repair and storage commands are Steps
//! 19 and 18.

use std::sync::Arc;

use memry_desktop::error::CoreError;
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::Session;
use memry_desktop::sync::ops::{
    self, GetHistoryInput, GetHistoryResult, GetQueueSizeResult, LargeNotesResult, NoteSyncState,
    PauseSyncResult, QuarantinedItemInfo, ResumeSyncResult, SettingsWriteError, SyncControlSurface,
    UnsentNotesResult, UpdateSyncedSettingResult,
};
use memry_desktop::sync::result::TriggerSyncResult;
use memry_desktop::sync::status::SyncStatus;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};
use crate::shell::services;

fn storage<E: CoreError>(command: &'static str) -> impl Fn(E) -> CommandError {
    move |error| {
        let mapped = CommandError::from_core(&error);
        log_failure(command, &mapped);
        mapped
    }
}

fn session<R: Runtime>(app: &AppHandle<R>) -> Session {
    app.state::<Session>().inner().clone()
}

/// `sync:get-status`.
#[tauri::command]
#[specta::specta]
pub fn sync_get_status<R: Runtime>(app: AppHandle<R>) -> SyncStatus {
    ops::status(&session(&app))
}

/// `sync:trigger-sync` (Sync Now).
#[tauri::command]
#[specta::specta]
pub async fn sync_trigger<R: Runtime>(app: AppHandle<R>) -> TriggerSyncResult {
    ops::trigger(&session(&app)).await
}

/// `sync:pause`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncControlInput {
    pub surface: SyncControlSurface,
}

/// `sync:pause`.
#[tauri::command]
#[specta::specta]
pub async fn sync_pause<R: Runtime>(
    app: AppHandle<R>,
    input: SyncControlInput,
) -> Result<PauseSyncResult, CommandError> {
    let telemetry = services::telemetry(&app);
    ops::pause(&session(&app), input.surface, telemetry.as_deref())
        .await
        .map_err(storage("sync_pause"))
}

/// `sync:resume`.
#[tauri::command]
#[specta::specta]
pub async fn sync_resume<R: Runtime>(
    app: AppHandle<R>,
    input: SyncControlInput,
) -> Result<ResumeSyncResult, CommandError> {
    let telemetry = services::telemetry(&app);
    ops::resume(&session(&app), input.surface, telemetry.as_deref())
        .await
        .map_err(storage("sync_resume"))
}

/// `sync:get-history`.
#[tauri::command]
#[specta::specta]
pub async fn sync_get_history<R: Runtime>(
    app: AppHandle<R>,
    input: GetHistoryInput,
) -> Result<GetHistoryResult, CommandError> {
    blocking("sync_get_history", move || {
        ops::history(session(&app).current().as_ref(), input)
            .map_err(|error| CommandError::from_core(&error))?
            .map_err(|_| {
                CommandError::new(
                    ErrorKind::Invalid,
                    "invalid_input",
                    "limit must be between 1 and 1000",
                )
            })
    })
    .await
}

/// `sync:get-queue-size`.
#[tauri::command]
#[specta::specta]
pub async fn sync_get_queue_size<R: Runtime>(
    app: AppHandle<R>,
) -> Result<GetQueueSizeResult, CommandError> {
    blocking("sync_get_queue_size", move || {
        ops::queue_size(session(&app).current().as_ref())
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `sync:get-quarantined-items`.
#[tauri::command]
#[specta::specta]
pub async fn sync_get_quarantined_items<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<QuarantinedItemInfo>, CommandError> {
    blocking("sync_get_quarantined_items", move || {
        let now = i64::try_from(memry_desktop::telemetry::time::now_ms()).unwrap_or(i64::MAX);
        ops::quarantined(session(&app).current().as_ref(), now)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `sync:get-unsent-notes`.
#[tauri::command]
#[specta::specta]
pub async fn sync_get_unsent_notes<R: Runtime>(
    app: AppHandle<R>,
) -> Result<UnsentNotesResult, CommandError> {
    blocking("sync_get_unsent_notes", move || {
        let session = session(&app);
        ops::unsent_notes(session.current().as_ref(), ops::sync_eligible(&session))
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `sync:get-large-notes`.
#[tauri::command]
#[specta::specta]
pub async fn sync_get_large_notes<R: Runtime>(
    app: AppHandle<R>,
) -> Result<LargeNotesResult, CommandError> {
    blocking("sync_get_large_notes", move || {
        ops::large_notes(session(&app).current().as_ref())
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `sync:get-note-sync-state` input.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GetNoteSyncStateInput {
    pub note_id: String,
}

/// `sync:get-note-sync-state`: `null` for an unknown note.
#[tauri::command]
#[specta::specta]
pub async fn sync_get_note_sync_state<R: Runtime>(
    app: AppHandle<R>,
    input: GetNoteSyncStateInput,
) -> Result<Option<NoteSyncState>, CommandError> {
    if input.note_id.is_empty() {
        return Err(CommandError::new(
            ErrorKind::Invalid,
            "invalid_input",
            "noteId is required",
        ));
    }
    blocking("sync_get_note_sync_state", move || {
        let session = session(&app);
        let eligible = ops::sync_eligible(&session);
        ops::note_sync_state(session.current().as_ref(), input.note_id, eligible)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `sync:get-synced-settings`: `null` with no vault open.
#[tauri::command]
#[specta::specta]
pub async fn sync_get_synced_settings<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<Map<String, Value>>, CommandError> {
    blocking("sync_get_synced_settings", move || {
        ops::synced_settings(session(&app).current().as_ref())
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `sync:update-synced-setting` input.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSyncedSettingInput {
    pub field_path: String,
    pub value: Value,
}

/// `sync:update-synced-setting`.
#[tauri::command]
#[specta::specta]
pub async fn sync_update_synced_setting<R: Runtime>(
    app: AppHandle<R>,
    input: UpdateSyncedSettingInput,
) -> Result<UpdateSyncedSettingResult, CommandError> {
    if input.field_path.is_empty() {
        return Err(CommandError::new(
            ErrorKind::Invalid,
            "invalid_input",
            "fieldPath is required",
        ));
    }
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    blocking("sync_update_synced_setting", move || {
        ops::update_synced_setting(&session(&app), store, input.field_path, input.value).map_err(
            |error| match error {
                SettingsWriteError::Storage(error) => CommandError::from_core(&error),
                SettingsWriteError::Auth(error) => CommandError::from_core(&error),
            },
        )
    })
    .await
}
