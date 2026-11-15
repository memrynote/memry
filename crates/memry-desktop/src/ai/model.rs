//! The local text model's settings actions (Electron's `settings/ai-settings.ts`, Step 23,
//! #3540). `reindexEmbeddings` (:156-171): every note embedded again by the `embedding` lane.

use std::sync::Arc;

use serde::Serialize;

use crate::embedding::projector;
use crate::embedding::service::EmbeddingService;
use crate::session::Session;

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

/// Clears the model's load failure, then runs the `embedding` lane's rebuild and waits for it.
/// A rebuild succeeds only once every note it listed is embedded, so `computed` is the notes
/// listed and `skipped` is 0. With no lane (the app has no text model) the load failed.
pub fn reindex(session: &Session, model: Option<&Arc<EmbeddingService>>) -> ReindexResult {
    if let Some(model) = model {
        model.reset_failure();
    }
    let Some(vault) = session.current() else {
        return failed("No vault is open");
    };
    let listed = vault
        .search
        .embeddable_notes()
        .map(|notes| u32::try_from(notes.len()).unwrap_or(u32::MAX));
    let rebuilt = session
        .projections()
        .and_then(|runtime| runtime.rebuild_named(projector::NAME));
    match (rebuilt, listed) {
        (None, _) => failed("Failed to load embedding model"),
        (Some(Err(error)), _) => failed(error),
        (Some(Ok(())), Ok(computed)) => ReindexResult {
            success: true,
            computed,
            skipped: 0,
            error: None,
        },
        (Some(Ok(())), Err(error)) => {
            tracing::warn!(scope = "Embeddings", "reindexed, notes uncounted: {error}");
            ReindexResult {
                success: true,
                computed: 0,
                skipped: 0,
                error: None,
            }
        }
    }
}
