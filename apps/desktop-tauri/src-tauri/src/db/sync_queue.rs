use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncQueueItem {
    pub id: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub item_id: String,
    pub operation: String,
    pub payload: String,
    pub priority: i64,
    pub attempts: i64,
    pub last_attempt: Option<i64>,
    pub error_message: Option<String>,
    pub created_at: i64,
}

impl SyncQueueItem {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            r#type: row.get("type")?,
            item_id: row.get("item_id")?,
            operation: row.get("operation")?,
            payload: row.get("payload")?,
            priority: row.get("priority")?,
            attempts: row.get("attempts")?,
            last_attempt: row.get("last_attempt")?,
            error_message: row.get("error_message")?,
            created_at: row.get("created_at")?,
        })
    }
}
