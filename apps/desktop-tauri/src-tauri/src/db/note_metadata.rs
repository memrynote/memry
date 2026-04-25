use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteMetadata {
    pub id: String,
    pub path: String,
    pub title: String,
    pub emoji: Option<String>,
    pub file_type: String,
    pub mime_type: Option<String>,
    pub file_size: Option<i64>,
    pub attachment_id: Option<String>,
    pub attachment_references: Option<String>,
    pub local_only: bool,
    pub sync_policy: String,
    pub journal_date: Option<String>,
    pub property_definition_names: Option<String>,
    pub clock: Option<String>,
    pub synced_at: Option<String>,
    pub created_at: String,
    pub modified_at: String,
    pub stored_at: String,
}

impl NoteMetadata {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            path: row.get("path")?,
            title: row.get("title")?,
            emoji: row.get("emoji")?,
            file_type: row.get("file_type")?,
            mime_type: row.get("mime_type")?,
            file_size: row.get("file_size")?,
            attachment_id: row.get("attachment_id")?,
            attachment_references: row.get("attachment_references")?,
            local_only: row.get::<_, i64>("local_only")? != 0,
            sync_policy: row.get("sync_policy")?,
            journal_date: row.get("journal_date")?,
            property_definition_names: row.get("property_definition_names")?,
            clock: row.get("clock")?,
            synced_at: row.get("synced_at")?,
            created_at: row.get("created_at")?,
            modified_at: row.get("modified_at")?,
            stored_at: row.get("stored_at")?,
        })
    }
}
