use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub key: String,
    pub value: String,
    pub updated_at: i64,
}

impl SyncState {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            key: row.get("key")?,
            value: row.get("value")?,
            updated_at: row.get("updated_at")?,
        })
    }
}
