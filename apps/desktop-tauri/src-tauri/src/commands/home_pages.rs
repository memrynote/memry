//! The Home board commands (`home-pages:*` of `ipc/home-page-handlers.ts`), each one call of
//! `memry_desktop::home`. Every write announces the boards it changed after it committed:
//! [`HomePageCreatedEvent`], [`HomePageUpdatedEvent`] per board, [`HomePageDeletedEvent`].
//!
//! A cover picked from a link or from Unsplash is fetched here, before the blocking write, by the
//! clients the note cover picker uses (`RemoteImages`, `Unsplash`). An uploaded image arrives as
//! a raw request body (`home_pages_set_cover_upload`, a binary command).

use std::sync::Arc;

use memry_desktop::attachments::{MAX_FILE_SIZE, RemoteImages};
use memry_desktop::error::CoreError;
use memry_desktop::home::covers::{CoverFailure, CoverImage, SetCoverOutcome};
use memry_desktop::home::{
    CoverFramingInput, HomeBoards, HomePageCreateInput, HomePageUpdateInput, HomePageView,
};
use memry_desktop::notes::unsplash::{Unsplash, UnsplashPhoto};
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use serde::Deserialize;
use tauri::ipc::Request;
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::notes::open_vault;
use crate::binary;
use crate::events::{HomePageCreatedEvent, HomePageDeletedEvent, HomePageUpdatedEvent, broadcast};

/// `HomePageCoverSource` less `upload`, which is the binary command.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HomePageCoverSourceInput {
    Wash {
        id: String,
    },
    Url {
        url: String,
    },
    Unsplash {
        photo: UnsplashPhoto,
    },
    #[serde(rename_all = "camelCase")]
    VaultFile {
        owner_note_id: String,
        filename: String,
    },
}

/// The metadata header of `home_pages_set_cover_upload`.
#[derive(Debug, Deserialize)]
struct UploadMeta {
    id: String,
    filename: String,
}

fn boards<R: Runtime>(app: &AppHandle<R>) -> Result<HomeBoards, CommandError> {
    let open = open_vault(app)?;
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    HomeBoards::open(&open, store).map_err(|error| CommandError::from_core(&error))
}

fn updated<R: Runtime>(app: &AppHandle<R>, id: String) {
    broadcast(app, HomePageUpdatedEvent { id });
}

fn core<T, E: CoreError>(result: Result<T, E>) -> Result<T, CommandError> {
    result.map_err(|error| CommandError::from_core(&error))
}

fn missing(what: &'static str) -> CommandError {
    CommandError::new(ErrorKind::Internal, "home_cover_client_missing", what)
}

/// Every live board in the order every device agrees on.
#[tauri::command]
#[specta::specta]
pub async fn home_pages_list<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<HomePageView>, CommandError> {
    blocking("home_pages_list", move || core(boards(&app)?.list())).await
}

#[tauri::command]
#[specta::specta]
pub async fn home_pages_get<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<Option<HomePageView>, CommandError> {
    blocking("home_pages_get", move || core(boards(&app)?.get(id))).await
}

