use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncDevice {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub os_version: Option<String>,
    pub app_version: String,
    pub linked_at: i64,
    pub last_sync_at: Option<i64>,
    pub is_current_device: bool,
    pub signing_public_key: String,
}

impl SyncDevice {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            platform: row.get("platform")?,
            os_version: row.get("os_version")?,
            app_version: row.get("app_version")?,
            linked_at: row.get("linked_at")?,
            last_sync_at: row.get("last_sync_at")?,
            is_current_device: row.get::<_, i64>("is_current_device")? != 0,
            signing_public_key: row.get("signing_public_key")?,
        })
    }
}
