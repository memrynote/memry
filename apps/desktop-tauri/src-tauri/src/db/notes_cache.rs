use crate::db::note_metadata::NoteMetadata;
use crate::error::AppResult;
use crate::vault::notes_io;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NotesCacheRow {
    pub id: String,
    pub title: String,
    pub path: String,
    pub snippet: String,
    pub word_count: i64,
    pub tags_json: String,
    pub emoji: Option<String>,
    pub modified_at: String,
    pub created_at: String,
    pub local_only: bool,
}

const SELECT_COLS: &str = "id, title, path, snippet, word_count, tags_json, emoji, \
    modified_at, created_at, local_only";

pub async fn refresh_from_metadata(
    conn: &Connection,
    vault_root: &Path,
    metadata: &NoteMetadata,
) -> AppResult<()> {
    let body = notes_io::read_note_from_disk(vault_root, &metadata.path)
        .await?
        .map(|read| read.parsed.content)
        .unwrap_or_default();
    let snippet: String = body.chars().take(200).collect();
    let word_count = body.split_whitespace().count() as i64;

    conn.execute(
        "INSERT INTO notes_cache (
            id, title, path, snippet, word_count, tags_json, emoji,
            modified_at, created_at, local_only
         ) VALUES (?1, ?2, ?3, ?4, ?5, '[]', ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            path = excluded.path,
            snippet = excluded.snippet,
            word_count = excluded.word_count,
            tags_json = excluded.tags_json,
            emoji = excluded.emoji,
            modified_at = excluded.modified_at,
            created_at = excluded.created_at,
            local_only = excluded.local_only",
        params![
            metadata.id,
            metadata.title,
            metadata.path,
            snippet,
            word_count,
            metadata.emoji,
            metadata.modified_at,
            metadata.created_at,
            metadata.local_only as i64,
        ],
    )?;

    Ok(())
}

pub fn list_active(
    conn: &Connection,
    limit: i64,
    offset: i64,
    sort_by: &str,
) -> AppResult<Vec<NotesCacheRow>> {
    let order_by = match sort_by {
        "created" => "created_at DESC, id ASC",
        "title" => "title COLLATE NOCASE ASC, id ASC",
        _ => "modified_at DESC, id ASC",
    };
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM notes_cache ORDER BY {order_by} LIMIT ?1 OFFSET ?2"
    ))?;
    let rows = stmt.query_map(params![limit, offset], map_row)?;
    collect_rows(rows)
}

pub fn count_active(conn: &Connection) -> AppResult<i64> {
    let count = conn.query_row("SELECT count(*) FROM notes_cache", [], |row| row.get(0))?;
    Ok(count)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM notes_cache WHERE id = ?1", [id])?;
    Ok(())
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<NotesCacheRow> {
    Ok(NotesCacheRow {
        id: row.get(0)?,
        title: row.get(1)?,
        path: row.get(2)?,
        snippet: row.get(3)?,
        word_count: row.get(4)?,
        tags_json: row.get(5)?,
        emoji: row.get(6)?,
        modified_at: row.get(7)?,
        created_at: row.get(8)?,
        local_only: row.get::<_, i64>(9)? != 0,
    })
}

fn collect_rows<T>(rows: impl Iterator<Item = rusqlite::Result<T>>) -> AppResult<Vec<T>> {
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
