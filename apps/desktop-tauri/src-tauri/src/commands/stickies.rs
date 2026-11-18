//! The sticky's drafts and window commands (`sticky:*` of `ipc/sticky-handlers.ts`). Drafts are
//! `memry_core::api::sticky_store`; the windows are `crate::windows::{sticky, edge_tab}`. Every
//! draft write sends `StickyDraftsChangedEvent` to every window and refreshes the edge tab, as
//! `drafts-changed.ts` does.
//! Send, undo and open-target are `super::sticky_send`.

use std::sync::Arc;

use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::sticky::drafts::{self, StickyDraft, StickyKind, StickyStore};
use memry_desktop::sticky::session::OpenRequest;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::tags::open_vault;
use crate::windows::edge_tab;
use crate::windows::sticky::{self, StickyWindow};

/// `StickyDraft` of `@memry/contracts/sticky-api`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StickyDraftView {
    pub id: String,
    pub content: String,
    /// `note`, `task` or `journal`.
    pub kind: String,
    pub created_at: String,
    pub modified_at: String,
}

impl From<StickyDraft> for StickyDraftView {
    fn from(draft: StickyDraft) -> Self {
        Self {
            id: draft.id,
            content: draft.content,
            kind: draft.kind,
            created_at: draft.created_at,
            modified_at: draft.modified_at,
        }
    }
}

/// `StickySaveDraftInput`: no id creates a draft.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StickySaveDraftInput {
    pub id: Option<String>,
    /// At most 100000 characters.
    pub content: String,
    pub kind: String,
}

/// `StickyWindowSession`: the draft the open sticky shows, none for a blank one.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StickyWindowSession {
    pub draft_id: Option<String>,
}

/// The open vault's drafts, written under this device's identity.
pub(crate) fn store<R: Runtime>(app: &AppHandle<R>) -> Result<StickyStore, CommandError> {
    let open = open_vault(app)?;
    let identity = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    drafts::open(&open, identity).map_err(|error| CommandError::from_core(&error))
}

pub(super) fn invalid(message: &str) -> CommandError {
    CommandError::new(ErrorKind::Invalid, "invalid", message.to_owned())
}

/// `STICKY_KINDS`: the zod enum refuses any other.
pub(super) fn kind(kind: &str) -> Result<StickyKind, CommandError> {
    match kind {
        "note" | "task" | "journal" => Ok(StickyKind::parse(kind)),
        _ => Err(invalid("sticky kind must be note, task or journal")),
    }
}

pub(super) fn non_empty(id: &str) -> Result<(), CommandError> {
    if id.is_empty() {
        return Err(invalid("sticky draft id must not be empty"));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn sticky_list_drafts(app: AppHandle<Wry>) -> Result<Vec<StickyDraftView>, CommandError> {
    blocking("sticky_list_drafts", move || {
        let drafts = store(&app)?
            .list()
            .map_err(|error| CommandError::from_core(&error))?;
        Ok(drafts.into_iter().map(StickyDraftView::from).collect())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn sticky_save_draft(
    app: AppHandle<Wry>,
    input: StickySaveDraftInput,
) -> Result<StickyDraftView, CommandError> {
    blocking("sticky_save_draft", move || {
        if let Some(id) = &input.id {
            non_empty(id)?;
        }
        let kind = kind(&input.kind)?;
        let saved = store(&app)?
            .save(input.id, input.content, kind)
            .map_err(|error| CommandError::from_core(&error))?;
        edge_tab::drafts_changed(&app);
        Ok(saved.into())
    })
    .await
}

/// Whether there was a draft to delete.
#[tauri::command]
#[specta::specta]
pub async fn sticky_delete_draft(app: AppHandle<Wry>, id: String) -> Result<bool, CommandError> {
    blocking("sticky_delete_draft", move || {
        non_empty(&id)?;
        let deleted = store(&app)?
            .delete(id)
            .map_err(|error| CommandError::from_core(&error))?;
        if deleted {
            edge_tab::drafts_changed(&app);
        }
        Ok(deleted)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub fn sticky_get_session(app: AppHandle<Wry>) -> StickyWindowSession {
    StickyWindowSession {
        draft_id: app.state::<StickyWindow>().draft_id(),
    }
}

/// Closes the sticky; its renderer saved the draft before asking.
#[tauri::command]
#[specta::specta]
pub fn sticky_tuck(app: AppHandle<Wry>) {
    sticky::tuck(&app);
}

/// The card's measured height in logical pixels; the shell clamps it to 140 to 560.
#[tauri::command]
#[specta::specta]
pub fn sticky_resize(app: AppHandle<Wry>, height: f64) -> Result<(), CommandError> {
    if !(height.is_finite() && height > 0.0) {
        return Err(invalid("sticky height must be positive"));
    }
    sticky::resize(&app, height)
        .map_err(|error| CommandError::new(ErrorKind::Internal, "window_failed", error.to_string()))
}

/// The edge tab unfolds the sticky on a draft, or blank for none (`sticky:unfold`).
#[tauri::command]
#[specta::specta]
pub fn sticky_unfold(app: AppHandle<Wry>, draft_id: Option<String>) -> Result<(), CommandError> {
    if let Some(id) = &draft_id {
        non_empty(id)?;
    }
    sticky::open(&app, OpenRequest::Draft(draft_id));
    Ok(())
}

/// The pointer entered (`true`) or left the edge tab: it fans the draft list out or folds it.
#[tauri::command]
#[specta::specta]
pub fn sticky_peek(app: AppHandle<Wry>, open: bool) -> Result<(), CommandError> {
    edge_tab::peek(&app, open)
        .map_err(|error| CommandError::new(ErrorKind::Internal, "window_failed", error.to_string()))
}
