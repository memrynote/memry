use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NotePosition {
    pub path: String,
    pub folder_path: String,
    pub position: i64,
}

impl NotePosition {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            path: row.get("path")?,
            folder_path: row.get("folder_path")?,
            position: row.get("position")?,
        })
    }
}
