use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub status_id: Option<String>,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub priority: i64,
    pub position: i64,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub start_date: Option<String>,
    pub repeat_config: Option<String>,
    pub repeat_from: Option<String>,
    pub source_note_id: Option<String>,
    pub completed_at: Option<String>,
    pub archived_at: Option<String>,
    pub clock: Option<String>,
    pub field_clocks: Option<String>,
    pub synced_at: Option<String>,
    pub created_at: String,
    pub modified_at: String,
}

impl Task {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            project_id: row.get("project_id")?,
            status_id: row.get("status_id")?,
            parent_id: row.get("parent_id")?,
            title: row.get("title")?,
            description: row.get("description")?,
            priority: row.get("priority")?,
            position: row.get("position")?,
            due_date: row.get("due_date")?,
            due_time: row.get("due_time")?,
            start_date: row.get("start_date")?,
            repeat_config: row.get("repeat_config")?,
            repeat_from: row.get("repeat_from")?,
            source_note_id: row.get("source_note_id")?,
            completed_at: row.get("completed_at")?,
            archived_at: row.get("archived_at")?,
            clock: row.get("clock")?,
            field_clocks: row.get("field_clocks")?,
            synced_at: row.get("synced_at")?,
            created_at: row.get("created_at")?,
            modified_at: row.get("modified_at")?,
        })
    }
}
