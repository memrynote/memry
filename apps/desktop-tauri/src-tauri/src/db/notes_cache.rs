use crate::db::note_metadata::NoteMetadata;
use crate::error::AppResult;
use crate::vault::notes_io;
use rusqlite::{params, Connection, ToSql};
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

const SELECT_COLS_QUALIFIED: &str = "n.id, n.title, n.path, n.snippet, n.word_count, \
    n.tags_json, n.emoji, n.modified_at, n.created_at, n.local_only";

pub async fn refresh_from_metadata(
    conn: &Connection,
    vault_root: &Path,
    metadata: &NoteMetadata,
) -> AppResult<()> {
    let read = notes_io::read_note_from_disk(vault_root, &metadata.path)
        .await?
        .map(|read| read.parsed);
    let body = read
        .as_ref()
        .map(|parsed| parsed.content.as_str())
        .unwrap_or_default();
    let tags = read
        .as_ref()
        .map(|parsed| parsed.frontmatter.tags.as_slice())
        .unwrap_or_default();

    refresh_for(conn, metadata, body, tags)
}

pub fn refresh_for(
    conn: &Connection,
    metadata: &NoteMetadata,
    body: &str,
    tags: &[String],
) -> AppResult<()> {
    let snippet: String = body.chars().take(200).collect();
    let word_count = body.split_whitespace().count() as i64;
    let tags_json = serde_json::to_string(tags)?;
    let inline_tags_json = serde_json::to_string(&crate::db::tag_definitions::inline_tags(body))?;

    conn.execute(
        "INSERT INTO notes_cache (
            id, title, path, snippet, word_count, tags_json, inline_tags_json, emoji,
            modified_at, created_at, local_only
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            path = excluded.path,
            snippet = excluded.snippet,
            word_count = excluded.word_count,
            tags_json = excluded.tags_json,
            inline_tags_json = excluded.inline_tags_json,
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
            tags_json,
            inline_tags_json,
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
    let sort_order = if sort_by == "title" { "asc" } else { "desc" };
    list_active_filtered(
        conn, "notes", None, None, limit, offset, sort_by, sort_order,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn list_active_filtered(
    conn: &Connection,
    notes_root: &str,
    folder: Option<&str>,
    tags: Option<&[String]>,
    limit: i64,
    offset: i64,
    sort_by: &str,
    sort_order: &str,
) -> AppResult<Vec<NotesCacheRow>> {
    let folder_prefix = folder_prefix(folder, notes_root);
    let order_by = order_by(sort_by, sort_order);
    let tag_filter = tag_filter(tags);
    let sql = format!(
        "SELECT {SELECT_COLS_QUALIFIED}
           FROM notes_cache n
           LEFT JOIN note_positions p ON p.path = n.path
          WHERE (? = '' OR substr(n.path, 1, length(?)) = ?){tag_clause}
          ORDER BY {order_by}
          LIMIT ? OFFSET ?",
        tag_clause = tag_filter.where_clause()
    );

    let mut params_vec: Vec<Box<dyn ToSql>> = vec![
        Box::new(folder_prefix.clone()),
        Box::new(folder_prefix.clone()),
        Box::new(folder_prefix),
    ];
    for tag in tag_filter.bound_params() {
        params_vec.push(Box::new(tag));
    }
    params_vec.push(Box::new(limit));
    params_vec.push(Box::new(offset));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params_vec.iter()), map_row)?;
    collect_rows(rows)
}

pub fn count_active(conn: &Connection) -> AppResult<i64> {
    count_active_filtered(conn, "notes", None, None)
}

pub fn count_all_active(conn: &Connection) -> AppResult<i64> {
    let count = conn.query_row(
        "SELECT count(*)
           FROM notes_cache c
           JOIN note_metadata m ON m.id = c.id
          WHERE coalesce(json_extract(m.clock, '$.deleted_at'), '') = ''",
        [],
        |row| row.get(0),
    )?;
    Ok(count)
}

pub fn count_stale_inline_tags(conn: &Connection) -> AppResult<i64> {
    let count = conn.query_row(
        "SELECT count(*)
           FROM notes_cache c
           JOIN note_metadata m ON m.id = c.id
          WHERE coalesce(json_extract(m.clock, '$.deleted_at'), '') = ''
            AND (c.inline_tags_json IS NULL OR c.inline_tags_json = 'null')",
        [],
        |row| row.get(0),
    )?;
    Ok(count)
}

pub fn count_active_filtered(
    conn: &Connection,
    notes_root: &str,
    folder: Option<&str>,
    tags: Option<&[String]>,
) -> AppResult<i64> {
    let folder_prefix = folder_prefix(folder, notes_root);
    let tag_filter = tag_filter(tags);
    let sql = format!(
        "SELECT count(*)
           FROM notes_cache n
          WHERE (? = '' OR substr(n.path, 1, length(?)) = ?){tag_clause}",
        tag_clause = tag_filter.where_clause()
    );

    let mut params_vec: Vec<Box<dyn ToSql>> = vec![
        Box::new(folder_prefix.clone()),
        Box::new(folder_prefix.clone()),
        Box::new(folder_prefix),
    ];
    for tag in tag_filter.bound_params() {
        params_vec.push(Box::new(tag));
    }
    let count: i64 =
        conn.query_row(&sql, rusqlite::params_from_iter(params_vec.iter()), |row| {
            row.get(0)
        })?;
    Ok(count)
}

/// SQL fragment + bound params for the tag-filter portion of the WHERE clause.
struct TagFilter<'a> {
    tags: &'a [String],
}

