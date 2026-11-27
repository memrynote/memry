//! The "recently opened" commands (`recents:*` of `ipc/recents-handlers.ts`), each one call of
//! `memry_desktop::recents`. With no vault open, a read answers no items and a write `false`, as
//! Electron's handlers do.

use memry_desktop::recents::{self, RecentlyOpenedView, RecordRecentInput};
use memry_desktop::session::Session;
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::CommandError;

/// Records that the note or canvas was opened now: whether it was written.
#[tauri::command]
#[specta::specta]
pub async fn recents_record<R: Runtime>(
    app: AppHandle<R>,
    input: RecordRecentInput,
) -> Result<bool, CommandError> {
    blocking("recents_record", move || {
        let Some(open) = app.state::<Session>().current() else {
            return Ok(false);
        };
        recents::record(&open, input).map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// The newest opened items that still exist, at most `limit` (50 when absent).
#[tauri::command]
#[specta::specta]
pub async fn recents_list<R: Runtime>(
    app: AppHandle<R>,
    limit: Option<u32>,
) -> Result<Vec<RecentlyOpenedView>, CommandError> {
    blocking("recents_list", move || {
        let Some(open) = app.state::<Session>().current() else {
            return Ok(Vec::new());
        };
        recents::list(&open, limit).map_err(|error| CommandError::from_core(&error))
    })
    .await
}
