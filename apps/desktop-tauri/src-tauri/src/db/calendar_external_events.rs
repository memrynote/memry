use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarExternalEvent {
    pub id: String,
    pub source_id: String,
    pub remote_event_id: String,
    pub remote_etag: Option<String>,
    pub remote_updated_at: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start_at: String,
    pub end_at: Option<String>,
    pub timezone: Option<String>,
    pub is_all_day: bool,
    pub status: String,
    pub recurrence_rule: Option<String>,
    pub raw_payload: Option<String>,
    pub archived_at: Option<String>,
    pub clock: Option<String>,
    pub synced_at: Option<String>,
    pub created_at: String,
    pub modified_at: String,
    pub attendees: Option<String>,
    pub reminders: Option<String>,
    pub visibility: Option<String>,
    pub color_id: Option<String>,
    pub conference_data: Option<String>,
}

impl CalendarExternalEvent {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            source_id: row.get("source_id")?,
            remote_event_id: row.get("remote_event_id")?,
            remote_etag: row.get("remote_etag")?,
            remote_updated_at: row.get("remote_updated_at")?,
            title: row.get("title")?,
            description: row.get("description")?,
            location: row.get("location")?,
            start_at: row.get("start_at")?,
            end_at: row.get("end_at")?,
            timezone: row.get("timezone")?,
            is_all_day: row.get::<_, i64>("is_all_day")? != 0,
            status: row.get("status")?,
            recurrence_rule: row.get("recurrence_rule")?,
            raw_payload: row.get("raw_payload")?,
            archived_at: row.get("archived_at")?,
            clock: row.get("clock")?,
            synced_at: row.get("synced_at")?,
            created_at: row.get("created_at")?,
            modified_at: row.get("modified_at")?,
            attendees: row.get("attendees")?,
            reminders: row.get("reminders")?,
            visibility: row.get("visibility")?,
            color_id: row.get("color_id")?,
            conference_data: row.get("conference_data")?,
        })
    }
}