impl<'a> TagFilter<'a> {
    fn where_clause(&self) -> String {
        if self.tags.is_empty() {
            return String::new();
        }
        let mut out = String::new();
        for _ in self.tags {
            out.push_str(
                " AND (
                    EXISTS (SELECT 1 FROM json_each(n.tags_json) WHERE lower(value) = ?)
                    OR EXISTS (SELECT 1 FROM json_each(n.inline_tags_json) WHERE lower(value) = ?)
                )",
            );
        }
        out
    }

    fn bound_params(&self) -> Vec<String> {
        self.tags
            .iter()
            .flat_map(|tag| {
                let normalized = tag.trim().trim_start_matches('#').to_ascii_lowercase();
                [normalized.clone(), normalized]
            })
            .collect()
    }
}

fn tag_filter(tags: Option<&[String]>) -> TagFilter<'_> {
    TagFilter {
        tags: tags.unwrap_or(&[]),
    }
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM notes_cache WHERE id = ?1", [id])?;
    Ok(())
}

pub fn set_local_only(
    conn: &Connection,
    id: &str,
    local_only: bool,
    modified_at: &str,
) -> AppResult<()> {
    conn.execute(
        "UPDATE notes_cache SET local_only = ?1, modified_at = ?2 WHERE id = ?3",
        params![local_only as i64, modified_at, id],
    )?;
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

fn folder_prefix(folder: Option<&str>, notes_root: &str) -> String {
    let notes_root = notes_root.trim().trim_matches('/');
    let notes_root = if notes_root.is_empty() {
        "notes"
    } else {
        notes_root
    };
    let folder = folder.unwrap_or_default().trim().trim_matches('/');
    if folder.is_empty() {
        format!("{notes_root}/")
    } else {
        format!("{notes_root}/{folder}/")
    }
}

fn order_by(sort_by: &str, sort_order: &str) -> String {
    let dir = if sort_order.eq_ignore_ascii_case("asc") {
        "ASC"
    } else {
        "DESC"
    };

    match sort_by {
        "created" => format!("n.created_at {dir}, n.id ASC"),
        "title" => format!("n.title COLLATE NOCASE {dir}, n.id ASC"),
        "position" => format!(
            "coalesce(p.position, 9223372036854775807) {dir}, n.title COLLATE NOCASE ASC, n.id ASC"
        ),
        _ => format!("n.modified_at {dir}, n.id ASC"),
    }
}

fn collect_rows<T>(rows: impl Iterator<Item = rusqlite::Result<T>>) -> AppResult<Vec<T>> {
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
