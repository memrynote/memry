use crate::error::AppResult;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderConfig {
    pub path: String,
    pub icon: Option<String>,
    pub template_json: Option<String>,
    pub clock: Option<String>,
    pub created_at: String,
    pub modified_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderConfigRow {
    pub path: String,
    pub icon: Option<String>,
    pub template_json: Option<String>,
}

const SELECT_COLS: &str = "path, icon, template_json, clock, created_at, modified_at";

impl FolderConfig {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            path: row.get("path")?,
            icon: row.get("icon")?,
            template_json: row.get("template_json")?,
            clock: row.get("clock")?,
            created_at: row.get("created_at")?,
            modified_at: row.get("modified_at")?,
        })
    }
}

pub fn get(conn: &Connection, path: &str) -> AppResult<Option<FolderConfig>> {
    optional_row(conn.query_row(
        &format!("SELECT {SELECT_COLS} FROM folder_configs WHERE path = ?1"),
        [path],
        map_row,
    ))
}

pub fn set(conn: &Connection, cfg: &FolderConfigRow) -> AppResult<()> {
    conn.execute(
        "INSERT INTO folder_configs (path, icon, template_json)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET
            icon = excluded.icon,
            template_json = excluded.template_json,
            modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        params![cfg.path, cfg.icon, cfg.template_json],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, path: &str) -> AppResult<()> {
    conn.execute("DELETE FROM folder_configs WHERE path = ?1", [path])?;
    Ok(())
}

pub fn get_template_inherited(conn: &Connection, path: &str) -> AppResult<Option<String>> {
    for candidate in ancestor_paths(path) {
        if let Some(template) = get(conn, &candidate)?.and_then(|cfg| cfg.template_json) {
            if !template.is_empty() {
                return Ok(Some(template));
            }
        }
    }
    Ok(None)
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FolderConfig> {
    Ok(FolderConfig {
        path: row.get(0)?,
        icon: row.get(1)?,
        template_json: row.get(2)?,
        clock: row.get(3)?,
        created_at: row.get(4)?,
        modified_at: row.get(5)?,
    })
}

fn ancestor_paths(path: &str) -> Vec<String> {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        return vec![String::new()];
    }

    let parts: Vec<&str> = trimmed.split('/').collect();
    (1..=parts.len())
        .rev()
        .map(|len| parts[..len].join("/"))
        .collect()
}

fn optional_row<T>(result: rusqlite::Result<T>) -> AppResult<Option<T>> {
    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err.into()),
    }
}
