//! The tag list, a tag's notes and the tag hub's edits (`tags:*` of `ipc/tags-handlers.ts`),
//! each one call of `memry_desktop::tags`. None of them writes a note file. After a write they
//! send what Electron's handler sends: [`TagColorUpdatedEvent`] and [`NoteTagsChangedEvent`]
//! for a colour, [`NoteTagsChangedEvent`] for an icon, [`TagCategoriesChangedEvent`] for a
//! category or a drag.

use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::{OpenVault, Session};
use memry_desktop::tags::view::{
    NotesByTagInput, NotesByTagView, ReorderInput, TagCategoryView, TagWithCountView,
};
use memry_desktop::tags::{self, Hub};
use memry_desktop::telemetry::Service;
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use crate::events::{
    NoteTagsChangedEvent, TagCategoriesChangedEvent, TagColorUpdatedEvent, broadcast,
};
use crate::shell::services;

/// The open vault, or the localized "no vault is open".
fn open_vault<R: Runtime>(app: &AppHandle<R>) -> Result<OpenVault, CommandError> {
    app.state::<Session>().current().ok_or_else(|| {
        let locale = app.state::<Arc<LocaleService>>().get();
        CommandError::new(
            ErrorKind::Invalid,
            "no_vault_open",
            i18n::t(locale, "errors:ipc.noVaultOpen", &Args::new()),
        )
    })
}

/// A category name that is blank once trimmed, refused with Electron's localized message
/// before it reaches the hub (which refuses it too).
fn category_name<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<(), CommandError> {
    if !name.trim().is_empty() {
        return Ok(());
    }
    let locale = app.state::<Arc<LocaleService>>().get();
    Err(CommandError::new(
        ErrorKind::Invalid,
        "invalid",
        i18n::t(locale, "errors:tag.categoryNameRequired", &Args::new()),
    ))
}

/// The open vault's tag hub, written under this device's identity.
fn hub<R: Runtime>(app: &AppHandle<R>) -> Result<Hub, CommandError> {
    let open = open_vault(app)?;
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    Hub::open(&open, store).map_err(|error| CommandError::from_core(&error))
}

#[tauri::command]
#[specta::specta]
pub async fn tags_get_all_with_counts(
    app: AppHandle<Wry>,
) -> Result<Vec<TagWithCountView>, CommandError> {
    blocking("tags_get_all_with_counts", move || {
        tags::all_with_counts(&open_vault(&app)?).map_err(|error| CommandError::from_core(&error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tags_get_notes_by_tag(
    app: AppHandle<Wry>,
    input: NotesByTagInput,
) -> Result<NotesByTagView, CommandError> {
    blocking("tags_get_notes_by_tag", move || {
        tags::notes_by_tag(&open_vault(&app)?, &input)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tags_update_color(
    app: AppHandle<Wry>,
    tag: String,
    color: String,
) -> Result<(), CommandError> {
    blocking("tags_update_color", move || {
        hub(&app)?
            .set_color(&tag, &color)
            .map_err(|error| CommandError::from_core(&error))?;
        broadcast(&app, TagColorUpdatedEvent { tag, color });
        broadcast(&app, NoteTagsChangedEvent);
        Ok(())
    })
    .await
}

/// `icon` is an emoji or `icon:Name`; `None` clears it.
#[tauri::command]
#[specta::specta]
pub async fn tags_update_icon(
    app: AppHandle<Wry>,
    tag: String,
    icon: Option<String>,
) -> Result<(), CommandError> {
    blocking("tags_update_icon", move || {
        hub(&app)?
            .set_icon(&tag, icon.as_deref())
            .map_err(|error| CommandError::from_core(&error))?;
        broadcast(&app, NoteTagsChangedEvent);
        Ok(())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tags_list_categories(
    app: AppHandle<Wry>,
) -> Result<Vec<TagCategoryView>, CommandError> {
    blocking("tags_list_categories", move || {
        tags::categories(&open_vault(&app)?).map_err(|error| CommandError::from_core(&error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tags_create_category(
    app: AppHandle<Wry>,
    name: String,
) -> Result<TagCategoryView, CommandError> {
    blocking("tags_create_category", move || {
        category_name(&app, &name)?;
        let category = hub(&app)?
            .create_category(&name)
            .map_err(|error| CommandError::from_core(&error))?;
        broadcast(
            &app,
            TagCategoriesChangedEvent {
                category_id: Some(category.id.clone()),
            },
        );
        if let Some(telemetry) = services::telemetry(&app) {
            let mut event = Service::event("tag_category_created", "tags", "created");
            event.object_type = Some("tag_category".to_owned());
            event.result = Some("success".to_owned());
            telemetry.track_main_event(event);
        }
        Ok(category)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tags_rename_category(
    app: AppHandle<Wry>,
    id: String,
    name: String,
) -> Result<(), CommandError> {
    blocking("tags_rename_category", move || {
        category_name(&app, &name)?;
        hub(&app)?
            .rename_category(&id, &name)
            .map_err(|error| CommandError::from_core(&error))?;
        broadcast(
            &app,
            TagCategoriesChangedEvent {
                category_id: Some(id),
            },
        );
        Ok(())
    })
    .await
}

/// The category's tags become uncategorised.
#[tauri::command]
#[specta::specta]
pub async fn tags_delete_category(app: AppHandle<Wry>, id: String) -> Result<(), CommandError> {
    blocking("tags_delete_category", move || {
        hub(&app)?
            .delete_category(&id)
            .map_err(|error| CommandError::from_core(&error))?;
        broadcast(
            &app,
            TagCategoriesChangedEvent {
                category_id: Some(id),
            },
        );
        Ok(())
    })
    .await
}

/// A drag in the tag hub: tag assignments and category order, all or nothing.
#[tauri::command]
#[specta::specta]
pub async fn tags_reorder(app: AppHandle<Wry>, input: ReorderInput) -> Result<(), CommandError> {
    blocking("tags_reorder", move || {
        hub(&app)?
            .reorder(&input)
            .map_err(|error| CommandError::from_core(&error))?;
        broadcast(&app, TagCategoriesChangedEvent { category_id: None });
        Ok(())
    })
    .await
}
