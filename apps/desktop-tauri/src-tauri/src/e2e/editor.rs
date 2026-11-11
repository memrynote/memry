//! The editor's write-back under test (Step 14k, #3531): what the open vault's write-back did
//! for a note, so `specs/editor/toggle-writeback-byte-stability.e2e.ts` waits for a pass that
//! compared the body with the file before it asserts the file's bytes.

use serde::Serialize;
use tauri::{AppHandle, Wry};

use super::vault_writeback::tier;
use crate::commands::error::CommandError;

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
