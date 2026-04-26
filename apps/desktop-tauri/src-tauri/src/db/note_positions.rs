use crate::error::AppResult;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

pub fn reorder(conn: &Connection, folder_path: &str, note_paths: &[String]) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM note_positions WHERE folder_path = ?1",
        [folder_path],
    )?;

    for (position, path) in note_paths.iter().enumerate() {
        tx.execute(
            "INSERT INTO note_positions (path, folder_path, position)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET
                folder_path = excluded.folder_path,
                position = excluded.position",
            params![path, folder_path, position as i64],
        )?;
    }

    tx.commit()?;
    Ok(())
}

pub fn get_for_folder(conn: &Connection, folder_path: &str) -> AppResult<HashMap<String, i64>> {
    let mut stmt = conn.prepare(
        "SELECT path, position FROM note_positions WHERE folder_path = ?1 ORDER BY position",
    )?;
    let rows = stmt.query_map([folder_path], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    collect_positions(rows)
}

pub fn get_all(conn: &Connection) -> AppResult<HashMap<String, i64>> {
    let mut stmt = conn.prepare("SELECT path, position FROM note_positions")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    collect_positions(rows)
}

pub fn drop_for_note(conn: &Connection, path: &str) -> AppResult<()> {
    conn.execute("DELETE FROM note_positions WHERE path = ?1", [path])?;
    Ok(())
}

fn collect_positions(
    rows: impl Iterator<Item = rusqlite::Result<(String, i64)>>,
) -> AppResult<HashMap<String, i64>> {
    let mut out = HashMap::new();
    for row in rows {
        let (path, position) = row?;
        out.insert(path, position);
    }
    Ok(out)
}
