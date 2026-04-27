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

pub fn move_for_note(
    conn: &Connection,
    old_path: &str,
    new_path: &str,
    notes_root: &str,
) -> AppResult<()> {
    let folder_path = folder_path_for(new_path, notes_root);
    conn.execute(
        "UPDATE note_positions
            SET path = ?1, folder_path = ?2
          WHERE path = ?3",
        params![new_path, folder_path, old_path],
    )?;
    Ok(())
}

fn folder_path_for(path: &str, notes_root: &str) -> String {
    let folder = path
        .rsplit_once('/')
        .map(|(folder, _)| folder.to_string())
        .unwrap_or_default();
    let root = normalized_notes_root(notes_root);
    if folder == root {
        String::new()
    } else {
        folder
            .strip_prefix(&format!("{root}/"))
            .unwrap_or(&folder)
            .to_string()
    }
}

fn normalized_notes_root(notes_root: &str) -> String {
    let trimmed = notes_root.trim().trim_matches('/');
    if trimmed.is_empty() {
        "notes".into()
    } else {
        trimmed.to_string()
    }
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
