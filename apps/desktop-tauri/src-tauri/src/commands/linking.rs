//! Device linking (`ipc/auth-device-handlers.ts:376-512`, `sync/linking-service.ts`): this
//! desktop as the approver that shows the code, and as the new device that scans one. Each
//! command calls one `AccountService` method; the renderer wraps the answers into Electron's
//! envelopes (`services/linking-service.ts`).

use std::sync::Arc;

use memry_desktop::account::{AccountError, AccountService, LinkPoll, VaultChoice};
use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::session::Session;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};

use super::error::{CommandError, log_failure};
use crate::events::{SyncLinkingFinalizedEvent, broadcast};
use crate::shell::dialogs;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkingQrView {
    pub qr_data: String,
    pub session_id: String,
    /// Epoch seconds, as the server sent it.
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkScannedView {
    pub session_id: String,
    pub verification_code: String,
}

/// One poll of the new device's link. `waiting`: not approved yet, poll again. `rateLimited`: the
/// server refused the poll for its rate limit, poll again later. `linked`: approved; `vaults`
/// lists the account's vaults when the user picks one (`sync_finalize_vault_choice`), otherwise
/// the finalize reports through `SyncLinkingFinalizedEvent`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum LinkPollView {
    Waiting,
    RateLimited,
    Linked { vaults: Option<Vec<String>> },
}

fn account(app: &AppHandle<Wry>) -> Arc<AccountService> {
    app.state::<Arc<AccountService>>().inner().clone()
}

/// The core mapping; an expired setup gets Electron's translated sentence
/// (`errors:auth.setupSessionExpiredLinking`).
fn map_error(app: &AppHandle<Wry>, command: &str, error: &AccountError) -> CommandError {
    let mut mapped = CommandError::from_core(error);
    if matches!(error, AccountError::SetupSessionExpired) {
        let locale = app.state::<Arc<LocaleService>>().get();
        mapped.message = i18n::t(
            locale,
            "errors:auth.setupSessionExpiredLinking",
            &Args::new(),
        );
    }
    log_failure(command, &mapped);
    mapped
}

/// `sync:linking-finalized`. The error is the finalize's message, as Electron sends it.
fn report_finalized(app: &AppHandle<Wry>, outcome: Result<String, AccountError>) {
    let event = match outcome {
        Ok(device_id) => SyncLinkingFinalizedEvent {
            device_id: Some(device_id),
            error: None,
        },
        Err(error) => SyncLinkingFinalizedEvent {
            device_id: None,
            error: Some(CommandError::from_core(&error).message),
        },
    };
    broadcast(app, event);
}

/// `sync:generate-linking-qr`. Replaces a pending code.
#[tauri::command]
#[specta::specta]
pub async fn sync_generate_linking_qr(app: AppHandle<Wry>) -> Result<LinkingQrView, CommandError> {
    account(&app)
        .generate_linking_qr()
        .await
        .map(|qr| LinkingQrView {
            qr_data: qr.qr_data,
            session_id: qr.session_id,
            expires_at: qr.expires_at,
        })
        .map_err(|e| map_error(&app, "sync_generate_linking_qr", &e))
}

/// `sync:get-linking-sas`: the six digits the approver compares, once the code was scanned.
#[tauri::command]
#[specta::specta]
pub async fn sync_get_linking_sas(
    app: AppHandle<Wry>,
    session_id: String,
) -> Result<String, CommandError> {
    account(&app)
        .linking_sas(&session_id)
        .await
        .map_err(|e| map_error(&app, "sync_get_linking_sas", &e))
}

/// `sync:approve-linking`: sends the master key and the account's vault list to the device.
#[tauri::command]
#[specta::specta]
pub async fn sync_approve_linking(
    app: AppHandle<Wry>,
    session_id: String,
) -> Result<(), CommandError> {
    account(&app)
        .approve_linking(&session_id)
        .await
        .map_err(|e| map_error(&app, "sync_approve_linking", &e))
}

/// `sync:link-via-qr`: the new device scans (or pastes) the approver's code.
#[tauri::command]
#[specta::specta]
pub async fn sync_link_via_qr(
    app: AppHandle<Wry>,
    qr_data: String,
) -> Result<LinkScannedView, CommandError> {
    account(&app)
        .link_via_qr(qr_data)
        .await
        .map(|scan| LinkScannedView {
            session_id: scan.session_id,
            verification_code: scan.verification_code,
        })
        .map_err(|e| map_error(&app, "sync_link_via_qr", &e))
}

/// `sync:complete-linking-qr`, one poll (the renderer polls every 3 s).
#[tauri::command]
#[specta::specta]
pub async fn sync_complete_linking_qr(
    app: AppHandle<Wry>,
    session_id: String,
) -> Result<LinkPollView, CommandError> {
    let session = app.state::<Session>().inner().clone();
    let reporter = app.clone();
    let poll = account(&app)
        .complete_linking_qr(&session, &session_id, move |outcome| {
            report_finalized(&reporter, outcome);
        })
        .await
        .map_err(|e| map_error(&app, "sync_complete_linking_qr", &e))?;
    Ok(match poll {
        LinkPoll::Waiting => LinkPollView::Waiting,
        LinkPoll::RateLimited => LinkPollView::RateLimited,
        LinkPoll::Linked { vaults } => LinkPollView::Linked { vaults },
    })
}

/// `sync:finalize-vault-choice`: opens the picked account vault, then registers the device. A
/// failure before the registration throws and keeps the choice; the registration's outcome goes
/// out as `SyncLinkingFinalizedEvent`.
#[tauri::command]
#[specta::specta]
pub async fn sync_finalize_vault_choice(
    app: AppHandle<Wry>,
    session_id: String,
    parent_folder_path: String,
    selected_vault_uuids: Vec<String>,
    primary_vault_uuid: String,
) -> Result<(), CommandError> {
    let session = app.state::<Session>().inner().clone();
    let choice = VaultChoice {
        session_id,
        parent_folder: parent_folder_path,
        selected: selected_vault_uuids,
        primary: primary_vault_uuid,
    };
    let outcome = account(&app)
        .finalize_vault_choice(&session, choice)
        .await
        .map_err(|e| map_error(&app, "sync_finalize_vault_choice", &e))?;
    report_finalized(&app, outcome);
    Ok(())
}

/// `sync:pick-vault-folder`: the parent folder for a linked vault, `None` when cancelled.
#[tauri::command]
#[specta::specta]
pub async fn sync_pick_vault_folder(app: AppHandle<Wry>) -> Result<Option<String>, CommandError> {
    super::blocking("sync_pick_vault_folder", move || {
        let title = super::vault::picker_title(&app);
        Ok(
            dialogs::pick_folder(&app, &title, None)
                .map(|path| path.to_string_lossy().into_owned()),
        )
    })
    .await
}
