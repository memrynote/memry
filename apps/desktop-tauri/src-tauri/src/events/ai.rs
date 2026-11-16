//! The AI events: the inline settings, and the local text model's progress.

use memry_desktop::ai::settings::InlineAiSettings;
use memry_desktop::embedding::projector::{EmbeddingProgress, Pass};
use memry_desktop::embedding::service::{ModelProgress, Phase};
use serde::Serialize;

/// The inline AI settings were written (replaces Electron's `ai-inline:server-ready` as the
/// settings refresh). The key is masked.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct AiInlineSettingsChangedEvent {
    pub settings: InlineAiSettings,
}

/// `EmbeddingProgressEvent.phase`: the model's download and load, then a note embedding pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AiEmbeddingPhase {
    Downloading,
    Loading,
    Ready,
    Error,
    Embedding,
    Complete,
}

/// The local text model's progress (`settings:embeddingProgress`). A model event carries
/// `progress` (0 to 100) and `status`; a note embedding pass carries `current` of `total` notes.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct AiEmbeddingProgressEvent {
    pub phase: AiEmbeddingPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub current: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub total: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub progress: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub status: Option<String>,
}

impl From<ModelProgress> for AiEmbeddingProgressEvent {
    fn from(event: ModelProgress) -> Self {
        Self {
            phase: match event.phase {
                Phase::Downloading => AiEmbeddingPhase::Downloading,
                Phase::Loading => AiEmbeddingPhase::Loading,
                Phase::Ready => AiEmbeddingPhase::Ready,
                Phase::Error => AiEmbeddingPhase::Error,
            },
            current: None,
            total: None,
            progress: Some(event.progress),
            status: Some(event.status),
        }
    }
}

impl From<EmbeddingProgress> for AiEmbeddingProgressEvent {
    fn from(event: EmbeddingProgress) -> Self {
        let count = |n: usize| Some(u32::try_from(n).unwrap_or(u32::MAX));
        Self {
            phase: match event.phase {
                Pass::Embedding => AiEmbeddingPhase::Embedding,
                Pass::Complete => AiEmbeddingPhase::Complete,
            },
            current: count(event.current),
            total: count(event.total),
            progress: None,
            status: None,
        }
    }
}
