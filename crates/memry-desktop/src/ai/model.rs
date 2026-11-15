//! The local text model's settings actions (Electron's `settings/ai-settings.ts`, Step 23,
//! #3540): `getAIModelStatus` (:124-135), `loadAIModel` (:137-154) and `reindexEmbeddings`
//! (:156-171, every note embedded again by the `embedding` lane).

use std::sync::Arc;

use serde::Serialize;

use crate::embedding::projector;
use crate::embedding::service::{EMBEDDING_DIMENSION, EmbeddingService, MODEL_NAME};
use crate::i18n::{self, Args};
use crate::session::Session;

/// With no service the app has no text model this run; status and reindex both say it failed.
const NO_MODEL: &str = "Failed to load embedding model";

/// `AIModelStatus`: the model's state and how many notes have a vector in the open vault.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiModelStatus {
    pub name: String,
    pub dimension: u32,
    pub loaded: bool,
    pub loading: bool,
    pub error: Option<String>,
    pub embedding_count: u32,
}

/// `loadAIModel`'s answer. `message` is English, as Electron's; `error` is translated, or the
/// model's own reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelLoadResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

/// `reindexEmbeddings`'s answer. `error` is the lane's English reason, as Electron answers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReindexResult {
    pub success: bool,
    pub computed: u32,
    pub skipped: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

fn failed(error: impl Into<String>) -> ReindexResult {
    ReindexResult {
        success: false,
        computed: 0,
        skipped: 0,
        error: Some(error.into()),
    }
}

/// The model's state, and the open vault's `vec_notes` rows (0 with no vault, or when the count
/// cannot be read, as Electron's).
pub fn status(session: &Session, model: Option<&Arc<EmbeddingService>>) -> AiModelStatus {
    let embedding_count = session.current().map_or(0, |vault| {
        vault.search.note_embedding_count().map_or_else(
            |error| {
                tracing::debug!(scope = "Embeddings", "embedding count unavailable: {error}");
                0
            },
            |count| u32::try_from(count).unwrap_or(u32::MAX),
        )
    });
    let (loaded, loading, error) = match model {
        Some(model) => {
            let status = model.status();
            (status.loaded, status.loading, status.error)
        }
        None => (false, false, Some(NO_MODEL.to_owned())),
    };
    AiModelStatus {
        name: MODEL_NAME.to_owned(),
        dimension: u32::try_from(EMBEDDING_DIMENSION).unwrap_or(u32::MAX),
        loaded,
        loading,
        error,
        embedding_count,
    }
}

/// Loads the model now, past a load back-off, and waits for it (the download included).
pub fn load(model: Option<&Arc<EmbeddingService>>, locale: &str) -> ModelLoadResult {
    let refused =
        |error: Option<String>| ModelLoadResult {
            success: false,
            message: None,
            error: Some(error.unwrap_or_else(|| {
                i18n::t(locale, "errors:settings.modelLoadFailed", &Args::new())
            })),
        };
    let Some(model) = model else {
        return refused(None);
    };
    let status = model.status();
    if status.loaded {
        return ModelLoadResult {
            success: true,
            message: Some("Model already loaded".to_owned()),
            error: None,
        };
    }
    if status.loading {
        return refused(Some(i18n::t(
            locale,
            "errors:settings.modelAlreadyLoading",
            &Args::new(),
        )));
    }
    model.reset_failure();
    if model.load() {
        return ModelLoadResult {
            success: true,
            message: None,
            error: None,
        };
    }
    refused(model.status().error)
}

/// Clears the model's load failure, then runs the `embedding` lane's rebuild and waits for it.
/// The vault and its runtime are read in one step, and the counts are the rebuild's own. With
/// no lane (the app has no text model) the load failed.
pub fn reindex(session: &Session, model: Option<&Arc<EmbeddingService>>) -> ReindexResult {
    if let Some(model) = model {
        model.reset_failure();
    }
    let Some(runtime) = session.projections() else {
        return failed("No vault is open");
    };
    match runtime.rebuild_named(projector::NAME) {
        None => failed(NO_MODEL),
        Some(Err(error)) => failed(error),
        Some(Ok(rebuilt)) => ReindexResult {
            success: true,
            computed: rebuilt.computed,
            skipped: rebuilt.skipped,
            error: None,
        },
    }
}
