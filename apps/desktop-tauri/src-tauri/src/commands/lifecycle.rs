use crate::error::AppResult;

/// Renderer→main signal that pending save flushes finished.
///
/// At M2 there is no quit-orchestration coordinator on the Rust side; the M8.0
/// lifecycle milestone introduces a flush coordinator that gates window close
/// on this notification. Until then the command is a thin no-op acknowledgement
/// so the renderer's `useFlushOnQuit` hook can keep its existing contract
/// without 404s through the mock router.
#[tauri::command]
#[specta::specta]
pub async fn notify_flush_done() -> AppResult<()> {
    tracing::debug!("notify_flush_done received (M2 no-op)");
    Ok(())
}
