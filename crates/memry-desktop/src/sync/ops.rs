//! What the sync commands answer (`ipc/sync-core-handlers.ts`), over the session's open vault
//! and its supervisor. With no vault open, or no supervisor running (signed out, no account),
//! each answers as Electron answers with no engine: idle, nothing queued, empty lists.

use std::collections::BTreeMap;
use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::seams::secure_store::SecureStore;
use memry_core::sync::hardening::{body_state, history, quarantine};
use memry_core::sync::{outbox, pause};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::result::{SyncNowBlockedReason, TriggerSyncResult};
use super::status::SyncStatus;
use crate::session::{OpenVault, Session};
use crate::telemetry::Service;

/// `GET_STATUS` with no engine (`sync-core-handlers.ts:205-216`): idle. The keychain and plan
/// cases Electron reads there are the supervisor's status once it runs.
pub fn status(session: &Session) -> SyncStatus {
    session
        .sync_supervisor()
        .map_or_else(super::status::idle, |supervisor| supervisor.status())
}

/// `TRIGGER_SYNC`. Electron starts the runtime when none runs; here the account owns that
/// (`attach_sync` at sign-in and launch), so none running is `unavailable`.
pub async fn trigger(session: &Session) -> TriggerSyncResult {
    match session.sync_supervisor() {
        Some(supervisor) => supervisor.sync_now().await,
        None => TriggerSyncResult {
            success: false,
            reason: Some(SyncNowBlockedReason::Unavailable),
            error: Some("errors:sync.engineNotInitialized".to_owned()),
        },
    }
}

/// `SyncControlSchema.surface`: where the user paused or resumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SyncControlSurface {
    Popover,
    Settings,
    CommandPalette,
}

impl SyncControlSurface {
    fn as_str(self) -> &'static str {
        match self {
            Self::Popover => "popover",
            Self::Settings => "settings",
            Self::CommandPalette => "command_palette",
        }
    }
}

/// `PauseSyncResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PauseSyncResult {
    pub success: bool,
    pub was_paused: bool,
}

/// `ResumeSyncResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSyncResult {
    pub success: bool,
    pub pending_count: u32,
}

/// `pause` (`engine.ts:663-668`, `sync-state-manager.ts:139-152`): persisted before the driver
/// stops, and a change is counted as `setting_changed`.
pub async fn pause(
    session: &Session,
    surface: SyncControlSurface,
    telemetry: Option<&Service>,
) -> Result<PauseSyncResult, StorageError> {
    let Some(supervisor) = session.sync_supervisor() else {
        return Ok(PauseSyncResult {
            success: false,
            was_paused: false,
        });
    };
    let db = supervisor_db(session)?;
    let was_paused = db.read(pause::read).await?;
    supervisor.set_paused(true).await?;
    if !was_paused {
        track_pause(telemetry, true, surface);
    }
    Ok(PauseSyncResult {
        success: true,
        was_paused,
    })
}

/// `resume` (`engine.ts:670-676`): the pause ends and a pass runs; `pendingCount` is the queue.
pub async fn resume(
    session: &Session,
    surface: SyncControlSurface,
    telemetry: Option<&Service>,
) -> Result<ResumeSyncResult, StorageError> {
    let Some(supervisor) = session.sync_supervisor() else {
        return Ok(ResumeSyncResult {
            success: false,
            pending_count: 0,
        });
    };
    let db = supervisor_db(session)?;
    let was_paused = db.read(pause::read).await?;
    supervisor.set_paused(false).await?;
    if was_paused {
        track_pause(telemetry, false, surface);
    }
    let depth = db.read(outbox::depth).await?;
    Ok(ResumeSyncResult {
        success: true,
        pending_count: u32::try_from(depth).unwrap_or(u32::MAX),
    })
}

