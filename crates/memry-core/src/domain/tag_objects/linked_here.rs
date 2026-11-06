//! `getLinkedHere` (`tags/objects.ts`): what points at a note. Each note whose relation field
//! links it, grouped by the field and the tag that defines it; each task whose field links it,
//! grouped the same way; and the notes and journal days whose body wiki-links it.

use std::collections::{BTreeSet, HashMap};

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::journal_ops::links::id_list;
use crate::domain::notes::failed;
use crate::domain::property_values::{IndexedProperty, indexed_value};
use crate::domain::search::LinkChanges;
use crate::domain::tags::tag_key;
use crate::sync::versioned;

use super::{Resolved, mentioning, note_refs};

/// A note or journal day in a group (`LinkedNoteItem`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedNote {
    pub note_id: String,
    pub title: String,
    /// A journal day's date.
    pub date: Option<String>,
    pub snippet: Option<String>,
}

/// A task in a group (`LinkedTaskItem`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedTask {
    pub task_id: String,
    pub title: String,
    pub due_date: Option<String>,
    pub completed: bool,
}

/// One group of Linked here (`LinkedHereGroup`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkedGroup {
    Relation {
        /// The tag key that defines the field, `""` when no tag of the source does.
        source_tag: String,
        field: String,
        /// The relation's inverse label, else the source tag's name, else the field name.
        label: String,
        total: u32,
        items: Vec<LinkedNote>,
        /// The filter that opens the matching table rows.
        filter: String,
    },
    TaskField {
        /// The task tag key that defines the field, `""` when none does.
        tag: String,
        field: String,
        total: u32,
        items: Vec<LinkedTask>,
        filter: String,
    },
    Mentions {
        total: u32,
        items: Vec<LinkedNote>,
    },
}

/// A note or journal day as a group lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub date: Option<String>,
    /// ISO time.
    pub modified: String,
    pub snippet: Option<String>,
    /// Its file's header tags, in their order.
    pub header_tags: Vec<String>,
}

impl Summary {
    fn item(&self) -> LinkedNote {
        LinkedNote {
            note_id: self.id.clone(),
            title: self.title.clone(),
            date: self.date.clone(),
            snippet: self.snippet.clone(),
        }
    }
}

/// A task whose stored fields link the note.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskRow {
    pub id: String,
    pub title: String,
    pub due_date: Option<String>,
    pub completed: bool,
    pub tags: Vec<String>,
    /// The field map without its removals (`plainVersionedMap`).
    pub fields: serde_json::Map<String, Value>,
}

fn filter(field: &str, note_id: &str) -> String {
    format!("{field} contains \"memry://note/{note_id}\"")
}

/// Newest first: a day's date, else the modified time (`byNewest`).
fn newest_first(notes: &mut [&Summary]) {
    let key = |note: &Summary| note.date.clone().unwrap_or_else(|| note.modified.clone());
    notes.sort_by(|a, b| key(b).cmp(&key(a)).then_with(|| a.id.cmp(&b.id)));
}

fn total(len: usize) -> u32 {
    u32::try_from(len).unwrap_or(u32::MAX)
}

/// The tag among `tags` whose fields hold `field` (a relation one when `relation_only`), and
/// the label its relation gives the inverse list (`fieldOwner`).
fn field_owner(
    tags: &[String],
    field: &str,
    resolved: &Resolved,
    relation_only: bool,
) -> Option<(String, Option<String>)> {
    tags.iter().find_map(|tag| {
        let found = resolved
            .get(&tag_key(tag))?
            .effective_fields
            .iter()
            .find(|candidate| {
                candidate.name == field && (!relation_only || candidate.relation.is_some())
            })?;
        let label = found
            .relation
            .as_ref()
            .and_then(|relation| relation.inverse.clone())
            .or_else(|| resolved.get(&found.defined_by).map(|tag| tag.name.clone()));
        Some((found.defined_by.clone(), label))
    })
}