#[tauri::command]
#[specta::specta]
pub async fn home_pages_create<R: Runtime>(
    app: AppHandle<R>,
    input: HomePageCreateInput,
) -> Result<HomePageView, CommandError> {
    blocking("home_pages_create", move || {
        let page = core(boards(&app)?.create(input))?;
        broadcast(
            &app,
            HomePageCreatedEvent {
                id: page.id.clone(),
            },
        );
        Ok(page)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn home_pages_update<R: Runtime>(
    app: AppHandle<R>,
    input: HomePageUpdateInput,
) -> Result<HomePageView, CommandError> {
    blocking("home_pages_update", move || {
        let page = core(boards(&app)?.update(input))?;
        updated(&app, page.id.clone());
        Ok(page)
    })
    .await
}

/// `false` when there was no such board.
#[tauri::command]
#[specta::specta]
pub async fn home_pages_delete<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<bool, CommandError> {
    blocking("home_pages_delete", move || {
        let deleted = core(boards(&app)?.delete(id.clone()))?;
        if deleted {
            broadcast(&app, HomePageDeletedEvent { id });
        }
        Ok(deleted)
    })
    .await
}

/// Puts the boards in the order of `ids`.
#[tauri::command]
#[specta::specta]
pub async fn home_pages_reorder<R: Runtime>(
    app: AppHandle<R>,
    ids: Vec<String>,
) -> Result<(), CommandError> {
    blocking("home_pages_reorder", move || {
        for id in core(boards(&app)?.reorder(ids))? {
            updated(&app, id);
        }
        Ok(())
    })
    .await
}

fn announce<R: Runtime>(app: &AppHandle<R>, outcome: SetCoverOutcome) -> SetCoverOutcome {
    if let SetCoverOutcome::Saved { page } = &outcome {
        updated(app, page.id.clone());
    }
    outcome
}

async fn set_image<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    image: Result<CoverImage, CoverFailure>,
) -> Result<SetCoverOutcome, CommandError> {
    blocking("home_pages_set_cover", move || {
        let boards = boards(&app)?;
        let outcome = match image {
            Ok(image) => core(boards.set_image(&id, image))?,
            Err(reason) => SetCoverOutcome::Failed { reason },
        };
        Ok(announce(&app, outcome))
    })
    .await
}

/// A board's new banner from a wash, a link, Unsplash or an image already in the vault. Every
/// image is copied into the board's own folder and the board saved in the same call.
#[tauri::command]
#[specta::specta]
pub async fn home_pages_set_cover<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    source: HomePageCoverSourceInput,
) -> Result<SetCoverOutcome, CommandError> {
    // A board that is gone fails before anything is fetched.
    let checked = id.clone();
    blocking("home_pages_set_cover", {
        let app = app.clone();
        move || core(boards(&app)?.require(&checked))
    })
    .await?;
    let image = match source {
        HomePageCoverSourceInput::Wash { id: wash } => {
            return blocking("home_pages_set_cover", move || {
                let outcome = core(boards(&app)?.set_wash(&id, &wash))?;
                Ok(announce(&app, outcome))
            })
            .await;
        }
        HomePageCoverSourceInput::Url { url } => {
            let remote = app
                .try_state::<Arc<RemoteImages>>()
                .map(|remote| Arc::clone(&remote))
                .ok_or_else(|| missing("no remote image client"))?;
            remote
                .fetch(&url)
                .await
                .map(|fetched| CoverImage {
                    filename: fetched.filename,
                    bytes: fetched.bytes,
                    credit: None,
                })
                .map_err(CoverFailure::from)
        }
        HomePageCoverSourceInput::Unsplash { photo } => {
            let unsplash = app
                .try_state::<Arc<Unsplash>>()
                .map(|unsplash| Arc::clone(&unsplash))
                .ok_or_else(|| missing("no Unsplash client"))?;
            unsplash
                .fetch_photo(&photo)
                .await
                .map(|fetched| CoverImage {
                    filename: fetched.filename,
                    bytes: fetched.bytes,
                    credit: Some((fetched.credit.name, fetched.credit.url)),
                })
                .map_err(CoverFailure::from)
        }
        HomePageCoverSourceInput::VaultFile {
            owner_note_id,
            filename,
        } => {
            let app = app.clone();
            blocking("home_pages_set_cover", move || {
                Ok(boards(&app)?.read_vault_image(&owner_note_id, &filename))
            })
            .await?
        }
    };
    set_image(app, id, image).await
}

/// The `upload` source: the image in the raw request body (`invokeBinary`, meta
/// `{ id, filename }`). Listed in `binary::COMMANDS`; not a specta command.
#[tauri::command]
pub async fn home_pages_set_cover_upload<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> Result<SetCoverOutcome, CommandError> {
    let meta: UploadMeta = binary::meta(&request)?;
    let body = binary::raw_body(&request)?;
    // Refused before the body is copied.
    if body.len() > MAX_FILE_SIZE {
        return Ok(SetCoverOutcome::Failed {
            reason: CoverFailure::TooLarge,
        });
    }
    let image = CoverImage {
        filename: meta.filename,
        bytes: body.to_vec(),
        credit: None,
    };
    set_image(app, meta.id, Ok(image)).await
}

/// Saves how the cover sits in its band; only the fields that changed are sent.
#[tauri::command]
#[specta::specta]
pub async fn home_pages_set_cover_framing<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    changes: CoverFramingInput,
) -> Result<HomePageView, CommandError> {
    blocking("home_pages_set_cover_framing", move || {
        let page = core(boards(&app)?.set_cover_framing(id, changes))?;
        updated(&app, page.id.clone());
        Ok(page)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn home_pages_remove_cover<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<HomePageView, CommandError> {
    blocking("home_pages_remove_cover", move || {
        let page = core(boards(&app)?.remove_cover(&id))?;
        updated(&app, page.id.clone());
        Ok(page)
    })
    .await
}

/// Brings the board's cover files in line with its cover. Until Step 30f syncs cover bytes,
/// this only prunes files the cover no longer names.
#[tauri::command]
#[specta::specta]
pub async fn home_pages_materialize_cover<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<(), CommandError> {
    blocking("home_pages_materialize_cover", move || {
        core(boards(&app)?.reconcile(Some(&id)))
    })
    .await
}
