//! The property definition commands of `ipc/notes-handlers.ts` (#3530 Step 13k): the
//! `notes:*-property-definition*`, `notes:*-option*` and calendar visibility channels, each one
//! call of `memry_desktop::notes::property_definitions`, and Settings' property usage
//! (`notes:get-property-usage`, `notes:list-notes-with-property`) of
//! `memry_desktop::notes::properties::usage`. No note file is written.

use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::properties::usage::{
    PropertyNoteUsageView, PropertyUsageView, notes_with_property, property_usage,
};
use memry_desktop::notes::property_definitions::{
    DefinitionInput, DefinitionsError, EnsuredType, OptionInput, PropertyDefinitionView,
    PropertyDefinitions, StatusCategoryKey,
};
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::{OpenVault, Session};
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};

fn open_vault(app: &AppHandle<Wry>) -> Result<OpenVault, CommandError> {
    app.state::<Session>().current().ok_or_else(|| {
        let locale = app.state::<Arc<LocaleService>>().get();
        CommandError::new(
            ErrorKind::Invalid,
            "no_vault_open",
            i18n::t(locale, "errors:ipc.noVaultOpen", &Args::new()),
        )
    })
}

/// The open vault's definitions, written under this device's identity.
fn definitions(app: &AppHandle<Wry>) -> Result<PropertyDefinitions, CommandError> {
    let open = open_vault(app)?;
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    PropertyDefinitions::open(&open, store).map_err(|error| CommandError::from_core(&error))
}

fn failed(error: &DefinitionsError) -> CommandError {
    CommandError::from_core(error)
}

/// Runs `work` on the open vault's definitions off the async runtime. The note index then
/// checks its property rows' types: an edit, or a pull a read took into the file, may have
/// changed a definition's type (`retypeIndexedProperties`).
async fn on_definitions<T: Send + 'static>(
    app: AppHandle<Wry>,
    command: &'static str,
    work: impl FnOnce(&PropertyDefinitions) -> Result<T, DefinitionsError> + Send + 'static,
) -> Result<T, CommandError> {
    blocking(command, move || {
        let done = work(&definitions(&app)?).map_err(|error| failed(&error));
        if let Some(index) = app.try_state::<Arc<NoteIndex>>() {
            index.retype();
        }
        done
    })
    .await
}

/// `notes:get-property-definitions`: by name.
#[tauri::command]
#[specta::specta]
pub async fn notes_get_property_definitions(
    app: AppHandle<Wry>,
) -> Result<Vec<PropertyDefinitionView>, CommandError> {
    on_definitions(app, "notes_get_property_definitions", |d| d.list()).await
}

/// `notes:create-property-definition`. `type` is required.
#[tauri::command]
#[specta::specta]
pub async fn notes_create_property_definition(
    app: AppHandle<Wry>,
    input: DefinitionInput,
) -> Result<Option<PropertyDefinitionView>, CommandError> {
    on_definitions(app, "notes_create_property_definition", |d| d.create(input)).await
}

/// `notes:update-property-definition`: `null` when there is no definition of the name.
#[tauri::command]
#[specta::specta]
pub async fn notes_update_property_definition(
    app: AppHandle<Wry>,
    input: DefinitionInput,
) -> Result<Option<PropertyDefinitionView>, CommandError> {
    on_definitions(app, "notes_update_property_definition", |d| d.update(input)).await
}

#[tauri::command]
#[specta::specta]
pub async fn notes_ensure_property_definition(
    app: AppHandle<Wry>,
    name: String,
    kind: EnsuredType,
) -> Result<(), CommandError> {
    on_definitions(app, "notes_ensure_property_definition", move |d| {
        d.ensure(&name, kind)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn notes_add_property_option(
    app: AppHandle<Wry>,
    property_name: String,
    option: OptionInput,
) -> Result<(), CommandError> {
    on_definitions(app, "notes_add_property_option", move |d| {
        d.add_option(&property_name, option)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn notes_add_status_option(
    app: AppHandle<Wry>,
    property_name: String,
    category_key: StatusCategoryKey,
    option: OptionInput,
) -> Result<(), CommandError> {
    on_definitions(app, "notes_add_status_option", move |d| {
        d.add_status_option(&property_name, category_key, option)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn notes_remove_property_option(
    app: AppHandle<Wry>,
    property_name: String,
    option_value: String,
) -> Result<(), CommandError> {
    on_definitions(app, "notes_remove_property_option", move |d| {
        d.remove_option(&property_name, &option_value)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn notes_rename_property_option(
    app: AppHandle<Wry>,
    property_name: String,
    old_value: String,
    new_value: String,
) -> Result<(), CommandError> {
    on_definitions(app, "notes_rename_property_option", move |d| {
        d.rename_option(&property_name, &old_value, &new_value)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn notes_update_option_color(
    app: AppHandle<Wry>,
    property_name: String,
    option_value: String,
    new_color: String,
) -> Result<(), CommandError> {
    on_definitions(app, "notes_update_option_color", move |d| {
        d.set_option_color(&property_name, &option_value, &new_color)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn notes_delete_property_definition(
    app: AppHandle<Wry>,
    name: String,
) -> Result<(), CommandError> {
    on_definitions(app, "notes_delete_property_definition", move |d| {
        d.delete(&name)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn notes_set_calendar_property_visibility(
    app: AppHandle<Wry>,
    name: String,
    show_on_calendar: bool,
) -> Result<(), CommandError> {
    on_definitions(app, "notes_set_calendar_property_visibility", move |d| {
        d.set_show_on_calendar(&name, show_on_calendar)
    })
    .await
}

/// `notes:get-property-usage`: every property the index holds, by name.
#[tauri::command]
#[specta::specta]
pub async fn notes_get_property_usage(
    app: AppHandle<Wry>,
) -> Result<Vec<PropertyUsageView>, CommandError> {
    blocking("notes_get_property_usage", move || {
        property_usage(&open_vault(&app)?).map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// `notes:list-notes-with-property`: the notes that use `name`, by title.
#[tauri::command]
#[specta::specta]
pub async fn notes_list_notes_with_property(
    app: AppHandle<Wry>,
    name: String,
) -> Result<Vec<PropertyNoteUsageView>, CommandError> {
    blocking("notes_list_notes_with_property", move || {
        notes_with_property(&open_vault(&app)?, &name)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn notes_get_calendar_property_names(
    app: AppHandle<Wry>,
) -> Result<Vec<String>, CommandError> {
    on_definitions(app, "notes_get_calendar_property_names", |d| {
        Ok(d.calendar_names())
    })
    .await
}
