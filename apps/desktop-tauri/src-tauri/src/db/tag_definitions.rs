use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagDefinition {
    pub name: String,
    pub color: String,
    pub clock: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagWithCount {
    pub name: String,
    pub count: i64,
    pub color: Option<String>,
}

impl TagDefinition {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            name: row.get("name")?,
            color: row.get("color")?,
            clock: row.get("clock")?,
            created_at: row.get("created_at")?,
        })
    }
}

pub fn upsert(conn: &Connection, name: &str, color: &str) -> AppResult<()> {
    let name = normalize(name)?;
    conn.execute(
        "INSERT INTO tag_definitions (name, color)
         VALUES (?1, ?2)
         ON CONFLICT(name) DO UPDATE SET color = excluded.color",
        params![name, color],
    )?;
    Ok(())
}

pub fn list(conn: &Connection) -> AppResult<Vec<TagDefinition>> {
    let mut stmt =
        conn.prepare("SELECT name, color, clock, created_at FROM tag_definitions ORDER BY name")?;
    let rows = stmt.query_map([], map_row)?;
    collect_rows(rows)
}

pub fn count(conn: &Connection) -> AppResult<i64> {
    let count = conn.query_row("SELECT count(*) FROM tag_definitions", [], |row| row.get(0))?;
    Ok(count)
}

pub fn rename(conn: &Connection, old_name: &str, new_name: &str) -> AppResult<usize> {
    let old_name = normalize(old_name)?;
    let new_name = normalize(new_name)?;
    if old_name == new_name {
        return Ok(0);
    }

    let tx = conn.unchecked_transaction()?;
    let mut changed = rename_one(&tx, &old_name, &new_name)?;

    let child_pattern = format!("{old_name}/%");
    let children = {
        let mut stmt = tx.prepare("SELECT name FROM tag_definitions WHERE name LIKE ?1")?;
        let rows = stmt.query_map([child_pattern], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    for child in children {
        let suffix = &child[old_name.len()..];
        changed += rename_one(&tx, &child, &format!("{new_name}{suffix}"))?;
    }

    tx.commit()?;
    Ok(changed)
}

pub fn list_with_counts(conn: &Connection) -> AppResult<Vec<TagWithCount>> {
    let definitions = list(conn)?;
    let mut counts: BTreeMap<String, TagWithCount> = definitions
        .into_iter()
        .map(|tag| {
            (
                tag.name.clone(),
                TagWithCount {
                    name: tag.name,
                    count: 0,
                    color: Some(tag.color),
                },
            )
        })
        .collect();

    // Frontmatter tags live in notes_cache.tags_json. Skip rows whose
    // metadata row is tombstoned so deleted notes do not poison counts.
    let mut frontmatter_stmt = conn.prepare(
        "SELECT c.tags_json
           FROM notes_cache c
           JOIN note_metadata m ON m.id = c.id
          WHERE coalesce(json_extract(m.clock, '$.deleted_at'), '') = ''",
    )?;
    let frontmatter_rows = frontmatter_stmt.query_map([], |row| row.get::<_, String>(0))?;
    for row in frontmatter_rows {
        for tag in tags_from_json(&row?) {
            increment(&mut counts, &tag);
        }
    }

    // Inline `#hashtags` come from the cached body snippet. Apply the same
    // tombstone filter so the live note set drives the count.
    let mut snippet_stmt = conn.prepare(
        "SELECT c.snippet
           FROM notes_cache c
           JOIN note_metadata m ON m.id = c.id
          WHERE coalesce(json_extract(m.clock, '$.deleted_at'), '') = ''",
    )?;
    let snippet_rows = snippet_stmt.query_map([], |row| row.get::<_, String>(0))?;
    for row in snippet_rows {
        for tag in inline_tags(&row?) {
            increment(&mut counts, &tag);
        }
    }

    let mut out: Vec<TagWithCount> = counts.into_values().collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

fn rename_one(conn: &Connection, old_name: &str, new_name: &str) -> AppResult<usize> {
    let target_exists: i64 = conn.query_row(
        "SELECT count(*) FROM tag_definitions WHERE name = ?1",
        [new_name],
        |row| row.get(0),
    )?;

    let changed = if target_exists > 0 {
        conn.execute("DELETE FROM tag_definitions WHERE name = ?1", [old_name])?
    } else {
        conn.execute(
            "UPDATE tag_definitions SET name = ?1 WHERE name = ?2",
            params![new_name, old_name],
        )?
    };
    Ok(changed)
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TagDefinition> {
    Ok(TagDefinition {
        name: row.get(0)?,
        color: row.get(1)?,
        clock: row.get(2)?,
        created_at: row.get(3)?,
    })
}

fn tags_from_json(json: &str) -> Vec<String> {
    match serde_json::from_str::<Value>(json) {
        Ok(Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| item.as_str().map(normalize_lossy))
            .filter(|tag| !tag.is_empty())
            .collect(),
        Ok(Value::Object(map)) => map
            .keys()
            .map(|key| normalize_lossy(key))
            .filter(|tag| !tag.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// Extract `#hashtag` tokens from a body or snippet. Tokens are lowercased
/// to match how `list_with_counts` aggregates them, so callers can use the
/// returned values directly when reconciling `frontmatter.tags`.
pub fn inline_tags(snippet: &str) -> Vec<String> {
    let mut tags = Vec::new();
    for token in snippet.split_whitespace() {
        let Some(hash_index) = token.find('#') else {
            continue;
        };
        let tag: String = token[hash_index + 1..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/'))
            .collect();
        let normalized = normalize_lossy(&tag);
        if !normalized.is_empty() {
            tags.push(normalized);
        }
    }
    tags
}

fn increment(counts: &mut BTreeMap<String, TagWithCount>, raw: &str) {
    let name = normalize_lossy(raw);
    if name.is_empty() {
        return;
    }
    counts
        .entry(name.clone())
        .or_insert_with(|| TagWithCount {
            name,
            count: 0,
            color: None,
        })
        .count += 1;
}

fn normalize(name: &str) -> AppResult<String> {
    let name = normalize_lossy(name);
    if name.is_empty() {
        return Err(AppError::Validation("tag name cannot be empty".into()));
    }
    Ok(name)
}

fn normalize_lossy(name: &str) -> String {
    name.trim().to_lowercase()
}

fn collect_rows<T>(rows: impl Iterator<Item = rusqlite::Result<T>>) -> AppResult<Vec<T>> {
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
