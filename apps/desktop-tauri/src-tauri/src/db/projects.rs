use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub icon: Option<String>,
    pub position: i64,
    pub is_inbox: bool,
    pub created_at: String,
    pub modified_at: String,
    pub archived_at: Option<String>,
    pub clock: Option<String>,
    pub field_clocks: Option<String>,
    pub synced_at: Option<String>,
}

impl Project {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            description: row.get("description")?,
            color: row.get("color")?,
            icon: row.get("icon")?,
            position: row.get("position")?,
            is_inbox: row.get::<_, i64>("is_inbox")? != 0,
            created_at: row.get("created_at")?,
            modified_at: row.get("modified_at")?,
            archived_at: row.get("archived_at")?,
            clock: row.get("clock")?,
            field_clocks: row.get("field_clocks")?,
            synced_at: row.get("synced_at")?,
        })
    }
}
