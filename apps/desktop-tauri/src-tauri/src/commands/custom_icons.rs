//! The custom icon library (`custom-icons:*` of `ipc/custom-icon-handlers.ts`), through
//! `memry_desktop::notes::icons`. `custom_icons_add` takes the file's bytes as the raw request
//! body with `{ name, ext }` in the metadata header, so it is a binary command (`binary.rs`).
//! Every write announces [`CustomIconsUpdatedEvent`]; the renderer refetches the list.

use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::icons::{self, CustomIconError, CustomIconView, Library};
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::{OpenVault, Session};
use serde::Deserialize;
use tauri::ipc::Request;
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};
use crate::binary;
use crate::events::{CustomIconsUpdatedEvent, broadcast};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn localized<R: Runtime>(
    app: &AppHandle<R>,
    kind: ErrorKind,
    code: &str,
    key: &str,
) -> CommandError {
    let locale = app.state::<Arc<LocaleService>>().get();
    CommandError::new(kind, code, i18n::t(locale, key, &Args::new()))
}

/// The open vault, or the localized "no vault is open".
fn open_vault<R: Runtime>(app: &AppHandle<R>) -> Result<OpenVault, CommandError> {
    app.state::<Session>().current().ok_or_else(|| {
        localized(
            app,
            ErrorKind::Invalid,
            "no_vault_open",
            "errors:ipc.noVaultOpen",
        )
    })
}

/// The open vault's icon library, written under this device's identity.
fn library<R: Runtime>(app: &AppHandle<R>) -> Result<Library, CommandError> {
    let open = open_vault(app)?;
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    Library::open(&open, store).map_err(|error| CommandError::from_core(&error))
}

fn add_error<R: Runtime>(app: &AppHandle<R>, error: CustomIconError) -> CommandError {
    match (&error, error.message_key()) {
        (CustomIconError::Storage(storage), _) => CommandError::from_core(storage),
        (_, Some(key)) => localized(app, ErrorKind::Invalid, "custom_icon_refused", key),
        (_, None) => {
            CommandError::new(ErrorKind::Internal, "custom_icon_failed", error.to_string())
        }
    }
}

/// Every icon, oldest first. Writes the file of an icon that has none.
#[tauri::command]
#[specta::specta]
pub async fn custom_icons_list(app: AppHandle<Wry>) -> Result<Vec<CustomIconView>, CommandError> {
    blocking("custom_icons_list", move || {
        library(&app)?
            .list()
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

#[derive(Deserialize)]
struct AddMeta {
    name: String,
    ext: String,
}

/// Adds the image in the raw request body (`invokeBinary`, meta `{ name, ext }`). Listed in
/// `binary::COMMANDS`; not a specta command.
#[tauri::command]
pub async fn custom_icons_add<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> Result<CustomIconView, CommandError> {
    let meta: AddMeta = binary::meta(&request)?;
    let body = binary::raw_body(&request)?;
    // Refused before the body is copied.
    if body.is_empty() || body.len() > icons::MAX_INPUT_BYTES {
        let error = add_error(&app, CustomIconError::TooLarge);
        log_failure("custom_icons_add", &error);
        return Err(error);
    }
    let body = body.to_vec();
    let icon = blocking("custom_icons_add", {
        let app = app.clone();
        move || {
            library(&app)?
                .add(&body, &meta.ext, &meta.name, now_ms())
                .map_err(|error| add_error(&app, error))
        }
    })
    .await?;
    broadcast(
        &app,
        CustomIconsUpdatedEvent {
            id: icon.id.clone(),
        },
    );
    Ok(icon)
}

/// Downloads the image behind `url` once and adds it like an upload, named `name` or after the
/// link.
#[tauri::command]
#[specta::specta]
pub async fn custom_icons_add_from_url(
    app: AppHandle<Wry>,
    url: String,
    name: Option<String>,
) -> Result<CustomIconView, CommandError> {
    // No download while no vault is open to keep the icon.
    open_vault(&app).inspect_err(|error| log_failure("custom_icons_add_from_url", error))?;
    let remote = icons::download(&memry_desktop::http::client(), &url)
        .await
        .map_err(|error| {
            let error = add_error(&app, error);
            log_failure("custom_icons_add_from_url", &error);
            error
        })?;
    let icon = blocking("custom_icons_add_from_url", {
        let app = app.clone();
        move || {
            let name = name.unwrap_or(remote.name);
            library(&app)?
                .add(&remote.bytes, remote.ext, &name, now_ms())
                .map_err(|error| add_error(&app, error))
        }
    })
    .await?;
    broadcast(
        &app,
        CustomIconsUpdatedEvent {
            id: icon.id.clone(),
        },
    );
    Ok(icon)
}

#[tauri::command]
#[specta::specta]
pub async fn custom_icons_rename(
    app: AppHandle<Wry>,
    id: String,
    name: String,
) -> Result<CustomIconView, CommandError> {
    let icon = blocking("custom_icons_rename", {
        let app = app.clone();
        move || {
            library(&app)?
                .rename(&id, &name, now_ms())
                .map_err(|error| CommandError::from_core(&error))
        }
    })
    .await?;
    broadcast(
        &app,
        CustomIconsUpdatedEvent {
            id: icon.id.clone(),
        },
    );
    Ok(icon)
}

/// Deletes an icon and its file. `false` when there was no such icon.
#[tauri::command]
#[specta::specta]
pub async fn custom_icons_delete(app: AppHandle<Wry>, id: String) -> Result<bool, CommandError> {
    let deleted = blocking("custom_icons_delete", {
        let (app, id) = (app.clone(), id.clone());
        move || {
            library(&app)?
                .delete(&id, now_ms())
                .map_err(|error| CommandError::from_core(&error))
        }
    })
    .await?;
    if deleted {
        broadcast(&app, CustomIconsUpdatedEvent { id });
    }
    Ok(deleted)
}
