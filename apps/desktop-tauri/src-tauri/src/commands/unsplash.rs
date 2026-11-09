//! The Unsplash Photos tab of the cover picker: `unsplash_search`, and
//! `notes_download_unsplash_photo`, which saves a picked photo as a note attachment through
//! `Unsplash::fetch_photo` and the attachment writer (#3531 14f-2b). Step 30 (#3547) calls the
//! same method for Home board covers.

use std::sync::Arc;

use memry_desktop::attachments;
use memry_desktop::config::RuntimeConfig;
use memry_desktop::notes::unsplash::{
    Credit, SearchRequest, Unsplash, UnsplashFailure, UnsplashPhoto,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};
use super::notes::open_vault;
use crate::startup::{self, Stage};

/// What a search came to. A failure reason is an answer the renderer branches on (it hides the
/// Photos tab on `notConfigured`), so it is a variant here and not a rejected call.
#[derive(Debug, Serialize, specta::Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UnsplashSearchResponse {
    #[serde(rename_all = "camelCase")]
    Photos {
        photos: Vec<UnsplashPhoto>,
        rate_limit_remaining: Option<i64>,
    },
    Unavailable {
        reason: UnsplashFailure,
    },
}

pub fn register_stages() {
    startup::register(Stage::Handlers, "manage unsplash", manage);
}

/// After telemetry has resolved the `RuntimeConfig` that holds the access key.
fn manage(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let key = app.state::<RuntimeConfig>().unsplash_access_key.clone();
    let unsplash = Unsplash::new(memry_desktop::http::builder(), key).map_err(|error| {
        CommandError::new(
            ErrorKind::Internal,
            "unsplash_client",
            format!("the Unsplash HTTP client could not be built: {error}"),
        )
    })?;
    app.manage(Arc::new(unsplash));
    Ok(())
}

/// Searches photos. An empty `query` is the capability probe: it answers from the key alone
/// without a request.
#[tauri::command]
#[specta::specta]
pub async fn unsplash_search(
    app: AppHandle<Wry>,
    query: String,
    page: Option<u32>,
) -> Result<UnsplashSearchResponse, CommandError> {
    let request = SearchRequest::parse(&query, page).map_err(|error| {
        let error = CommandError::new(
            ErrorKind::Invalid,
            "unsplash_invalid_search",
            error.to_string(),
        );
        log_failure("unsplash_search", &error);
        error
    })?;
    let unsplash = app.state::<Arc<Unsplash>>().inner().clone();
    Ok(match unsplash.search(&request).await {
        Ok(page) => UnsplashSearchResponse::Photos {
            photos: page.photos,
            rate_limit_remaining: page.rate_limit_remaining,
        },
        Err(reason) => UnsplashSearchResponse::Unavailable { reason },
    })
}

/// What a photo download came to: `UnsplashDownloadResult` without its `ok` flag.
#[derive(Debug, Serialize, specta::Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UnsplashDownloadResponse {
    Saved {
        // The note-relative ref, as an upload answers it.
        #[serde(rename = "ref")]
        reference: String,
        credit: Credit,
    },
    Unavailable {
        reason: UnsplashFailure,
    },
    // The photo came, the vault refused it.
    WriteFailed,
}

/// Saves a photo picked in the cover picker as an attachment of the note, and answers its ref
/// and the credit the licence asks for. A note the vault has no row for, a locked note or a
/// failed write saves nothing.
#[tauri::command]
#[specta::specta]
pub async fn notes_download_unsplash_photo(
    app: AppHandle<Wry>,
    note_id: String,
    photo: UnsplashPhoto,
) -> Result<UnsplashDownloadResponse, CommandError> {
    let unsplash = app.state::<Arc<Unsplash>>().inner().clone();
    let fetched = match unsplash.fetch_photo(&photo).await {
        Ok(fetched) => fetched,
        Err(reason) => return Ok(UnsplashDownloadResponse::Unavailable { reason }),
    };
    blocking("notes_download_unsplash_photo", move || {
        let open = open_vault(&app)?;
        Ok(
            match attachments::save_fetched(&open, &note_id, &fetched.filename, &fetched.bytes) {
                Ok(saved) => UnsplashDownloadResponse::Saved {
                    reference: saved.path,
                    credit: fetched.credit,
                },
                Err(error) => {
                    tracing::error!(
                        scope = "Unsplash",
                        "an Unsplash cover could not be written to the vault: {error}"
                    );
                    UnsplashDownloadResponse::WriteFailed
                }
            },
        )
    })
    .await
}