fn supervisor_db(session: &Session) -> Result<memry_core::storage::Db, StorageError> {
    session
        .current()
        .map(|open| open.vault.db_handle())
        .ok_or_else(|| StorageError::Failed {
            what: "no vault is open".to_owned(),
        })
}

fn track_pause(telemetry: Option<&Service>, paused: bool, surface: SyncControlSurface) {
    let Some(telemetry) = telemetry else { return };
    let action = if paused { "paused" } else { "resumed" };
    let mut event = Service::event("setting_changed", "sync", action);
    event.source = Some(surface.as_str().to_owned());
    event.dimensions = Some(BTreeMap::from([(
        "setting".to_owned(),
        "sync_paused".to_owned(),
    )]));
    telemetry.track_main_event(event);
}

/// `GetHistoryInput`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GetHistoryInput {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// `SyncHistoryEntry`. `type` is the stored text, so a kind a newer build wrote still reads.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncHistoryEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub item_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    /// Parsed JSON, or the stored text when it does not parse (`parseSyncHistoryDetails`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    pub created_at: i64,
}

/// `GetHistoryResult`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GetHistoryResult {
    pub entries: Vec<SyncHistoryEntry>,
    pub total: i64,
}

/// A history page outside `GetHistorySchema`'s bounds (`limit` 1..=1000).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidHistoryPage;

/// `GET_HISTORY`: newest first, 50 by default.
pub fn history(
    open: Option<&OpenVault>,
    input: GetHistoryInput,
) -> Result<Result<GetHistoryResult, InvalidHistoryPage>, StorageError> {
    let limit = input.limit.unwrap_or(50);
    if !(1..=1000).contains(&limit) {
        return Ok(Err(InvalidHistoryPage));
    }
    let Some(open) = open else {
        return Ok(Ok(GetHistoryResult {
            entries: Vec::new(),
            total: 0,
        }));
    };
    let offset = i64::from(input.offset.unwrap_or(0));
    let (rows, total) = open
        .vault
        .db_handle()
        .read_blocking(move |conn| history::entries(conn, i64::from(limit), offset))?;
    let entries = rows
        .into_iter()
        .map(|row| SyncHistoryEntry {
            details: row
                .details
                .map(|text| serde_json::from_str(&text).unwrap_or(Value::String(text))),
            id: row.id,
            kind: row.kind,
            item_count: row.item_count,
            direction: row.direction,
            duration_ms: row.duration_ms,
            created_at: row.created_at,
        })
        .collect();
    Ok(Ok(GetHistoryResult { entries, total }))
}

/// `GetQueueSizeResult`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GetQueueSizeResult {
    pub pending: u32,
    pub failed: u32,
}

/// `GET_QUEUE_SIZE`: record rows never tried and record rows waiting on a retry. Read from the
/// vault, with or without a supervisor.
pub fn queue_size(open: Option<&OpenVault>) -> Result<GetQueueSizeResult, StorageError> {
    let Some(open) = open else {
        return Ok(GetQueueSizeResult::default());
    };
    let stats = open.vault.db_handle().read_blocking(outbox::record_stats)?;
    Ok(GetQueueSizeResult {
        pending: u32::try_from(stats.pending).unwrap_or(u32::MAX),
        failed: u32::try_from(stats.failed).unwrap_or(u32::MAX),
    })
}

/// `QuarantinedItemInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QuarantinedItemInfo {
    pub item_id: String,
    pub item_type: String,
    pub signer_device_id: String,
    pub failed_at: i64,
    pub attempt_count: i64,
    pub last_error: String,
    pub permanent: bool,
}

