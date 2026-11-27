//! The sticky's send, undo and open-target commands (`sticky:send`, `sticky:undo-send`,
//! `sticky:open-target` of `ipc/sticky-handlers.ts`). The send and the undo are
//! `memry_desktop::sticky::send::StickySend`; this adapter tells the windows what changed. A
//! refusal rejects with its `sticky_*` code, which the renderer translates.

use std::sync::Arc;

use memry_desktop::settings::SettingsService;
use memry_desktop::sticky::send::{SendError, SendInput, StickySend, UndoLedger, local_now};
use memry_desktop::vault::config::settings::vault_settings;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::notes::{self, open_vault};
use super::stickies::{StickyDraftView, kind, non_empty, store};
use crate::events::{StickyOpenTargetRequestedEvent, send_to};
use crate::windows::registry::WindowRegistry;
use crate::windows::{edge_tab, sticky};

/// `StickySendSchema`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StickySendInput {
    /// The draft the text came from; deleted once the send lands.
    pub draft_id: Option<String>,
    /// 1 to 100000 characters.
    pub content: String,
    /// `note`, `task` or `journal`.
    pub kind: String,
}

/// The success arm of `StickySendResult`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StickySent {
    pub kind: String,
    /// A note id, a task id, or the journal day (`YYYY-MM-DD`).
    pub target_id: String,
    pub title: String,
    /// None for a journal send, which has no undo.
    pub undo_token: Option<String>,
}

fn now_ms() -> i64 {
    i64::try_from(memry_desktop::telemetry::time::now_ms()).unwrap_or(i64::MAX)
}

fn failed(error: &SendError, what: &str) -> CommandError {
    match (error, error.code()) {
        (SendError::Notes(error), _) => {
            tracing::error!(scope = "StickySend", "sticky {what} failed: {error}");
            notes::failed(error)
        }
        (refusal, Some(code)) => CommandError::new(ErrorKind::Invalid, code, refusal.to_string()),
        (refusal, None) => CommandError::new(ErrorKind::Internal, "internal", refusal.to_string()),
    }
}

/// Sends the text to a note, a task or today's journal entry, and deletes its draft.
#[tauri::command]
#[specta::specta]
pub async fn sticky_send(
    app: AppHandle<Wry>,
    input: StickySendInput,
) -> Result<StickySent, CommandError> {
    blocking("sticky_send", move || {
        if let Some(id) = &input.draft_id {
            non_empty(id)?;
        }
        let kind = kind(&input.kind)?;
        let open = open_vault(&app)?;
        let (notes, drafts) = (notes::service(&app)?, store(&app)?);
        let before = vault_settings(Some(&open.path));
        let flow = StickySend {
            notes: &notes,
            open: &open,
            settings: &app.state::<SettingsService>(),
            drafts: &drafts,
            ledger: &app.state::<Arc<UndoLedger>>(),
        };
        let input = SendInput {
            draft_id: input.draft_id,
            content: input.content,
            kind,
        };
        let landed = flow
            .send(input, local_now(), now_ms())
            .map_err(|error| failed(&error, "send"))?;
        if let Some(day) = &landed.day {
            super::journal::told(&app, &open, &before, true, day);
        }
        if landed.draft_deleted {
            edge_tab::drafts_changed(&app);
        }
        if let Some(change) = landed.remembered
            && let Err(error) = super::settings::announce(&app, &change.group, change.fields)
        {
            tracing::warn!(
                scope = "StickySend",
                "the remembered sticky kind was not announced: {error:?}"
            );
        }
        Ok(StickySent {
            kind: landed.kind.as_str().to_owned(),
            target_id: landed.sent.target_id,
            title: landed.sent.title,
            undo_token: landed.undo_token,
        })
    })
    .await
}

/// Takes a note or task send back within its minute and answers the draft it restores.
#[tauri::command]
#[specta::specta]
pub async fn sticky_undo_send(
    app: AppHandle<Wry>,
    undo_token: String,
) -> Result<StickyDraftView, CommandError> {
    blocking("sticky_undo_send", move || {
        non_empty(&undo_token)?;
        let open = open_vault(&app)?;
        let (notes, drafts) = (notes::service(&app)?, store(&app)?);
        let flow = StickySend {
            notes: &notes,
            open: &open,
            settings: &app.state::<SettingsService>(),
            drafts: &drafts,
            ledger: &app.state::<Arc<UndoLedger>>(),
        };
        let draft = flow
            .undo(&undo_token, now_ms())
            .map_err(|error| failed(&error, "undo"))?;
        edge_tab::drafts_changed(&app);
        Ok(draft.into())
    })
    .await
}

/// Shows the main window, asks it to open what a send made, and tucks the sticky away.
#[tauri::command]
#[specta::specta]
pub fn sticky_open_target(
    app: AppHandle<Wry>,
    kind: String,
    target_id: String,
) -> Result<(), CommandError> {
    let kind = super::stickies::kind(&kind)?;
    non_empty(&target_id)?;
    crate::tray::show_main_window(&app);
    if let Some(main) = WindowRegistry::main_window(&app) {
        send_to(
            &app,
            main.label(),
            StickyOpenTargetRequestedEvent {
                kind: kind.as_str().to_owned(),
                target_id,
            },
        );
    }
    sticky::tuck(&app);
    Ok(())
}
