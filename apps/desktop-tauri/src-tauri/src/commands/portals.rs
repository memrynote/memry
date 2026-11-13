//! The portals commands (`portals:get-usage`, `portals:stamp-anchor` and `portals:search` of
//! `ipc/portals-handlers.ts`, #4415), each one call of `memry_desktop::notes::portals`.

use memry_desktop::notes::portals::{
    self, PortalSearchInput, PortalSearchView, PortalUsageView, StampAnchorView,
};
use tauri::{AppHandle, Runtime};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::notes::{failed, open_vault, service};

/// `portals:get-usage`: the notes that show `note_id`, or its block `anchor`, with the notes
/// that link to it.
#[tauri::command]
#[specta::specta]
pub async fn portals_get_usage<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
    anchor: Option<String>,
) -> Result<PortalUsageView, CommandError> {
    blocking("portals_get_usage", move || {
        portals::usage(&open_vault(&app)?, &note_id, anchor.as_deref())
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `portals:stamp-anchor`: the block's anchor, given one when it has none.
#[tauri::command]
#[specta::specta]
pub async fn portals_stamp_anchor<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
    block_id: String,
) -> Result<StampAnchorView, CommandError> {
    blocking("portals_stamp_anchor", move || {
        service(&app)?
            .stamp_anchor(&open_vault(&app)?, &note_id, &block_id)
            .map_err(|error| failed(&error))
    })
    .await
}

/// `portals:search`: the blocks a text or tag finds, `PortalSearchSchema` checked here.
#[tauri::command]
#[specta::specta]
pub async fn portals_search<R: Runtime>(
    app: AppHandle<R>,
    input: PortalSearchInput,
) -> Result<PortalSearchView, CommandError> {
    check_search(&input)?;
    blocking("portals_search", move || {
        portals::search(&open_vault(&app)?, &input).map_err(|error| CommandError::from_core(&error))
    })
    .await
}

fn check_search(input: &PortalSearchInput) -> Result<(), CommandError> {
    let invalid = |message: &str| {
        Err(CommandError::new(
            ErrorKind::Invalid,
            "portal_search_input",
            message,
        ))
    };
    if !(1..=200).contains(&input.limit) {
        return invalid("limit must be between 1 and 200");
    }
    let empty = |value: &Option<String>| value.as_deref().is_some_and(str::is_empty);
    if empty(&input.text) || empty(&input.tag) {
        return invalid("text and tag must not be empty");
    }
    if input.text.is_none() && input.tag.is_none() {
        return invalid("text or tag is required");
    }
    Ok(())
}