/// `GET_QUARANTINED_ITEMS`: every live ledger entry, oldest failure first. The ledger is the
/// vault's, so it reads without a supervisor too.
pub fn quarantined(
    open: Option<&OpenVault>,
    now_ms: i64,
) -> Result<Vec<QuarantinedItemInfo>, StorageError> {
    let Some(open) = open else {
        return Ok(Vec::new());
    };
    let items = open
        .vault
        .db_handle()
        .read_blocking(move |conn| quarantine::entries(conn, now_ms))?;
    Ok(items
        .into_iter()
        .map(|item| QuarantinedItemInfo {
            item_id: item.item_id,
            item_type: item.item_type,
            signer_device_id: item.signer_device_id,
            failed_at: item.failed_at,
            attempt_count: item.attempt_count,
            last_error: item.last_error,
            permanent: item.permanent,
        })
        .collect())
}

/// Past every gate (`isSyncEligible`): a supervisor runs and its gate said start.
pub fn sync_eligible(session: &Session) -> bool {
    session
        .sync_supervisor()
        .is_some_and(|supervisor| supervisor.status().sync_eligible)
}

/// `NoteSyncStateValue`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum NoteSyncStateValue {
    NotSyncing,
    LocalOnly,
    Pending,
    Sent,
    Confirmed,
    NotRecorded,
    Rejected,
}

impl From<body_state::SyncStateValue> for NoteSyncStateValue {
    fn from(value: body_state::SyncStateValue) -> Self {
        use body_state::SyncStateValue as V;
        match value {
            V::NotSyncing => Self::NotSyncing,
            V::LocalOnly => Self::LocalOnly,
            V::Pending => Self::Pending,
            V::Sent => Self::Sent,
            V::Confirmed => Self::Confirmed,
            V::NotRecorded => Self::NotRecorded,
            V::Rejected => Self::Rejected,
        }
    }
}

/// `NoteSyncState`. Times are epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteSyncState {
    pub state: NoteSyncStateValue,
    pub waiting_since: Option<i64>,
    pub last_sent_at: Option<i64>,
    pub body_confirmed_at: Option<i64>,
    pub last_failed_at: Option<i64>,
    pub last_rejected_at: Option<i64>,
}

/// `GET_NOTE_SYNC_STATE`: `None` for an id with no live note, or with no vault open.
pub fn note_sync_state(
    open: Option<&OpenVault>,
    note_id: String,
    sync_eligible: bool,
) -> Result<Option<NoteSyncState>, StorageError> {
    let Some(open) = open else { return Ok(None) };
    let state = open
        .vault
        .db_handle()
        .read_blocking(move |conn| body_state::note_sync_state(conn, &note_id, sync_eligible))?;
    Ok(state.map(|state| NoteSyncState {
        state: state.state.into(),
        waiting_since: state.waiting_since,
        last_sent_at: state.last_sent_at,
        body_confirmed_at: state.body_confirmed_at,
        last_failed_at: state.last_failed_at,
        last_rejected_at: state.last_rejected_at,
    }))
}

/// `UnsentNoteReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UnsentNoteReason {
    Body,
    Record,
    FileNotTaken,
    Rejected,
}

impl From<body_state::UnsentReason> for UnsentNoteReason {
    fn from(reason: body_state::UnsentReason) -> Self {
        use body_state::UnsentReason as R;
        match reason {
            R::Body => Self::Body,
            R::Record => Self::Record,
            R::FileNotTaken => Self::FileNotTaken,
            R::Rejected => Self::Rejected,
        }
    }
}

/// `UnsentNoteEntry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UnsentNoteEntry {
    pub id: String,
    pub title: String,
    pub path: String,
    pub state: NoteSyncStateValue,
    pub waiting_since: Option<i64>,
    pub reasons: Vec<UnsentNoteReason>,
}

/// `UnsentNotesResult`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UnsentNotesResult {
    pub total: u32,
    pub notes: Vec<UnsentNoteEntry>,
}

