//! The large-file viewer's commands (`notes:large-file-*` of `ipc/notes-handlers.ts`, Step 14g,
//! #3531), each one call of `memry_desktop::large_file::LargeFiles`. The index scan and a
//! search report on the `Channel` their call passed, which replaces Electron's two broadcast
//! progress events: only the caller hears its own session.

use std::sync::Arc;

use memry_desktop::large_file::{
    EventSink, LargeFileEvent, LargeFileLines, LargeFileOpenResult, LargeFileReadLinesInput,
    LargeFileSearchInput, LargeFileSearchProgress, LargeFileSearchResult, LargeFiles, ProgressSink,
};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Webview, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::notes::open_vault;

/// The sessions `vault_boot` manages with the session.
fn large_files(app: &AppHandle<Wry>) -> Result<Arc<LargeFiles>, CommandError> {
    app.try_state::<Arc<LargeFiles>>()
        .map(|files| files.inner().clone())
        .ok_or_else(|| {
            CommandError::new(
                ErrorKind::Internal,
                "large_files_missing",
                "no large-file sessions",
            )
        })
}

/// A renderer channel as a sink. A send fails only once the webview dropped the channel, which
/// a later close cleans up.
fn into_sink<T: serde::Serialize + Clone + Send + Sync + 'static>(
    channel: Channel<T>,
) -> Arc<dyn Fn(T) + Send + Sync> {
    Arc::new(move |message| {
        if let Err(error) = channel.send(message) {
            tracing::debug!(
                scope = "LargeFileSession",
                "a channel message was not delivered: {error}"
            );
        }
    })
}

/// `notes:large-file-open`: the note's file, opened for paged reads by the calling page. Answers
/// at once; the index scan reports on `on_event`.
#[tauri::command]
#[specta::specta]
pub async fn notes_large_file_open(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    note_id: String,
    on_event: Channel<LargeFileEvent>,
) -> Result<LargeFileOpenResult, CommandError> {
    blocking("notes_large_file_open", move || {
        let vault = open_vault(&app)?;
        let sink: EventSink = into_sink(on_event);
        large_files(&app)?
            .open(&vault, &note_id, webview.label(), sink)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `notes:large-file-read-lines`: one page of lines, or `null` once the session is gone.
#[tauri::command]
#[specta::specta]
pub async fn notes_large_file_read_lines(
    app: AppHandle<Wry>,
    input: LargeFileReadLinesInput,
) -> Result<Option<LargeFileLines>, CommandError> {
    blocking("notes_large_file_read_lines", move || {
        large_files(&app)?
            .read_lines(&input)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `notes:large-file-search`: every match of the query in the session's file, its growing count
/// on `on_progress`.
#[tauri::command]
#[specta::specta]
pub async fn notes_large_file_search(
    app: AppHandle<Wry>,
    input: LargeFileSearchInput,
    on_progress: Channel<LargeFileSearchProgress>,
) -> Result<Option<LargeFileSearchResult>, CommandError> {
    blocking("notes_large_file_search", move || {
        let progress: ProgressSink = into_sink(on_progress);
        large_files(&app)?
            .search(&input, progress)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `notes:large-file-close`: releases one open's lease.
#[tauri::command]
#[specta::specta]
pub async fn notes_large_file_close(
    app: AppHandle<Wry>,
    session_id: String,
) -> Result<(), CommandError> {
    blocking("notes_large_file_close", move || {
        large_files(&app)?.close(&session_id);
        Ok(())
    })
    .await
}

/// A page that closed or started a new document never closes its leases: they go now.
pub fn release_page(app: &AppHandle<Wry>, label: &str) {
    if let Some(files) = app.try_state::<Arc<LargeFiles>>() {
        files.release_owner(label);
    }
}
