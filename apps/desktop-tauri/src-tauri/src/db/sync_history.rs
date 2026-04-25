use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncHistoryEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub item_count: i64,
    pub direction: Option<String>,
    pub details: Option<String>,
    pub duration_ms: Option<i64>,
    pub created_at: i64,
}

impl SyncHistoryEntry {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            r#type: row.get("type")?,
            item_count: row.get("item_count")?,
            direction: row.get("direction")?,
            details: row.get("details")?,
            duration_ms: row.get("duration_ms")?,
            created_at: row.get("created_at")?,
        })
    }
}