/// `GET_UNSENT_NOTES`.
pub fn unsent_notes(
    open: Option<&OpenVault>,
    sync_eligible: bool,
) -> Result<UnsentNotesResult, StorageError> {
    let Some(open) = open else {
        return Ok(UnsentNotesResult::default());
    };
    let unsent = open.vault.db_handle().read_blocking(move |conn| {
        body_state::unsent_notes(conn, sync_eligible, body_state::MAX_UNSENT_NOTES)
    })?;
    Ok(UnsentNotesResult {
        total: u32::try_from(unsent.total).unwrap_or(u32::MAX),
        notes: unsent
            .notes
            .into_iter()
            .map(|note| UnsentNoteEntry {
                id: note.id,
                title: note.title,
                path: note.path,
                state: note.state.into(),
                waiting_since: note.waiting_since,
                reasons: note.reasons.into_iter().map(Into::into).collect(),
            })
            .collect(),
    })
}

/// `LargeNoteEntry.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum LargeNoteStatus {
    Approaching,
    Over,
}

/// `LargeNoteEntry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LargeNoteEntry {
    pub id: String,
    pub title: String,
    pub path: String,
    pub size_bytes: u64,
    pub status: LargeNoteStatus,
}

/// `LargeNotesResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LargeNotesResult {
    pub max_bytes: u64,
    pub notes: Vec<LargeNoteEntry>,
}

/// `GET_LARGE_NOTES`: the candidates are read under the database, the files measured outside it.
pub fn large_notes(open: Option<&OpenVault>) -> Result<LargeNotesResult, StorageError> {
    let (candidates, root) = match open {
        Some(open) => (
            open.vault
                .db_handle()
                .read_blocking(body_state::large_note_candidates)?,
            Some(open.path.clone()),
        ),
        None => (Vec::new(), None),
    };
    let measured = body_state::large_notes(candidates, |path| {
        let root = root.as_ref()?;
        std::fs::metadata(root.join(path))
            .ok()
            .map(|meta| meta.len())
    });
    Ok(LargeNotesResult {
        max_bytes: measured.max_bytes,
        notes: measured
            .notes
            .into_iter()
            .map(|note| LargeNoteEntry {
                id: note.id,
                title: note.title,
                path: note.path,
                size_bytes: note.size_bytes,
                status: match note.status {
                    body_state::SizeStatus::Approaching => LargeNoteStatus::Approaching,
                    body_state::SizeStatus::Over => LargeNoteStatus::Over,
                },
            })
            .collect(),
    })
}

/// `GET_SYNCED_SETTINGS`: every synced setting as the item spells it, groups this build does not
/// model included; `None` with no vault open (Electron's `null` with no manager).
pub fn synced_settings(
    open: Option<&OpenVault>,
) -> Result<Option<Map<String, Value>>, StorageError> {
    let Some(open) = open else { return Ok(None) };
    open.vault
        .db_handle()
        .read_blocking(memry_core::domain::settings::all)
        .map(Some)
}

/// `UpdateSyncedSettingResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSyncedSettingResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A synced-settings write failed.
#[derive(Debug)]
pub enum SettingsWriteError {
    Storage(StorageError),
    Auth(memry_core::api::errors::AuthError),
}

/// `UPDATE_SYNCED_SETTING` (`settings-sync.ts` `updateField`): one dotted path written and
/// queued in one transaction, then a push is asked for.
pub fn update_synced_setting(
    session: &Session,
    store: Arc<dyn SecureStore>,
    field_path: String,
    value: Value,
) -> Result<UpdateSyncedSettingResult, SettingsWriteError> {
    let Some(open) = session.current() else {
        return Ok(UpdateSyncedSettingResult {
            success: false,
            error: Some("errors:sync.settingsNotInitialized".to_owned()),
        });
    };
    let settings = open
        .vault
        .settings(store)
        .map_err(SettingsWriteError::Auth)?;
    settings
        .set(field_path, value.to_string())
        .map_err(SettingsWriteError::Storage)?;
    if let Some(supervisor) = session.sync_supervisor() {
        supervisor.request_push();
    }
    Ok(UpdateSyncedSettingResult {
        success: true,
        error: None,
    })
}
