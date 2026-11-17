//! The sticky window's test commands (Step 31, #3548).

use memry_desktop::sticky::session::OpenRequest;
use tauri::{AppHandle, Wry};

/// Opens the sticky as its shortcut does (`draft_id` absent) or as the edge tab unfolds a draft:
/// the OS delivers the real key to nobody in a headless run.
#[tauri::command]
pub fn e2e_open_sticky(app: AppHandle<Wry>, unfold: bool, draft_id: Option<String>) {
    let request = if unfold {
        OpenRequest::Draft(draft_id)
    } else {
        OpenRequest::Shortcut
    };
    crate::windows::sticky::open(&app, request);
}