/// Each other note whose property links `note_id`, with the property, in the order the index
/// wrote them (`listIncomingNoteRefs`). Only markdown files have `note_properties` rows.
pub fn incoming_refs(
    index: &Connection,
    note_id: &str,
) -> Result<Vec<(String, String)>, StorageError> {
    let mut statement = index
        .prepare(
            "SELECT note_id, name, value, type FROM note_properties \
             WHERE note_id <> ?1 AND value LIKE ?2 ESCAPE '\\' ORDER BY rowid",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![note_id, mentioning(note_id)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(failed)?;
    let mut refs = Vec::new();
    for row in rows {
        let (source, name, text, type_name) = row.map_err(failed)?;
        if note_refs(&indexed_value(text, &type_name)).contains(&note_id) {
            refs.push((source, name));
        }
    }
    Ok(refs)
}

/// What writing `notes`' property rows changes in Linked here: each note whose relation values
/// gain or lose a note, and those notes. Read before the rows are replaced, in their
/// transaction, so the renderer is told once they are committed (`NoteLinksChangedEvent`).
pub(crate) fn relation_changes(
    index: &Connection,
    notes: &[(&str, &[IndexedProperty])],
) -> Result<LinkChanges, StorageError> {
    let mut statement = index
        .prepare(
            "SELECT note_id, value, type FROM note_properties \
             WHERE note_id IN (SELECT value FROM json_each(?1)) AND value LIKE '%memry://note/%'",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![id_list(notes.iter().map(|(id, _)| *id))?], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(failed)?;
    let mut before: HashMap<String, BTreeSet<String>> = HashMap::new();
    for row in rows {
        let (id, text, type_name) = row.map_err(failed)?;
        let value = indexed_value(text, &type_name);
        let refs = note_refs(&value).into_iter().map(str::to_owned);
        before.entry(id).or_default().extend(refs);
    }
    let mut changes = LinkChanges::default();
    for (id, properties) in notes {
        let after: BTreeSet<String> = properties
            .iter()
            .flat_map(|property| note_refs(&property.value))
            .map(str::to_owned)
            .collect();
        let before = before.remove(*id).unwrap_or_default();
        if before != after {
            changes.sources.insert((*id).to_owned());
            changes
                .targets
                .extend(before.symmetric_difference(&after).cloned());
        }
    }
    Ok(changes)
}

/// The relation groups (`kind: 'relation'`): `refs` from [`incoming_refs`], `sources` the live
/// notes among them that are not journal days, `headers` their files' header tags.
pub fn relation_groups(
    note_id: &str,
    refs: &[(String, String)],
    sources: &HashMap<String, Summary>,
    resolved: &Resolved,
    limit: usize,
) -> Vec<LinkedGroup> {
    let mut groups: Vec<(String, String, String, Vec<&Summary>)> = Vec::new();
    for (source, field) in refs {
        let Some(note) = sources.get(source) else {
            continue;
        };
        let (tag, label) =
            field_owner(&note.header_tags, field, resolved, true).unwrap_or_default();
        match groups.iter_mut().find(|(t, f, ..)| *t == tag && f == field) {
            Some((.., notes)) => notes.push(note),
            None => {
                let label = label.unwrap_or_else(|| field.clone());
                groups.push((tag, field.clone(), label, vec![note]));
            }
        }
    }
    groups
        .into_iter()
        .map(|(source_tag, field, label, mut notes)| {
            newest_first(&mut notes);
            LinkedGroup::Relation {
                source_tag,
                total: total(notes.len()),
                items: notes.iter().take(limit).map(|note| note.item()).collect(),
                filter: filter(&field, note_id),
                field,
                label,
            }
        })
        .collect()
}

/// Every unarchived live task whose stored field map links `note_id`, in the order the
/// projection holds them (`listTasksMentioningNoteInFields`).
pub fn tasks_mentioning(data: &Connection, note_id: &str) -> Result<Vec<TaskRow>, StorageError> {
    let mut statement = data
        .prepare(
            "SELECT t.id, t.title, t.due_date, t.completed_at IS NOT NULL, t.tags, s.payload \
             FROM tasks t JOIN sync_items s ON s.item_type = 'task' AND s.item_id = t.id \
             WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND s.deleted_at IS NULL \
               AND s.payload LIKE ?1 ESCAPE '\\' \
             ORDER BY t.rowid",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![mentioning(note_id)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(failed)?;
    let mut tasks = Vec::new();
    for row in rows {
        let (id, title, due_date, completed, tags, payload) = row.map_err(failed)?;
        // The LIKE only prefilters: a payload that does not read links nothing.
        let Ok(payload) = serde_json::from_str::<Value>(&payload) else {
            eprintln!("memry-core: task {id} payload will not read; left out of Linked here");
            continue;
        };
        let tags = match tags.map(|tags| serde_json::from_str(&tags)) {
            Some(Ok(tags)) => tags,
            Some(Err(error)) => {
                eprintln!(
                    "memry-core: task {id} tags will not read ({error}); no tag owns its fields"
                );
                Vec::new()
            }
            None => Vec::new(),
        };
        tasks.push(TaskRow {
            tags,
            fields: versioned::plain(payload.get("fields")),
            id,
            title,
            due_date,
            completed,
        });
    }
    Ok(tasks)
}

/// The task field groups (`kind: 'task-field'`): open tasks first, then by due date.
pub fn task_groups(
    note_id: &str,
    tasks: &[TaskRow],
    resolved: &Resolved,
    limit: usize,
) -> Vec<LinkedGroup> {
    let mut groups: Vec<(String, String, Vec<LinkedTask>)> = Vec::new();
    for task in tasks {
        for (field, value) in &task.fields {
            if !note_refs(value).contains(&note_id) {
                continue;
            }
            let tag = field_owner(&task.tags, field, resolved, false)
                .map(|(tag, _)| tag)
                .unwrap_or_default();
            let item = LinkedTask {
                task_id: task.id.clone(),
                title: task.title.clone(),
                due_date: task.due_date.clone(),
                completed: task.completed,
            };
            match groups.iter_mut().find(|(t, f, _)| *t == tag && f == field) {
                Some((.., items)) => items.push(item),
                None => groups.push((tag, field.clone(), vec![item])),
            }
        }
    }
    groups
        .into_iter()
        .map(|(tag, field, mut items)| {
            // A task with no due date sorts after every dated one.
            items.sort_by(|a, b| {
                let key = |t: &LinkedTask| (t.completed, t.due_date.is_none(), t.due_date.clone());
                key(a).cmp(&key(b))
            });
            LinkedGroup::TaskField {
                tag,
                total: total(items.len()),
                items: items.into_iter().take(limit).collect(),
                filter: filter(&field, note_id),
                field,
            }
        })
        .collect()
}

/// The wiki-link group (`kind: 'mentions'`), `None` when no other note links `note_id`.
pub fn mentions_group(mentions: &[Summary], limit: usize) -> Option<LinkedGroup> {
    if mentions.is_empty() {
        return None;
    }
    let mut notes: Vec<&Summary> = mentions.iter().collect();
    newest_first(&mut notes);
    Some(LinkedGroup::Mentions {
        total: total(notes.len()),
        items: notes.iter().take(limit).map(|note| note.item()).collect(),
    })
}
