use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub item_type: String,
    pub item_id: String,
    pub position: i64,
    pub created_at: String,
}

impl Bookmark {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            item_type: row.get("item_type")?,
            item_id: row.get("item_id")?,
            position: row.get("position")?,
            created_at: row.get("created_at")?,
        })
    }
}
