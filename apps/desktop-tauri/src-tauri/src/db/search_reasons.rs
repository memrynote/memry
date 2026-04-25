use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchReason {
    pub id: String,
    pub item_id: String,
    pub item_type: String,
    pub item_title: String,
    pub item_icon: Option<String>,
    pub search_query: String,
    pub visited_at: String,
}

impl SearchReason {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            item_id: row.get("item_id")?,
            item_type: row.get("item_type")?,
            item_title: row.get("item_title")?,
            item_icon: row.get("item_icon")?,
            search_query: row.get("search_query")?,
            visited_at: row.get("visited_at")?,
        })
    }
}
