use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub color: String,
    pub position: i64,
    pub is_default: bool,
    pub is_done: bool,
    pub created_at: String,
}

impl Status {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            project_id: row.get("project_id")?,
            name: row.get("name")?,
            color: row.get("color")?,
            position: row.get("position")?,
            is_default: row.get::<_, i64>("is_default")? != 0,
            is_done: row.get::<_, i64>("is_done")? != 0,
            created_at: row.get("created_at")?,
        })
    }
}
