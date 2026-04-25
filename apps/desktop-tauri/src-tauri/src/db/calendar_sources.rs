use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSource {
    pub id: String,
    pub provider: String,
    pub kind: String,
    pub account_id: Option<String>,
    pub remote_id: String,
    pub title: String,
    pub timezone: Option<String>,
    pub color: Option<String>,
    pub is_primary: bool,
    pub is_selected: bool,
    pub is_memry_managed: bool,
    pub sync_cursor: Option<String>,
    pub sync_status: String,
    pub last_synced_at: Option<String>,
    pub metadata: Option<String>,
    pub archived_at: Option<String>,
    pub clock: Option<String>,
    pub synced_at: Option<String>,
    pub created_at: String,
    pub modified_at: String,
    pub last_error: Option<String>,
}

impl CalendarSource {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            provider: row.get("provider")?,
            kind: row.get("kind")?,
            account_id: row.get("account_id")?,
            remote_id: row.get("remote_id")?,
            title: row.get("title")?,
            timezone: row.get("timezone")?,
            color: row.get("color")?,
            is_primary: row.get::<_, i64>("is_primary")? != 0,
            is_selected: row.get::<_, i64>("is_selected")? != 0,
            is_memry_managed: row.get::<_, i64>("is_memry_managed")? != 0,
            sync_cursor: row.get("sync_cursor")?,
            sync_status: row.get("sync_status")?,
            last_synced_at: row.get("last_synced_at")?,
            metadata: row.get("metadata")?,
            archived_at: row.get("archived_at")?,
            clock: row.get("clock")?,
            synced_at: row.get("synced_at")?,
            created_at: row.get("created_at")?,
            modified_at: row.get("modified_at")?,
            last_error: row.get("last_error")?,
        })
    }
}
