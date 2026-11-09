//! The editor's documents (`crdt:*` of `ipc/crdt-handlers.ts`), through
//! `memry_desktop::editor::EditorHost`. Updates and states are raw bytes: `crdt_open_doc` and
//! `crdt_sync_step_1` answer with a framed `Response` ([`binary::framed`]), `crdt_apply_update`
//! and `crdt_sync_step_2` take the update as the raw body with `{ noteId }` in the metadata
//! header, so the four are binary commands (`binary.rs`). The calling window's label is the
//! holder, and the document's updates reach the window on the `Channel` it opened it with, as
//! [`memry_desktop::editor::frame`]s. `crdt_close_doc`, `crdt_typing_sent`
//! and `crdt_get_health` are typed commands.

use std::path::Path;
use std::sync::Arc;

use memry_desktop::editor::{Deliver, EditorHost, Subscriber, read_only_name};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody, Request, Response};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use crate::binary;

/// Whether this install's edits reach disk (`crdt:get-health`). Pulled by the renderer: the
/// verdict lands while the window loads, before anything listens.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CrdtHealth {
    pub persistent: bool,
    pub in_memory_sessions: u32,
}

/// The header of `crdt_open_doc`'s answer; the state then the state vector follow it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedHeader {
    /// The body is empty and owes no server body: the window may seed it from the file.
    needs_seed: bool,
    state_length: usize,
    /// Why the window must not edit it ([`read_only_name`]), or null.
    read_only: Option<&'static str>,
}

/// The header of `crdt_sync_step_1`'s answer; the diff then the state vector follow it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StepOneHeader {
    diff_length: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteMeta {
    note_id: String,
}

fn host<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<EditorHost>, CommandError> {
    app.try_state::<Arc<EditorHost>>()
        .map(|host| Arc::clone(&host))
        .ok_or_else(|| {
            CommandError::new(
                ErrorKind::Locked,
                "editor_not_serving",
                "No vault is open for editing.",
            )
        })
}

/// The calling window opens `note_id`: its state answers, and every update another window or
/// writer commits from now on reaches `on_update`. `vault_path` names the vault the window's
/// editor belongs to; another vault's editor is refused.
#[tauri::command]
pub async fn crdt_open_doc<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    note_id: String,
    vault_path: Option<String>,
    on_update: Channel<InvokeResponseBody>,
) -> Result<Response, CommandError> {
    let host = host(&app)?;
    let channel: Deliver = Arc::new(move |frame| binary::send_chunk(&on_update, frame).is_ok());
    let subscriber = Subscriber {
        window_label: window.label().to_owned(),
        channel,
    };
    let opened = blocking("crdt_open_doc", move || {
        host.open(&note_id, vault_path.as_deref().map(Path::new), subscriber)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await?;
    let header = OpenedHeader {
        needs_seed: opened.needs_seed,
        state_length: opened.state.len(),
        read_only: opened.read_only.map(read_only_name),
    };
    binary::framed(&header, &[&opened.state, &opened.state_vector])
}

/// A window's edit (the raw body): stored, queued for sync and sent to the other windows.
#[tauri::command]
pub async fn crdt_apply_update<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    request: Request<'_>,
) -> Result<(), CommandError> {
    apply("crdt_apply_update", &app, &window, &request).await
}

/// Sync step 2: what the window holds beyond the document (the raw body), taken like an edit.
#[tauri::command]
pub async fn crdt_sync_step_2<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    request: Request<'_>,
) -> Result<(), CommandError> {
    apply("crdt_sync_step_2", &app, &window, &request).await
}

async fn apply<R: Runtime>(
    command: &'static str,
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    request: &Request<'_>,
) -> Result<(), CommandError> {
    let meta: NoteMeta = binary::meta(request)?;
    let update = binary::raw_body(request)?.to_vec();
    let host = host(app)?;
    let label = window.label().to_owned();
    blocking(command, move || {
        host.apply_update(&meta.note_id, &update, &label)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// Sync step 1: the window's state vector is the raw body; the answer is what the document
/// holds beyond it, then the document's state vector. Refused unless the window opened the
/// document in the open vault.
#[tauri::command]
pub async fn crdt_sync_step_1<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    request: Request<'_>,
) -> Result<Response, CommandError> {
    let meta: NoteMeta = binary::meta(&request)?;
    let state_vector = binary::raw_body(&request)?.to_vec();
    let host = host(&app)?;
    let label = window.label().to_owned();
    let (diff, state_vector) = blocking("crdt_sync_step_1", move || {
        host.sync_step_1(&meta.note_id, &state_vector, &label)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await?;
    let header = StepOneHeader {
        diff_length: diff.len(),
    };
    binary::framed(&header, &[&diff, &state_vector])
}

/// The calling window closed its editor of `note_id`.
#[tauri::command]
#[specta::specta]
pub async fn crdt_close_doc<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    note_id: String,
) -> Result<(), CommandError> {
    // After a vault closed there is nothing left to release.
    let Ok(host) = host(&app) else { return Ok(()) };
    let label = window.label().to_owned();
    blocking("crdt_close_doc", move || {
        host.close(&note_id, &label);
        Ok(())
    })
    .await
}

/// The calling window sent its typing for the typing barrier `barrier` and holds new typing
/// until the barrier's release frame (`memry_desktop::editor::BARRIER`).
#[tauri::command]
#[specta::specta]
pub async fn crdt_typing_sent<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    barrier: u32,
) -> Result<(), CommandError> {
    // After a vault closed no outside edit waits.
    let Ok(host) = host(&app) else { return Ok(()) };
    host.typing_sent(window.label(), barrier);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn crdt_get_health<R: Runtime>(app: AppHandle<R>) -> Result<CrdtHealth, CommandError> {
    let Ok(host) = host(&app) else {
        return Ok(CrdtHealth {
            persistent: true,
            in_memory_sessions: 0,
        });
    };
    blocking("crdt_get_health", move || {
        let health = host
            .health()
            .map_err(|error| CommandError::from_core(&error))?;
        Ok(CrdtHealth {
            persistent: health.persistent,
            in_memory_sessions: health.in_memory_sessions,
        })
    })
    .await
}

/// Window `label` is gone, or its page died or was replaced: its documents are let go and its
/// channels dropped. On the caller's thread, the window event loop included, so a reloaded
/// page's first open comes after it: a blocking task could release the hold the new page just
/// took under the same label. The cost, accepted: `release_holder` waits for core's resident
/// lock, which an open or an edit holds while it waits for the writer, so a long sync write can
/// stall this event for its length.
pub fn forget_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(host) = app.try_state::<Arc<EditorHost>>() {
        host.forget_window(label);
    }
}
