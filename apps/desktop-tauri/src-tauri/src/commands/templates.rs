//! The template commands (`templates:*` of `ipc/templates-handlers.ts`), each one call of
//! `memry_desktop::templates`. Every write announces its template event after it committed; the
//! renderer refetches the list.

use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::Session;
use memry_desktop::templates::{
    TemplateCreateInput, TemplateListItem, TemplateUpdateInput, TemplateView, Templates,
};
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use crate::events::{TemplateCreatedEvent, TemplateDeletedEvent, TemplateUpdatedEvent, broadcast};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// The open vault's templates, written under this device's identity; the localized "no vault
/// is open" when there is none.
fn templates<R: Runtime>(app: &AppHandle<R>) -> Result<Templates, CommandError> {
    let open = app.state::<Session>().current().ok_or_else(|| {
        let locale = app.state::<Arc<LocaleService>>().get();
        CommandError::new(
            ErrorKind::Invalid,
            "no_vault_open",
            i18n::t(locale, "errors:ipc.noVaultOpen", &Args::new()),
        )
    })?;
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    Templates::open(&open, store).map_err(|error| CommandError::from_core(&error))
}

/// Built-ins by name, then the vault's own by name.
#[tauri::command]
#[specta::specta]
pub async fn templates_list(app: AppHandle<Wry>) -> Result<Vec<TemplateListItem>, CommandError> {
    blocking("templates_list", move || {
        templates(&app)?
            .list()
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// A built-in or a template of the vault; `null` for any other id.
#[tauri::command]
#[specta::specta]
pub async fn templates_get(
    app: AppHandle<Wry>,
    id: String,
) -> Result<Option<TemplateView>, CommandError> {
    blocking("templates_get", move || {
        templates(&app)?
            .get(&id)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn templates_create(
    app: AppHandle<Wry>,
    input: TemplateCreateInput,
) -> Result<TemplateView, CommandError> {
    let template = blocking("templates_create", {
        let app = app.clone();
        move || {
            templates(&app)?
                .create(&input, now_ms())
                .map_err(|error| CommandError::from_core(&error))
        }
    })
    .await?;
    let id = template.id.clone();
    broadcast(&app, TemplateCreatedEvent { id });
    Ok(template)
}

/// Saves the fields `input` names; a built-in is refused.
#[tauri::command]
#[specta::specta]
pub async fn templates_update(
    app: AppHandle<Wry>,
    input: TemplateUpdateInput,
) -> Result<TemplateView, CommandError> {
    let template = blocking("templates_update", {
        let app = app.clone();
        move || {
            templates(&app)?
                .update(&input, now_ms())
                .map_err(|error| CommandError::from_core(&error))
        }
    })
    .await?;
    let id = template.id.clone();
    broadcast(&app, TemplateUpdatedEvent { id });
    Ok(template)
}

/// Copies a built-in or a template of the vault into a new template named `new_name`.
#[tauri::command]
#[specta::specta]
pub async fn templates_duplicate(
    app: AppHandle<Wry>,
    id: String,
    new_name: String,
) -> Result<TemplateView, CommandError> {
    let template = blocking("templates_duplicate", {
        let app = app.clone();
        move || {
            templates(&app)?
                .duplicate(&id, &new_name, now_ms())
                .map_err(|error| CommandError::from_core(&error))
        }
    })
    .await?;
    let id = template.id.clone();
    broadcast(&app, TemplateCreatedEvent { id });
    Ok(template)
}

/// Deletes a template of the vault and its pre-sync file; a built-in is refused.
#[tauri::command]
#[specta::specta]
pub async fn templates_delete(app: AppHandle<Wry>, id: String) -> Result<(), CommandError> {
    blocking("templates_delete", {
        let (app, id) = (app.clone(), id.clone());
        move || {
            templates(&app)?
                .delete(&id, now_ms())
                .map_err(|error| CommandError::from_core(&error))
        }
    })
    .await?;
    broadcast(&app, TemplateDeletedEvent { id });
    Ok(())
}
