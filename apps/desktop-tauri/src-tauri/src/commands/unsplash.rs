//! The Unsplash Photos tab of the cover picker (`unsplash_search`).
//!
//! The command that saves a picked photo as a note attachment belongs to Step 14 (#3531), which
//! owns the attachment writer and calls `Unsplash::fetch_photo` for the bytes. Step 30 (#3547)
//! calls the same method for Home board covers.

use std::sync::Arc;

use memry_desktop::config::RuntimeConfig;
use memry_desktop::notes::unsplash::{SearchRequest, Unsplash, UnsplashFailure, UnsplashPhoto};
use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};

use super::error::{CommandError, ErrorKind, log_failure};
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
