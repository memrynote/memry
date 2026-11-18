//! The Inbox job runner's events (`inbox:updated`, `inbox:metadata-complete` and
//! `inbox:processing-error` of `jobs.ts`), from `memry_desktop::services::inbox_jobs`.

use memry_desktop::services::inbox_jobs::ItemChanges;
use serde::Serialize;

/// The capture fields a job wrote (`Partial<InboxItem>`). A field the job did not write is
/// absent; Electron sent `processingError: null` and `thumbnailPath: null` on a success.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InboxItemChanges {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub processing_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub processing_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub thumbnail_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub content: Option<String>,
}

impl From<ItemChanges> for InboxItemChanges {
    fn from(changes: ItemChanges) -> Self {
        Self {
            processing_status: changes.processing_status,
            processing_error: changes.processing_error,
            thumbnail_path: changes.thumbnail_path,
            content: changes.content,
        }
    }
}

/// `InboxUpdatedEvent`: a job wrote these fields of capture `id`.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct InboxUpdatedEvent {
    pub id: String,
    pub changes: InboxItemChanges,
}

/// The link preview `inbox:metadata-complete` carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InboxLinkPreview {
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub thumbnail_path: Option<String>,
}

/// `InboxMetadataCompleteEvent`: the link preview of capture `id` is stored.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct InboxMetadataCompleteEvent {
    pub id: String,
    pub metadata: InboxLinkPreview,
}

/// `InboxProcessingErrorEvent`: a job's last attempt failed. `operation` is one of
/// `transcription`, `metadata`, `pdf` and `ocr`; the runner sends `metadata`.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct InboxProcessingErrorEvent {
    pub id: String,
    pub operation: String,
    pub error: String,
}
