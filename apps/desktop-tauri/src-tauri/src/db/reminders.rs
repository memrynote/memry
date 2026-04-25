use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub target_type: String,
    pub target_id: String,
    pub remind_at: String,
    pub highlight_text: Option<String>,
    pub highlight_start: Option<i64>,
    pub highlight_end: Option<i64>,
    pub title: Option<String>,
    pub note: Option<String>,
    pub status: String,
    pub triggered_at: Option<String>,
    pub dismissed_at: Option<String>,
    pub snoozed_until: Option<String>,
    pub created_at: String,
    pub modified_at: String,
}

impl Reminder {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            target_type: row.get("target_type")?,
            target_id: row.get("target_id")?,
            remind_at: row.get("remind_at")?,
            highlight_text: row.get("highlight_text")?,
            highlight_start: row.get("highlight_start")?,
            highlight_end: row.get("highlight_end")?,
            title: row.get("title")?,
            note: row.get("note")?,
            status: row.get("status")?,
            triggered_at: row.get("triggered_at")?,
            dismissed_at: row.get("dismissed_at")?,
            snoozed_until: row.get("snoozed_until")?,
            created_at: row.get("created_at")?,
            modified_at: row.get("modified_at")?,
        })
    }
}
