use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDefinition {
    pub name: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub options: Option<String>,
    pub default_value: Option<String>,
    pub color: Option<String>,
    pub created_at: String,
}

impl PropertyDefinition {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            name: row.get("name")?,
            r#type: row.get("type")?,
            options: row.get("options")?,
            default_value: row.get("default_value")?,
            color: row.get("color")?,
            created_at: row.get("created_at")?,
        })
    }
}
