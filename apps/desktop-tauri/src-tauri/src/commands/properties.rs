//! The property value commands (`properties:get`, `set`, `merge`, `rename` of
//! `ipc/properties-handlers.ts`, #3530 Step 13k-3), each one call of
//! `memry_desktop::notes::properties`. A note or a journal day's id alike. The note event comes
//! from the file's row fact, as every note event does.

use memry_desktop::notes::properties::{PropertyValueView, SetPropertiesView};
use serde_json::{Map, Value};
use tauri::{AppHandle, Wry};

use super::blocking;
use super::error::CommandError;
use super::notes::{open_vault, service};

/// `properties:get`: the note's values in its frontmatter's order; none for no note.
#[tauri::command]
#[specta::specta]
pub async fn properties_get(
    app: AppHandle<Wry>,
    entity_id: String,
) -> Result<Vec<PropertyValueView>, CommandError> {
    blocking("properties_get", move || {
        service(&app)?
            .properties(&open_vault(&app)?, &entity_id)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `properties:set`: `properties` is the panel's whole record and `base` the record it was
/// shown; only the user's changes between the two are written.
#[tauri::command]
#[specta::specta]
pub async fn properties_set(
    app: AppHandle<Wry>,
    entity_id: String,
    properties: Map<String, Value>,
    base: Map<String, Value>,
) -> Result<SetPropertiesView, CommandError> {
    blocking("properties_set", move || {
        service(&app)?
            .set_properties(&open_vault(&app)?, &entity_id, properties, base)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `properties:merge`: the given keys set, a `null` one removed, the rest left.
#[tauri::command]
#[specta::specta]
pub async fn properties_merge(
    app: AppHandle<Wry>,
    entity_id: String,
    values: Map<String, Value>,
) -> Result<SetPropertiesView, CommandError> {
    blocking("properties_merge", move || {
        service(&app)?
            .merge_properties(&open_vault(&app)?, &entity_id, values)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `properties:rename`, on this note only.
#[tauri::command]
#[specta::specta]
pub async fn properties_rename(
    app: AppHandle<Wry>,
    entity_id: String,
    old_name: String,
    new_name: String,
) -> Result<(), CommandError> {
    blocking("properties_rename", move || {
        service(&app)?
            .rename_property(&open_vault(&app)?, &entity_id, old_name, new_name)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}
