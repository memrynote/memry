//! The rows of a folder view and of a tag's table (`ipc/folder-view-handlers.ts`,
//! `tags/objects.ts`, `database/queries/tag-items.ts`), and the property columns they offer.
//!
//! A folder lists its notes at any depth (never a journal day), oldest change first, and the
//! note beside it that the sidebar pairs onto its row ([`paired_folder_path`]). A tag lists the
//! notes, journal days, tasks and inbox items carrying it or a `/` tag under it, each also
//! carrying every `and_tags` entry by the same rule. A tag with fields lists its objects (the
//! notes whose header carries it or a tag that extends it, and the tasks carrying one of those)
//! or, asked for mentions, the other items. The reads are [`crate::api::search::Search`]'s.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::property_values::indexed_value;
use crate::domain::tag_objects::Resolved;
use crate::domain::tags::tag_key;
use crate::sync::versioned;

/// What a row is; a folder's rows are all notes and carry none (`kind` absent).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    Note,
    Task,
    Inbox,
}

/// One row of a view (`NoteWithProperties`).
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: String,
    pub path: String,
    pub title: String,
    pub emoji: Option<String>,
    pub cover: Option<String>,
    /// A folder's row: its folder relative to the viewed one (`/`, `/2024`). A tag's row: the
    /// note's folder, the task's project, or empty.
    pub folder: String,
    pub tags: Vec<String>,
    /// Epoch milliseconds.
    pub created_at: Option<i64>,
    pub modified_at: Option<i64>,
    pub word_count: u32,
    pub properties: Map<String, Value>,
    pub kind: Option<ItemKind>,
    pub file_type: String,
    /// The tag extending the viewed one that makes this row an object.
    pub via_tag: Option<String>,
}

/// A page of a folder's rows.
#[derive(Debug, Clone, PartialEq)]
pub struct RowsPage {
    pub rows: Vec<Row>,
    pub total: u32,
    pub has_more: bool,
}

/// Which rows of a tag with fields (`rows`): its objects, or the items that only mention it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RowSet {
    #[default]
    Objects,
    Mentions,
}

/// A property and how many listed notes hold it (`AvailableProperty`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertyCount {
    pub name: String,
    pub type_name: String,
    pub usage_count: u32,
}

/// `computeRelativeFolder`: the note's folder below `viewed`, `/` for one directly in it.
pub fn relative_folder(note_path: &str, viewed: &str) -> String {
    let dir = note_path.rsplit_once('/').map_or("", |(dir, _)| dir);
    if viewed.is_empty() {
        return format!("/{dir}");
    }
    if dir == viewed {
        return "/".to_owned();
    }
    match dir
        .strip_prefix(viewed)
        .and_then(|rest| rest.strip_prefix('/'))
    {
        Some(below) => format!("/{below}"),
        None => "/".to_owned(),
    }
}

/// The folder a note is the own page of (`pairedFolderPath`, `@memry/shared/folder-note`): note
/// `X.md` pairs with its sibling folder `X/`, by exact name. `None` for a file that is not
/// markdown or a journal day.
pub fn paired_folder_path<'a>(path: &'a str, file_type: &str, journal: bool) -> Option<&'a str> {
    if file_type != "markdown" || journal {
        return None;
    }
    let name_start = path.rfind('/').map_or(0, |at| at + 1);
    match path.rfind('.') {
        Some(dot) if dot > name_start => Some(&path[..dot]),
        _ => Some(path),
    }
}

/// A note, task or inbox item carrying tags (`TagItem`).
#[derive(Debug, Clone, PartialEq)]
pub struct TagItem {
    pub id: String,
    pub kind: ItemKind,
    pub title: String,
    pub emoji: Option<String>,
    /// A note's vault path; `None` for a task or an inbox item.
    pub path: Option<String>,
    pub tags: Vec<String>,
    /// A note's folder (`None` at the vault root), a task's project.
    pub container: Option<String>,
    pub created_at: Option<i64>,
    pub modified_at: Option<i64>,
    pub file_type: String,
}

impl TagItem {
    /// `itemTagsMatch`: carries the tag keyed `key`, or a `/` tag under it.
    fn carries(&self, key: &str) -> bool {
        self.tags.iter().any(|raw| {
            let tag = tag_key(raw);
            tag == key || tag.strip_prefix(key).is_some_and(|r| r.starts_with('/'))
        })
    }

