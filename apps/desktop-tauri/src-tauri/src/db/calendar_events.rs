use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start_at: String,
    pub end_at: Option<String>,
    pub timezone: String,
    pub is_all_day: bool,
    pub recurrence_rule: Option<String>,
    pub recurrence_exceptions: Option<String>,
    pub archived_at: Option<String>,
    pub clock: Option<String>,
    pub synced_at: Option<String>,
    pub created_at: String,
    pub modified_at: String,
    pub target_calendar_id: Option<String>,
    pub field_clocks: Option<String>,
    pub attendees: Option<String>,
    pub reminders: Option<String>,
    pub visibility: Option<String>,
    pub color_id: Option<String>,
    pub conference_data: Option<String>,
    pub parent_event_id: Option<String>,
    pub original_start_time: Option<String>,
}

impl CalendarEvent {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            description: row.get("description")?,
            location: row.get("location")?,
            start_at: row.get("start_at")?,
            end_at: row.get("end_at")?,
            timezone: row.get("timezone")?,
            is_all_day: row.get::<_, i64>("is_all_day")? != 0,
            recurrence_rule: row.get("recurrence_rule")?,
            recurrence_exceptions: row.get("recurrence_exceptions")?,
            archived_at: row.get("archived_at")?,
            clock: row.get("clock")?,
            synced_at: row.get("synced_at")?,
            created_at: row.get("created_at")?,
            modified_at: row.get("modified_at")?,
            target_calendar_id: row.get("target_calendar_id")?,
            field_clocks: row.get("field_clocks")?,
            attendees: row.get("attendees")?,
            reminders: row.get("reminders")?,
            visibility: row.get("visibility")?,
            color_id: row.get("color_id")?,
            conference_data: row.get("conference_data")?,
            parent_event_id: row.get("parent_event_id")?,
            original_start_time: row.get("original_start_time")?,
        })
    }
}
