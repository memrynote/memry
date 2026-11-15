//! The search palette (Step 23, #3540): the `search:*` channels of Electron's
//! `ipc/search-handlers.ts` that the renderer calls, each one call of `memry_desktop::search`.
//! With no vault open the reads answer empty, as Electron's handlers do when their database
//! getter throws, and the recents writes refuse with "no vault is open".

use std::sync::Arc;

use memry_desktop::embedding::service::EmbeddingService;
use memry_desktop::search::view::{
    AddReasonInput, QuickSearchResponse, SearchReason, SearchResponse, SearchStats,
};
use memry_desktop::search::{self, AddError, Invalid, SearchQueryInput, Searcher};
use memry_desktop::session::{OpenVault, Session};
use memry_desktop::settings::SettingsService;
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::tags::open_vault;
use crate::shell::services::telemetry;

fn invalid(error: Invalid) -> CommandError {
    CommandError::new(ErrorKind::Invalid, "invalid", error.to_string())
}

/// Runs `search` over the open vault, or answers the empty default with none open.
fn searching<R: Runtime, T: Default>(
    app: &AppHandle<R>,
    search: impl FnOnce(&Searcher) -> Result<T, Invalid>,
) -> Result<T, CommandError> {
    let Some(vault) = app.state::<Session>().current() else {
        return Ok(T::default());
    };
    let settings = app.state::<SettingsService>().inner().clone();
    let searcher = Searcher {
        vault: &vault,
        settings: &settings,
        model: app
            .try_state::<Arc<EmbeddingService>>()
            .map(|model| model.inner().clone()),
        telemetry: telemetry(app),
    };
    search(&searcher).map_err(invalid)
}

fn current<R: Runtime>(app: &AppHandle<R>) -> Option<OpenVault> {
    app.state::<Session>().current()
}

/// `search:query`: the grouped results, with the semantic leg fused in when AI is on.
#[tauri::command]
#[specta::specta]
pub async fn search_query<R: Runtime>(
    app: AppHandle<R>,
    input: SearchQueryInput,
) -> Result<SearchResponse, CommandError> {
    blocking("search_query", move || {
        searching(&app, |searcher| searcher.query(input))
    })
    .await
}

/// `search:quick`: the best results across every group, optionally only notes of
/// `note_file_types`.
#[tauri::command]
#[specta::specta]
pub async fn search_quick<R: Runtime>(
    app: AppHandle<R>,
    text: String,
    note_file_types: Option<Vec<String>>,
) -> Result<QuickSearchResponse, CommandError> {
    blocking("search_quick", move || {
        searching(&app, |searcher| searcher.quick(&text, note_file_types))
    })
    .await
}

/// `search:get-stats`: the live rows of each type; zeros with no vault open.
#[tauri::command]
#[specta::specta]
pub async fn search_get_stats<R: Runtime>(app: AppHandle<R>) -> Result<SearchStats, CommandError> {
    blocking("search_get_stats", move || {
        Ok(current(&app)
            .map(|vault| search::stats(&vault))
            .unwrap_or_default())
    })
    .await
}

/// `search:get-reasons`: the recently opened results, newest first. A failed read answers none,
/// as Electron does.
#[tauri::command]
#[specta::specta]
pub async fn search_get_reasons<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<SearchReason>, CommandError> {
    blocking("search_get_reasons", move || {
        let Some(vault) = current(&app) else {
            return Ok(Vec::new());
        };
        Ok(search::reasons(&vault)
            .inspect_err(|error| tracing::error!(scope = "Search", "get reasons failed: {error}"))
            .unwrap_or_default())
    })
    .await
}

/// `search:add-reason`: records a result opened from the palette and answers its row.
#[tauri::command]
#[specta::specta]
pub async fn search_add_reason<R: Runtime>(
    app: AppHandle<R>,
    input: AddReasonInput,
) -> Result<SearchReason, CommandError> {
    blocking("search_add_reason", move || {
        let vault = open_vault(&app)?;
        search::add_reason(&vault, input).map_err(|error| match error {
            AddError::Invalid(error) => invalid(error),
            AddError::Storage(error) => CommandError::from_core(&error),
        })
    })
    .await
}

/// `search:clear-reasons`.
#[tauri::command]
#[specta::specta]
pub async fn search_clear_reasons<R: Runtime>(app: AppHandle<R>) -> Result<(), CommandError> {
    blocking("search_clear_reasons", move || {
        let vault = open_vault(&app)?;
        search::clear_reasons(&vault).map_err(|error| CommandError::from_core(&error))
    })
    .await
}
