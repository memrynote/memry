use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub title: String,
    pub content: Option<String>,
    pub created_at: String,
    pub modified_at: String,
    pub filed_at: Option<String>,
    pub filed_to: Option<String>,
    pub filed_action: Option<String>,
    pub snoozed_until: Option<String>,
    pub snooze_reason: Option<String>,
    pub viewed_at: Option<String>,
    pub processing_status: Option<String>,
    pub processing_error: Option<String>,
    pub metadata: Option<String>,
    pub attachment_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub transcription: Option<String>,
    pub transcription_status: Option<String>,
    pub source_url: Option<String>,
    pub source_title: Option<String>,
    pub archived_at: Option<String>,
    pub clock: Option<String>,
    pub synced_at: Option<String>,
    pub local_only: Option<bool>,
    pub capture_source: Option<String>,
}

impl InboxItem {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            r#type: row.get("type")?,
            title: row.get("title")?,
            content: row.get("content")?,
            created_at: row.get("created_at")?,
            modified_at: row.get("modified_at")?,
            filed_at: row.get("filed_at")?,
            filed_to: row.get("filed_to")?,
            filed_action: row.get("filed_action")?,
            snoozed_until: row.get("snoozed_until")?,
            snooze_reason: row.get("snooze_reason")?,
            viewed_at: row.get("viewed_at")?,
            processing_status: row.get("processing_status")?,
            processing_error: row.get("processing_error")?,
            metadata: row.get("metadata")?,
            attachment_path: row.get("attachment_path")?,
            thumbnail_path: row.get("thumbnail_path")?,
            transcription: row.get("transcription")?,
            transcription_status: row.get("transcription_status")?,
            source_url: row.get("source_url")?,
            source_title: row.get("source_title")?,
            archived_at: row.get("archived_at")?,
            clock: row.get("clock")?,
            synced_at: row.get("synced_at")?,
            local_only: row.get::<_, Option<i64>>("local_only")?.map(|v| v != 0),
            capture_source: row.get("capture_source")?,
        })
    }
}
