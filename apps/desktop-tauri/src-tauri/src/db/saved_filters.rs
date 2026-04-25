use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedFilter {
    pub id: String,
    pub name: String,
    pub config: String,
    pub position: i64,
    pub created_at: String,
    pub clock: Option<String>,
    pub synced_at: Option<String>,
}

impl SavedFilter {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            config: row.get("config")?,
            position: row.get("position")?,
            created_at: row.get("created_at")?,
            clock: row.get("clock")?,
            synced_at: row.get("synced_at")?,
        })
    }
}