    /// `tagItemToRow`.
    pub fn into_row(self, properties: Map<String, Value>, via_tag: Option<String>) -> Row {
        let path = match (&self.path, self.kind) {
            (Some(path), ItemKind::Note) => path.clone(),
            (_, ItemKind::Note) => String::new(),
            (_, ItemKind::Task) => format!("/tasks/{}", self.id),
            (_, ItemKind::Inbox) => format!("/inbox/{}", self.id),
        };
        Row {
            id: self.id,
            path,
            title: self.title,
            emoji: self.emoji,
            cover: None,
            folder: self.container.unwrap_or_default(),
            tags: self.tags,
            created_at: self.created_at,
            modified_at: self.modified_at,
            word_count: 0,
            properties,
            kind: Some(self.kind),
            file_type: self.file_type,
            via_tag,
        }
    }
}

/// `listTagItems`: the items carrying `tag` or a `/` tag under it, and every one of `and_tags`
/// the same way (blank entries and the tag itself ignored).
pub fn tagged<'a>(items: &'a [TagItem], tag: &str, and_tags: &[String]) -> Vec<&'a TagItem> {
    let key = tag_key(tag);
    let extra: HashSet<String> = and_tags
        .iter()
        .map(|tag| tag_key(tag))
        .filter(|extra| !extra.is_empty() && *extra != key)
        .collect();
    items
        .iter()
        .filter(|item| item.carries(&key) && extra.iter().all(|e| item.carries(e)))
        .collect()
}

/// The live tasks and inbox items carrying a tag, tasks first, each with its tags as stored. A
/// task's container is its project's name.
pub fn tasks_and_inbox(data: &Connection) -> Result<Vec<TagItem>, StorageError> {
    let mut items = Vec::new();
    let mut tasks = data
        .prepare(
            "SELECT t.id, t.title, t.tags, p.name, t.created_at, t.modified_at FROM tasks t \
             LEFT JOIN projects p ON p.id = t.project_id \
             WHERE t.deleted_at IS NULL AND t.tags IS NOT NULL AND t.tags NOT IN ('', '[]')",
        )
        .map_err(failed)?;
    let rows = tasks
        .query_map([], |row| {
            let tags: String = row.get(2)?;
            Ok(TagItem {
                id: row.get(0)?,
                kind: ItemKind::Task,
                title: row.get(1)?,
                emoji: None,
                path: None,
                // A list that does not parse carries no tags rather than failing the view.
                tags: serde_json::from_str(&tags).unwrap_or_default(),
                container: row.get(3)?,
                created_at: row.get(4)?,
                modified_at: row.get(5)?,
                file_type: "markdown".to_owned(),
            })
        })
        .map_err(failed)?;
    for row in rows {
        items.push(row.map_err(failed)?);
    }
    let mut inbox = data
        .prepare(
            "SELECT i.id, i.title, json_group_array(g.tag), i.created_at, i.modified_at \
             FROM inbox_items i JOIN inbox_item_tags g ON g.item_id = i.id \
             WHERE i.deleted_at IS NULL GROUP BY i.id",
        )
        .map_err(failed)?;
    let rows = inbox
        .query_map([], |row| {
            let tags: String = row.get(2)?;
            Ok(TagItem {
                id: row.get(0)?,
                kind: ItemKind::Inbox,
                title: row.get(1)?,
                emoji: None,
                path: None,
                tags: serde_json::from_str(&tags).unwrap_or_default(),
                container: None,
                created_at: row.get(3)?,
                modified_at: row.get(4)?,
                file_type: "markdown".to_owned(),
            })
        })
        .map_err(failed)?;
    for row in rows {
        items.push(row.map_err(failed)?);
    }
    Ok(items)
}

