use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

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

    // Count each tag once per live note even when it appears in both
    // frontmatter and inline body text.
    let mut stmt = conn.prepare(
        "SELECT c.tags_json, c.inline_tags_json
           FROM notes_cache c
           JOIN note_metadata m ON m.id = c.id
          WHERE coalesce(json_extract(m.clock, '$.deleted_at'), '') = ''",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (frontmatter_json, inline_json) = row?;
        let mut note_tags = HashSet::new();
        note_tags.extend(tags_from_json(&frontmatter_json));
        note_tags.extend(tags_from_json(&inline_json));
        for tag in note_tags {
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
    let snippet = strip_markdown_code(snippet);
    let mut tags = Vec::new();
    let mut seen = HashSet::new();
    let mut iter = snippet.char_indices().peekable();

    while let Some((index, ch)) = iter.next() {
        if ch != '#' {
            continue;
        }

        if index > 0 {
            let preceding = snippet[..index].chars().next_back();
            if preceding.is_some_and(|c| !c.is_whitespace()) {
                continue;
            }
        }

        let tag = take_inline_tag(&mut iter);
        let normalized = normalize_lossy(&tag);
        if !normalized.is_empty() && seen.insert(normalized.clone()) {
            tags.push(normalized);
        }
    }

    tags
}

fn strip_markdown_code(snippet: &str) -> String {
    let mut without_fences = String::with_capacity(snippet.len());
    let mut rest = snippet;
    while let Some(start) = rest.find("```") {
        without_fences.push_str(&rest[..start]);
        let after_start = &rest[start + 3..];
        let Some(end) = after_start.find("```") else {
            without_fences.push_str(&rest[start..]);
            rest = "";
            break;
        };
        rest = &after_start[end + 3..];
    }
    without_fences.push_str(rest);

    let mut out = String::with_capacity(without_fences.len());
    let mut rest = without_fences.as_str();
    while let Some(start) = rest.find('`') {
        out.push_str(&rest[..start]);
        let after_start = &rest[start + 1..];
        let Some(end) = after_start.find('`') else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        rest = &after_start[end + 1..];
    }
    out.push_str(rest);
    out
}

fn take_inline_tag(iter: &mut std::iter::Peekable<std::str::CharIndices<'_>>) -> String {
    let mut tag = String::new();
    let Some((_, first)) = iter.peek().copied() else {
        return tag;
    };
    if !first.is_ascii_alphanumeric() {
        return tag;
    }
    tag.push(first);
    iter.next();

    while let Some((_, ch)) = iter.peek().copied() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
            tag.push(ch);
            iter.next();
            continue;
        }

        if ch == '/' && slash_starts_segment(iter) {
            tag.push(ch);
            iter.next();
            continue;
        }

        break;
    }

    tag
}

fn slash_starts_segment(iter: &std::iter::Peekable<std::str::CharIndices<'_>>) -> bool {
    let mut clone = iter.clone();
    clone.next();
    clone
        .peek()
        .map(|(_, ch)| ch.is_ascii_alphanumeric())
        .unwrap_or(false)
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
