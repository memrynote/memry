use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderConfig {
    pub path: String,
    pub icon: Option<String>,
    pub clock: Option<String>,
    pub created_at: String,
    pub modified_at: String,
}

impl FolderConfig {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            path: row.get("path")?,
            icon: row.get("icon")?,
            clock: row.get("clock")?,
            created_at: row.get("created_at")?,
            modified_at: row.get("modified_at")?,
        })
    }
}