/// Each note's properties as the note index holds them (`getPropertiesForNotes`), by id; `ids`
/// is a JSON array.
pub fn properties_of(
    index: &Connection,
    ids: &str,
) -> Result<HashMap<String, Map<String, Value>>, StorageError> {
    let mut statement = index
        .prepare(
            "SELECT note_id, name, value, type FROM note_properties \
             WHERE note_id IN (SELECT value FROM json_each(?1)) ORDER BY rowid",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([ids], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(failed)?;
    let mut by_note: HashMap<String, Map<String, Value>> = HashMap::new();
    for row in rows {
        let (id, name, text, type_name) = row.map_err(failed)?;
        let value = text.map_or(Value::Null, |text| indexed_value(text, &type_name));
        by_note.entry(id).or_default().insert(name, value);
    }
    Ok(by_note)
}

/// Each note's word count and cover as the note index measured them, by id; `ids` is a JSON
/// array.
pub fn stats_of(
    index: &Connection,
    ids: &str,
) -> Result<HashMap<String, (u32, Option<String>)>, StorageError> {
    let mut statement = index
        .prepare(
            "SELECT note_id, word_count, cover FROM note_stats \
             WHERE note_id IN (SELECT value FROM json_each(?1))",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([ids], |row| {
            let words: Option<i64> = row.get(1)?;
            let words = u32::try_from(words.unwrap_or(0)).unwrap_or(0);
            Ok((row.get::<_, String>(0)?, (words, row.get(2)?)))
        })
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

/// `fetchPropertyCounts` and `toAvailableProperties`: how many of the notes hold each property,
/// typed as the first holder types it, most used first (ties in the order first met).
pub fn property_counts<'a>(
    held: impl Iterator<Item = (&'a str, &'a str)>,
    fields: &[(String, String)],
) -> Vec<PropertyCount> {
    let mut counts: Vec<PropertyCount> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for (name, type_name) in held {
        match at.get(name) {
            Some(&i) => counts[i].usage_count += 1,
            None => {
                at.insert(name.to_owned(), counts.len());
                counts.push(PropertyCount {
                    name: name.to_owned(),
                    type_name: type_name.to_owned(),
                    usage_count: 1,
                });
            }
        }
    }
    // A tag's fields are columns before any note holds them.
    for (name, type_name) in fields {
        if !at.contains_key(name) {
            at.insert(name.clone(), counts.len());
            counts.push(PropertyCount {
                name: name.clone(),
                type_name: type_name.clone(),
                usage_count: 0,
            });
        }
    }
    counts.sort_by_key(|a| std::cmp::Reverse(a.usage_count));
    counts
}

/// The name and type of each field `tag` has, own or inherited (`fieldColumns`).
pub fn field_columns(tag: &str, resolved: &Resolved) -> Vec<(String, String)> {
    resolved
        .get(&tag_key(tag))
        .map(|entry| {
            entry
                .effective_fields
                .iter()
                .map(|field| (field.name.clone(), field.type_name.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// The tasks among `ids` with their tag fields (`listTaskFieldsForTags`), by id.
pub fn task_fields(
    data: &Connection,
    ids: &[&str],
) -> Result<HashMap<String, Map<String, Value>>, StorageError> {
    let mut statement = data
        .prepare("SELECT payload FROM sync_items WHERE item_type = 'task' AND item_id = ?1")
        .map_err(failed)?;
    let mut fields = HashMap::new();
    for id in ids {
        let payload: Option<String> = statement
            .query_row(params![id], |row| row.get(0))
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                error => Err(error),
            })
            .map_err(failed)?;
        let payload: Option<Value> = payload.and_then(|raw| serde_json::from_str(&raw).ok());
        let plain = versioned::plain(payload.as_ref().and_then(|p| p.get("fields")));
        fields.insert((*id).to_owned(), plain);
    }
    Ok(fields)
}

/// A tag's saved views, stored on its definition (`readTagViews`); `None` when it has none or
/// they do not parse, so a bad value never makes the tag unopenable.
pub fn tag_views(data: &Connection, tag: &str) -> Result<Option<Vec<Value>>, StorageError> {
    let key = tag_key(tag);
    let mut statement = data
        .prepare("SELECT name, views FROM tag_definitions WHERE deleted_at IS NULL")
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(failed)?;
    for row in rows {
        let (name, views) = row.map_err(failed)?;
        if tag_key(&name) != key {
            continue;
        }
        let parsed = views.and_then(|raw| match serde_json::from_str(&raw) {
            Ok(Value::Array(views)) => Some(views),
            _ => {
                eprintln!("memry-core: a tag's saved views do not parse; read as none");
                None
            }
        });
        return Ok(parsed);
    }
    Ok(None)
}

#[cfg(test)]
#[path = "folder_view_tests.rs"]
mod tests;
