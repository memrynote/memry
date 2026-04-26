//! note_metadata table helpers. Body content lives in the vault filesystem.

use crate::error::AppResult;
use rusqlite::{params, Connection};
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

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteMetadataRow {
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
}

const SELECT_COLS: &str = "id, path, title, emoji, file_type, mime_type, file_size, \
    attachment_id, attachment_references, local_only, sync_policy, journal_date, \
    property_definition_names, clock, synced_at, created_at, modified_at, stored_at";

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

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteMetadata> {
    Ok(NoteMetadata {
        id: row.get(0)?,
        path: row.get(1)?,
        title: row.get(2)?,
        emoji: row.get(3)?,
        file_type: row.get(4)?,
        mime_type: row.get(5)?,
        file_size: row.get(6)?,
        attachment_id: row.get(7)?,
        attachment_references: row.get(8)?,
        local_only: row.get::<_, i64>(9)? != 0,
        sync_policy: row.get(10)?,
        journal_date: row.get(11)?,
        property_definition_names: row.get(12)?,
        clock: row.get(13)?,
        synced_at: row.get(14)?,
        created_at: row.get(15)?,
        modified_at: row.get(16)?,
        stored_at: row.get(17)?,
    })
}

pub fn upsert(conn: &Connection, r: &NoteMetadataRow) -> AppResult<()> {
    conn.execute(
        "INSERT INTO note_metadata (
            id, path, title, emoji, file_type, mime_type, file_size,
            attachment_id, attachment_references, local_only, sync_policy,
            journal_date, property_definition_names, clock, synced_at,
            created_at, modified_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(id) DO UPDATE SET
            path = excluded.path,
            title = excluded.title,
            emoji = excluded.emoji,
            file_type = excluded.file_type,
            mime_type = excluded.mime_type,
            file_size = excluded.file_size,
            attachment_id = excluded.attachment_id,
            attachment_references = excluded.attachment_references,
            local_only = excluded.local_only,
            sync_policy = excluded.sync_policy,
            journal_date = excluded.journal_date,
            property_definition_names = excluded.property_definition_names,
            clock = excluded.clock,
            synced_at = excluded.synced_at,
            modified_at = excluded.modified_at",
        params![
            r.id,
            r.path,
            r.title,
            r.emoji,
            r.file_type,
            r.mime_type,
            r.file_size,
            r.attachment_id,
            r.attachment_references,
            r.local_only as i64,
            r.sync_policy,
            r.journal_date,
            r.property_definition_names,
            r.clock,
            r.synced_at,
            r.created_at,
            r.modified_at,
        ],
    )?;
    Ok(())
}

pub fn get_by_id(conn: &Connection, id: &str) -> AppResult<Option<NoteMetadata>> {
    optional_row(conn.query_row(
        &format!("SELECT {SELECT_COLS} FROM note_metadata WHERE id = ?1"),
        [id],
        map_row,
    ))
}

pub fn get_by_path(conn: &Connection, path: &str) -> AppResult<Option<NoteMetadata>> {
    optional_row(conn.query_row(
        &format!("SELECT {SELECT_COLS} FROM note_metadata WHERE path = ?1"),
        [path],
        map_row,
    ))
}

pub fn list_active(conn: &Connection) -> AppResult<Vec<NoteMetadata>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM note_metadata
         WHERE coalesce(json_extract(clock, '$.deleted_at'), '') = ''
         ORDER BY modified_at DESC, id ASC"
    ))?;
    let rows = stmt.query_map([], map_row)?;
    collect_rows(rows)
}

pub fn list_in_folder(conn: &Connection, folder_prefix: &str) -> AppResult<Vec<NoteMetadata>> {
    let prefix = if folder_prefix.is_empty() {
        String::new()
    } else {
        format!("{folder_prefix}/")
    };
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM note_metadata
         WHERE (?1 = '' OR substr(path, 1, length(?1)) = ?1)
           AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''
         ORDER BY modified_at DESC, id ASC"
    ))?;
    let rows = stmt.query_map([prefix], map_row)?;
    collect_rows(rows)
}

pub fn rename_path(
    conn: &Connection,
    id: &str,
    new_path: &str,
    modified_at: &str,
) -> AppResult<()> {
    conn.execute(
        "UPDATE note_metadata SET path = ?1, modified_at = ?2 WHERE id = ?3",
        params![new_path, modified_at, id],
    )?;
    Ok(())
}

pub fn delete_soft(conn: &Connection, id: &str, deleted_at: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE note_metadata
            SET clock = json_set(coalesce(clock, '{}'), '$.deleted_at', ?1),
                modified_at = ?1
          WHERE id = ?2",
        params![deleted_at, id],
    )?;
    Ok(())
}

pub fn set_local_only(
    conn: &Connection,
    id: &str,
    local_only: bool,
    modified_at: &str,
) -> AppResult<()> {
    conn.execute(
        "UPDATE note_metadata SET local_only = ?1, modified_at = ?2 WHERE id = ?3",
        params![local_only as i64, modified_at, id],
    )?;
    Ok(())
}

pub fn count_local_only(conn: &Connection) -> AppResult<i64> {
    let count = conn.query_row(
        "SELECT count(*) FROM note_metadata
         WHERE local_only = 1
           AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''",
        [],
        |row| row.get(0),
    )?;
    Ok(count)
}

pub fn exists_path(conn: &Connection, path: &str) -> AppResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM note_metadata
         WHERE path = ?1
           AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''",
        [path],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn optional_row<T>(result: rusqlite::Result<T>) -> AppResult<Option<T>> {
    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn collect_rows<T>(rows: impl Iterator<Item = rusqlite::Result<T>>) -> AppResult<Vec<T>> {
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
