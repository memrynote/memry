use crate::db::Db;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub key: String,
    pub value: String,
    pub modified_at: String,
}

impl Setting {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            key: row.get("key")?,
            value: row.get("value")?,
            modified_at: row.get("modified_at")?,
        })
    }
}

pub fn get(db: &Db, key: &str) -> AppResult<Option<String>> {
    let conn = db.conn()?;
    let result = conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get::<_, String>(0),
    );
    match result {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(AppError::from(e)),
    }
}

pub fn set(db: &Db, key: &str, value: &str) -> AppResult<()> {
    let conn = db.conn()?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

pub fn list(db: &Db) -> AppResult<Vec<Setting>> {
    let conn = db.conn()?;
    let mut stmt = conn.prepare("SELECT key, value, modified_at FROM settings ORDER BY key")?;
    let items = stmt
        .query_map([], Setting::from_row)?
        .filter_map(Result::ok)
        .collect();
    Ok(items)
}
