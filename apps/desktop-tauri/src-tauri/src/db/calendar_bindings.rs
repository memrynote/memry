use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarBinding {
    pub id: String,
    pub source_type: String,
    pub source_id: String,
    pub provider: String,
    pub remote_calendar_id: String,
    pub remote_event_id: String,
    pub ownership_mode: String,
    pub writeback_mode: String,
    pub remote_version: Option<String>,
    pub last_local_snapshot: Option<String>,
    pub archived_at: Option<String>,
    pub clock: Option<String>,
    pub synced_at: Option<String>,
    pub created_at: String,
    pub modified_at: String,
}

impl CalendarBinding {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            source_type: row.get("source_type")?,
            source_id: row.get("source_id")?,
            provider: row.get("provider")?,
            remote_calendar_id: row.get("remote_calendar_id")?,
            remote_event_id: row.get("remote_event_id")?,
            ownership_mode: row.get("ownership_mode")?,
            writeback_mode: row.get("writeback_mode")?,
            remote_version: row.get("remote_version")?,
            last_local_snapshot: row.get("last_local_snapshot")?,
            archived_at: row.get("archived_at")?,
            clock: row.get("clock")?,
            synced_at: row.get("synced_at")?,
            created_at: row.get("created_at")?,
            modified_at: row.get("modified_at")?,
        })
    }
}
