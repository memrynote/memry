//! The sticky's send, undo and open-target commands (`sticky:send`, `sticky:undo-send`,
//! `sticky:open-target` of `ipc/sticky-handlers.ts`). Where the text lands and the undo window
//! are `memry_desktop::sticky::send`; this adapter gates the kinds on the feature settings,
//! deletes the sent draft, remembers the kind for `defaultKind: 'last'` and tells the windows.

use memry_desktop::i18n;
use memry_desktop::locale::LocaleService;
use memry_desktop::session::OpenVault;
use memry_desktop::settings::SettingsService;
use memry_desktop::sticky::drafts::StickyKind;
use memry_desktop::sticky::send::{Sent, UndoLedger, local_now};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::notes::{self, open_vault};
use super::stickies::{StickyDraftView, invalid, kind, non_empty, store};
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

const CONTENT_LIMIT: usize = 100_000;

fn now_ms() -> i64 {
    i64::try_from(memry_desktop::telemetry::time::now_ms()).unwrap_or(i64::MAX)
}

/// A refusal the user reads, in the app's language (`sticky.errors.<key>` of `inbox`).
fn refused(app: &AppHandle<Wry>, code: &str, key: &str) -> CommandError {
    let locale = app.state::<Arc<LocaleService>>().get();
    let message = i18n::t(
        locale,
        &format!("inbox:sticky.errors.{key}"),
        &Default::default(),
    );
    CommandError::new(ErrorKind::Invalid, code, message)
}

fn group(app: &AppHandle<Wry>, open: &OpenVault, name: &str) -> Map<String, Value> {
    match app.state::<SettingsService>().read_group(Some(open), name) {
        Ok(read) => read.value,
        Err(error) => {
            tracing::warn!(
                scope = "StickySend",
                "could not read the {name} settings: {error}"
            );
            Map::new()
        }
    }
}

/// `assertKindEnabled`: a task or journal send needs its feature on.
fn enabled(app: &AppHandle<Wry>, open: &OpenVault, kind: StickyKind) -> Result<(), CommandError> {
    let (feature, code, key) = match kind {
        StickyKind::Task => ("tasks", "sticky_tasks_off", "tasksOff"),
        StickyKind::Journal => ("journal", "sticky_journal_off", "journalOff"),
        StickyKind::Note => return Ok(()),
    };
    let on = group(app, open, "features")
        .get(feature)
        .and_then(Value::as_bool)
        .unwrap_or(true);
    match on {
        true => Ok(()),
        false => Err(refused(app, code, key)),
    }
}

/// `rememberStickyKind`: the kind a send used, for `defaultKind: 'last'`. A failure is logged;
/// the send already landed.
fn remember(app: &AppHandle<Wry>, open: &OpenVault, kind: StickyKind) {
    if group(app, open, "sticky")
        .get("lastKind")
        .and_then(Value::as_str)
        == Some(kind.as_str())
    {
        return;
    }
    let mut patch = Map::new();
    patch.insert("lastKind".to_owned(), json!(kind.as_str()));
    let written = app
        .state::<SettingsService>()
        .write_group(Some(open), "sticky", patch)
        .map_err(super::settings::map_error)
        .and_then(|change| super::settings::announce(app, &change.group, change.fields));
    if let Err(error) = written {
        tracing::warn!(
            scope = "StickySend",
            "could not remember the sticky kind: {error:?}"
        );
    }
}

fn send(app: &AppHandle<Wry>, input: StickySendInput) -> Result<StickySent, CommandError> {
    if let Some(id) = &input.draft_id {
        non_empty(id)?;
    }
    let kind = kind(&input.kind)?;
    if input.content.chars().count() > CONTENT_LIMIT {
        return Err(invalid("sticky text takes at most 100000 characters"));
    }
    let content = input.content.trim();
    if content.is_empty() {
        return Err(refused(app, "sticky_empty", "empty"));
    }
    let open = open_vault(app)?;
    enabled(app, &open, kind)?;
    let service = notes::service(app)?;
    let now = local_now();
    let sent = match kind {
        StickyKind::Note => service
            .send_sticky_note(&open, content)
            .map_err(|error| notes::failed(&error)),
        StickyKind::Task => {
            let tasks = group(app, &open, "tasks");
            let default = tasks.get("defaultProjectId").and_then(Value::as_str);
            service
                .send_sticky_task(&open, content, default, now)
                .map_err(|error| notes::failed(&error))
        }
        StickyKind::Journal => {
            let today = now.date().key();
            super::journal::landed(app, &open, true, || {
                service.send_sticky_journal(&open, content, &today)
            })
            .map(|_| Sent {
                target_id: today.clone(),
                title: today,
            })
        }
    }
    .inspect_err(|error| {
        tracing::error!(
            scope = "StickySend",
            kind = kind.as_str(),
            "sticky send failed: {error:?}"
        );
    })?;

    // The text now lives in its target; only then does the draft go. A draft that stays is
    // logged, not a failed send: the user would send the text twice.
    if let Some(id) = input.draft_id {
        match store(app).and_then(|drafts| {
            drafts
                .delete(id)
                .map_err(|error| CommandError::from_core(&error))
        }) {
            Ok(true) => edge_tab::drafts_changed(app),
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(
                    scope = "StickySend",
                    "the sent draft could not be deleted: {error:?}"
                );
            }
        }
    }
    remember(app, &open, kind);
    let undo_token = app
        .state::<UndoLedger>()
        .record(kind, &sent, content, now_ms());
    Ok(StickySent {
        kind: kind.as_str().to_owned(),
        target_id: sent.target_id,
        title: sent.title,
        undo_token,
    })
}

/// Sends the text to a note, a task or today's journal entry, and deletes its draft.
#[tauri::command]
#[specta::specta]
pub async fn sticky_send(
    app: AppHandle<Wry>,
    input: StickySendInput,
) -> Result<StickySent, CommandError> {
    blocking("sticky_send", move || send(&app, input)).await
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
        let Some(undo) = app.state::<UndoLedger>().take(&undo_token, now_ms()) else {
            return Err(refused(&app, "sticky_undo_expired", "undoExpired"));
        };
        let open = open_vault(&app)?;
        notes::service(&app)?
            .undo_sticky_send(&open, &undo)
            .map_err(|error| {
                tracing::error!(
                    scope = "StickySend",
                    kind = undo.kind.as_str(),
                    "sticky undo failed: {error}"
                );
                notes::failed(&error)
            })?;
        let draft = store(&app)?
            .save(None, undo.content, undo.kind)
            .map_err(|error| CommandError::from_core(&error))?;
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
