//! The editor's write-back under test (Step 14k, #3531): what the open vault's write-back did
//! for a note, so `specs/editor/toggle-writeback-byte-stability.e2e.ts` waits for a pass that
//! compared the body with the file before it asserts the file's bytes. And a typing hold held
//! open, so `specs/notes/note-outside-edit.e2e.ts` types while an outside edit's hold is on.

use std::sync::Arc;
use std::time::Duration;

use memry_desktop::editor::{BARRIER_WAIT, EditorHost};
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
    let host = app
        .try_state::<Arc<EditorHost>>()
        .map(|host| Arc::clone(&host))
        .ok_or_else(|| CommandError::new(ErrorKind::Locked, "editor_not_serving", "no vault"))?;
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
