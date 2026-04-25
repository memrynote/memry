use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagDefinition {
    pub name: String,
    pub color: String,
    pub clock: Option<String>,
    pub created_at: String,
}

impl TagDefinition {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            name: row.get("name")?,
            color: row.get("color")?,
            clock: row.get("clock")?,
            created_at: row.get("created_at")?,
        })
    }
}
