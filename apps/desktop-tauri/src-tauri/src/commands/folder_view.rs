//! A folder view's and a tag table's rows, columns and saved views (`folder-view:*` of
//! `ipc/folder-view-handlers.ts`), each one call of `memry_desktop::folder_view`.
//! `folder-view:get-folder-suggestions` is the inbox's AI filing and is not ported here.

use std::sync::Arc;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Wry};

use memry_desktop::folder_view::view::{
    AvailablePropertiesView, ListInput, ListView, SavedViewsView, ViewScope,
};
use memry_desktop::folder_view::{self, FolderViewError, Resolved, is_tag};
use memry_desktop::notes::folders;
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::vault::folder_file::FolderConfigView;

use super::blocking;
use super::error::CommandError;
use super::tag_schema::schemas;
use super::tags::open_vault;

fn failed(error: &FolderViewError) -> CommandError {
    CommandError::from_core(error)
}

/// The resolved tags a tag scope reads (its fields and the tags that extend it); a folder
/// scope reads none.
fn resolved_for(app: &AppHandle<Wry>, scope: &ViewScope) -> Result<Option<Resolved>, CommandError> {
    if !is_tag(scope) {
        return Ok(None);
    }
    schemas(app)?
        .resolved_tags()
        .map(Some)
        .map_err(|error| CommandError::from_core(&error))
}

/// `folder-view:list-with-properties`.
#[tauri::command]
#[specta::specta]
pub async fn folder_view_list(
    app: AppHandle<Wry>,
    input: ListInput,
) -> Result<ListView, CommandError> {
    blocking("folder_view_list", move || {
        let resolved = resolved_for(&app, &input.scope)?;
        folder_view::list(&open_vault(&app)?, &input, resolved.as_ref()).map_err(|e| failed(&e))
    })
    .await
}

/// `folder-view:get-available-properties`.
#[tauri::command]
#[specta::specta]
pub async fn folder_view_available_properties(
    app: AppHandle<Wry>,
    scope: ViewScope,
) -> Result<AvailablePropertiesView, CommandError> {
    blocking("folder_view_available_properties", move || {
        let resolved = resolved_for(&app, &scope)?;
        folder_view::available_properties(&open_vault(&app)?, &scope, resolved.as_ref())
            .map_err(|e| failed(&e))
    })
    .await
}

/// `folder-view:get-views`.
#[tauri::command]
#[specta::specta]
pub async fn folder_view_get_views(
    app: AppHandle<Wry>,
    scope: ViewScope,
) -> Result<SavedViewsView, CommandError> {
    blocking("folder_view_get_views", move || {
        let resolved = resolved_for(&app, &scope)?;
        folder_view::views(&open_vault(&app)?, &scope, resolved.as_ref()).map_err(|e| failed(&e))
    })
    .await
}

fn edit(
    app: &AppHandle<Wry>,
    scope: &ViewScope,
    change: impl FnOnce(Vec<Value>) -> Result<Vec<Value>, FolderViewError>,
) -> Result<(), CommandError> {
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    folder_view::edit_views(&open_vault(app)?, scope, store, change).map_err(|e| failed(&e))
}

/// `folder-view:set-view`: adds the view or replaces the one named `previousName` (else its
/// own name).
#[tauri::command]
#[specta::specta]
pub async fn folder_view_set_view(
    app: AppHandle<Wry>,
    scope: ViewScope,
    view: Map<String, Value>,
    previous_name: Option<String>,
) -> Result<(), CommandError> {
    blocking("folder_view_set_view", move || {
        edit(&app, &scope, |views| {
            folder_view::with_view(views, Value::Object(view), previous_name.as_deref())
        })
    })
    .await
}

/// `folder-view:delete-view`.
#[tauri::command]
#[specta::specta]
pub async fn folder_view_delete_view(
    app: AppHandle<Wry>,
    scope: ViewScope,
    view_name: String,
) -> Result<(), CommandError> {
    blocking("folder_view_delete_view", move || {
        edit(&app, &scope, |views| {
            Ok(folder_view::without_view(views, &view_name))
        })
    })
    .await
}

/// `folder-view:get-config`: the folder's `.folder.md` as `notes_get_folder_config` reads it;
/// the renderer fills in the default view.
#[tauri::command]
#[specta::specta]
pub async fn folder_view_get_config(
    app: AppHandle<Wry>,
    folder_path: String,
) -> Result<Option<FolderConfigView>, CommandError> {
    blocking("folder_view_get_config", move || {
        folders::config(&open_vault(&app)?, &folder_path)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `folder-view:set-config`.
#[tauri::command]
#[specta::specta]
pub async fn folder_view_set_config(
    app: AppHandle<Wry>,
    folder_path: String,
    config: Map<String, Value>,
) -> Result<(), CommandError> {
    blocking("folder_view_set_config", move || {
        folder_view::set_config(&open_vault(&app)?, &folder_path, &config).map_err(|e| failed(&e))
    })
    .await
}

/// `folder-view:folder-exists`.
#[tauri::command]
#[specta::specta]
pub async fn folder_view_folder_exists(
    app: AppHandle<Wry>,
    folder_path: String,
) -> Result<bool, CommandError> {
    blocking("folder_view_folder_exists", move || {
        Ok(folder_view::folder_exists(&open_vault(&app)?, &folder_path))
    })
    .await
}
