//! The editor's write-back under test (Step 14k, #3531): what the open vault's write-back did
//! for a note, so `specs/editor/toggle-writeback-byte-stability.e2e.ts` waits for a pass that
//! compared the body with the file before it asserts the file's bytes. And a typing hold held
//! open, so `specs/notes/note-outside-edit.e2e.ts` types while an outside edit's hold is on.
//! And what an open note's document holds as markdown (Step 17 L8, #3534), so the editor specs
//! assert on the document as well as on the file.

use std::sync::Arc;
use std::time::Duration;

use memry_desktop::e2e::crdt_body;
use memry_desktop::editor::{BARRIER_WAIT, EditorHost};
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::{OpenVault, Session};
use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};

use super::vault_writeback::tier;
use crate::commands::error::{CommandError, ErrorKind};

/// `getWritebackDebugState` of desktop `crdt-writeback.ts`. `lastMarkdown` and `sourceRestore`
/// are always null: a pass's output is the file, which `e2e_vault_read_file` reads, and the app
/// keeps the author's spelling without a separate restore step.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eWritebackDebug {
    pub pending: bool,
    pub scheduled_count: u32,
    pub performed_count: u32,
    pub last_markdown: Option<String>,
    pub last_error: Option<String>,
    pub source_restore: Option<String>,
}

/// The note's write-back in this vault session, `None` before its first schedule.
#[tauri::command]
pub fn e2e_writeback_debug_state(
    app: AppHandle<Wry>,
    note_id: String,
) -> Result<Option<E2eWritebackDebug>, CommandError> {
    Ok(tier(&app)?
        .writeback_debug(&note_id)
        .map(|debug| E2eWritebackDebug {
            pending: debug.pending,
            scheduled_count: debug.scheduled_count,
            performed_count: debug.performed_count,
            last_markdown: None,
            last_error: debug.last_error,
            source_restore: None,
        }))
}

/// `getCrdtMarkdownSourceState` of desktop `test-hooks.ts:576`.
#[derive(Debug, Clone, Serialize)]
pub struct E2eMarkdownSource {
    pub source: String,
    pub current: Option<String>,
}

fn editor_host(app: &AppHandle<Wry>) -> Result<Arc<EditorHost>, CommandError> {
    app.try_state::<Arc<EditorHost>>()
        .map(|host| Arc::clone(&host))
        .ok_or_else(|| CommandError::new(ErrorKind::Locked, "editor_not_serving", "no vault"))
}

/// Runs `read` with the editor host, the open vault and the device store, off the main thread.
async fn read_open_document<T: Send + 'static>(
    app: AppHandle<Wry>,
    read: impl FnOnce(&EditorHost, &OpenVault, Arc<DeviceIdentityStore>) -> Result<T, String>
    + Send
    + 'static,
) -> Result<T, CommandError> {
    let failed = |error: String| CommandError::new(ErrorKind::Internal, "e2e_crdt_read", error);
    let host = editor_host(&app)?;
    let open = app
        .state::<Session>()
        .current()
        .ok_or_else(|| failed("no vault is open".to_owned()))?;
    let store = app
        .try_state::<Arc<DeviceIdentityStore>>()
        .map(|store| Arc::clone(&store))
        .ok_or_else(|| failed("no device identity store".to_owned()))?;
    tauri::async_runtime::spawn_blocking(move || read(&host, &open, store))
        .await
        .map_err(|error| failed(error.to_string()))?
        .map_err(failed)
}

/// `getCrdtDocMarkdown`: the open document as markdown, null when no window has the note open.
#[tauri::command]
pub async fn e2e_get_crdt_doc_body(
    app: AppHandle<Wry>,
    note_id: String,
) -> Result<Option<String>, CommandError> {
    read_open_document(app, move |host, open, store| {
        crdt_body::doc_markdown(host, &open.vault, store, &note_id)
    })
    .await
}

/// `getCrdtMarkdownSourceState`: the author's bytes kept beside the open document and the house
/// style it serializes to now, null when no window has the note open or no record exists.
#[tauri::command]
pub async fn e2e_get_crdt_markdown_source(
    app: AppHandle<Wry>,
    note_id: String,
) -> Result<Option<E2eMarkdownSource>, CommandError> {
    read_open_document(app, move |host, open, store| {
        crdt_body::markdown_source(host, &open.vault, store, &note_id).map(|found| {
            found.map(|record| E2eMarkdownSource {
                source: record.source,
                current: record.current,
            })
        })
    })
    .await
}

/// Asks the windows that have `note_id` open to hold their typing, as an outside edit does
/// before it applies, and keeps the hold `ms` long. Answers once every window holds (or the
/// host stopped waiting for it): false when no window has the note open.
/// An outside edit fed meanwhile asks again and ends the windows' hold itself; the release this
/// hold sends then ends none.
#[tauri::command]
pub async fn e2e_editor_hold_typing(
    app: AppHandle<Wry>,
    note_id: String,
    ms: u64,
) -> Result<bool, CommandError> {
    let host = editor_host(&app)?;
    let (held, answered) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let hold = host.hold_typing(&note_id, BARRIER_WAIT);
        // The command's own wait ends only by this answer; it cannot have gone.
        let _ = held.send(hold.is_some());
        std::thread::sleep(Duration::from_millis(ms));
        drop(hold);
    });
    tauri::async_runtime::spawn_blocking(move || answered.recv().unwrap_or(false))
        .await
        .map_err(|error| CommandError::new(ErrorKind::Internal, "e2e_hold", error.to_string()))
}
