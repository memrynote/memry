//! The reads behind a folder view and a tag's table ([`folder_view`]). Not on the FFI surface:
//! iOS keeps no files.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::domain::folder_view::{
    self, ItemKind, PropertyCount, Row, RowSet, RowsPage, TagItem, paired_folder_path,
};
use crate::domain::journal_ops::links::id_list;
use crate::domain::note_list::{self, ListedNote, NoteListQuery, NoteSort};
use crate::domain::note_stats;
use crate::domain::notes::failed;
use crate::domain::tag_objects::{self, Resolved};
use crate::domain::tag_reads;
use crate::domain::tags::tag_key;

use super::Search;

/// The rows of a tag with fields, and whether every file's header was read.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldRows {
    pub rows: Vec<Row>,
    pub complete: bool,
}

impl Search {
    /// A page of `folder`'s rows (`""`: the vault root), oldest change first, the folder's own
    /// note after the last ([`paired_folder_path`]), so offsets taken from the rows a caller
    /// received keep lining up with the query.
    pub fn folder_rows(
        &self,
        folder: &str,
        limit: u32,
        offset: u32,
    ) -> Result<RowsPage, StorageError> {
        let query = NoteListQuery {
            folder: Some(folder.to_owned()),
            sort: NoteSort::Modified,
            ascending: true,
            limit,
            offset,
            ..NoteListQuery::default()
        };
        let folder_owned = folder.to_owned();
        let (page, own) = self.data.read_blocking(move |data| {
            let page = note_list::list(data, &query)?;
            let own = folder_note(data, &folder_owned)?;
            Ok((page, own))
        })?;
        let mut notes = page.notes;
        if !page.has_more {
            notes.extend(own.clone());
        }
        let total = page.total.saturating_add(u32::from(own.is_some()));
        let rows = self.note_rows(notes, folder)?;
        Ok(RowsPage {
            rows,
            total,
            has_more: page.has_more,
        })
    }

    /// The ids of every note `folder`'s view lists, its own note included.
    pub fn folder_note_ids(&self, folder: &str) -> Result<Vec<String>, StorageError> {
        let folder = folder.to_owned();
        self.data.read_blocking(move |data| {
            let mut ids = note_list::ids(data, Some(folder.as_str()))?;
            ids.extend(folder_note(data, &folder)?.map(|note| note.id));
            Ok(ids)
        })
    }

    /// Listed notes as a folder's rows: the tags the tag list counts, the index's properties,
    /// word count and cover.
    fn note_rows(&self, notes: Vec<ListedNote>, folder: &str) -> Result<Vec<Row>, StorageError> {
        if notes.is_empty() {
            return Ok(Vec::new());
        }
        let ids = id_list(notes.iter().map(|note| note.id.as_str()))?;
        let tags = self.tags_of_notes(notes.iter().map(|note| note.id.clone()).collect())?;
        let (mut properties, mut stats) = self.index.read_blocking(move |index| {
            Ok((
                folder_view::properties_of(index, &ids)?,
                folder_view::stats_of(index, &ids)?,
            ))
        })?;
        Ok(notes
            .into_iter()
            .map(|note| {
                let (word_count, cover) = stats.remove(&note.id).unwrap_or_default();
                Row {
                    folder: folder_view::relative_folder(&note.path, folder),
                    tags: tags.get(&note.id).cloned().unwrap_or(note.tags),
                    properties: properties.remove(&note.id).unwrap_or_default(),
                    word_count,
                    cover,
                    id: note.id,
                    path: note.path,
                    title: note.title,
                    emoji: note.emoji,
                    created_at: note.created_at,
                    modified_at: note.modified_at,
                    kind: None,
                    file_type: note.file_type,
                    via_tag: None,
                }
            })
            .collect())
    }

    /// Every filed note and journal day, task and inbox item that carries a tag.
    fn tag_items(&self) -> Result<Vec<TagItem>, StorageError> {
        let files = self.index.read_blocking(note_stats::file_tags)?;
        self.data.read_blocking(move |data| {
            let file_types = file_types(data)?;
            let mut items: Vec<TagItem> = tag_reads::filed_notes(data, &files)?
                .into_iter()
                .filter(|note| !note.tags.is_empty())
                .map(|note| TagItem {
                    file_type: file_types
                        .get(&note.id)
                        .cloned()
                        .unwrap_or_else(|| "markdown".to_owned()),
                    container: note.path.rsplit_once('/').map(|(dir, _)| dir.to_owned()),
                    kind: ItemKind::Note,
                    path: Some(note.path),
                    id: note.id,
                    title: note.title,
                    emoji: note.emoji,
                    tags: note.tags,
                    created_at: note.created_at,
                    modified_at: note.modified_at,
                })
                .collect();
            items.extend(folder_view::tasks_and_inbox(data)?);
            Ok(items)
        })
    }

    /// The items carrying `tag` (or a `/` tag under it) and each of `and_tags`.
    pub fn tag_rows(&self, tag: &str, and_tags: &[String]) -> Result<Vec<Row>, StorageError> {
        let items = self.tag_items()?;
        let picked: Vec<TagItem> = folder_view::tagged(&items, tag, and_tags)
            .into_iter()
            .cloned()
            .collect();
        let mut values = self.item_properties(&picked)?;
        Ok(picked
            .into_iter()
            .map(|item| {
                let properties = values.remove(&item.id).unwrap_or_default();
                item.into_row(properties, None)
            })
            .collect())
    }

    /// The ids of the notes among the items carrying `tag` and each of `and_tags`.
    pub fn tag_note_ids(
        &self,
        tag: &str,
        and_tags: &[String],
    ) -> Result<Vec<String>, StorageError> {
        let items = self.tag_items()?;
        Ok(folder_view::tagged(&items, tag, and_tags)
            .into_iter()
            .filter(|item| item.kind == ItemKind::Note)
            .map(|item| item.id.clone())
            .collect())
    }

    /// `listFieldTagRows`: the objects of `tag` and the tags that extend it, or the items that
    /// only mention them, `None` when `tag` has no fields. An item is an object of the first
    /// family tag its header (a task: its tags) carries, the tag itself first.
    pub fn field_tag_rows(
        &self,
        resolved: &Resolved,
        tag: &str,
        and_tags: &[String],
        set: RowSet,
    ) -> Result<Option<FieldRows>, StorageError> {
        let Some(family) = tag_objects::family_of(tag, resolved) else {
            return Ok(None);
        };
        let own = family[0].clone();
        let in_family: HashSet<&str> = family.iter().map(String::as_str).collect();
        let mut headers: HashMap<String, Vec<String>> = HashMap::new();
        for (id, header) in self.object_headers()? {
            let members: Vec<String> = header
                .iter()
                .map(|tag| tag_key(tag))
                .filter(|key| in_family.contains(key.as_str()))
                .collect();
            if !members.is_empty() {
                headers.insert(id, members);
            }
        }
        let items = self.tag_items()?;
        let member_of = |item: &TagItem| -> Option<String> {
            let tags: Vec<String> = match item.kind {
                ItemKind::Inbox => return None,
                ItemKind::Note => headers.get(&item.id).cloned().unwrap_or_default(),
                ItemKind::Task => item
                    .tags
                    .iter()
                    .map(|tag| tag_key(tag))
                    .filter(|key| in_family.contains(key.as_str()))
                    .collect(),
            };
            if tags.contains(&own) {
                Some(own.clone())
            } else {
                tags.into_iter().next()
            }
        };
        let mut seen = HashSet::new();
        let mut picked: Vec<(TagItem, Option<String>)> = Vec::new();
        for (index, member) in family.iter().enumerate() {
            for item in folder_view::tagged(&items, member, and_tags) {
                if seen.contains(&(item.kind as u8, item.id.as_str())) {
                    continue;
                }
                let via = member_of(item);
                if index > 0 && via.is_none() {
                    continue;
                }
                seen.insert((item.kind as u8, item.id.as_str()));
                if via.is_some() == (set == RowSet::Objects) {
                    picked.push((item.clone(), via));
                }
            }
        }
        let mut note_values = self.item_properties(picked.iter().map(|(item, _)| item))?;
        let task_ids = id_list(
            picked
                .iter()
                .filter(|(item, _)| item.kind == ItemKind::Task)
                .map(|(item, _)| item.id.as_str()),
        )?;
        let mut task_values = self
            .data
            .read_blocking(move |data| folder_view::task_fields(data, &task_ids))?;
        let rows = picked
            .into_iter()
            .map(|(item, via)| {
                let properties = match item.kind {
                    ItemKind::Note => note_values.remove(&item.id).unwrap_or_default(),
                    ItemKind::Task => task_values.remove(&item.id).unwrap_or_default(),
                    ItemKind::Inbox => Map::new(),
                };
                let via = via.filter(|via| *via != own);
                item.into_row(properties, via)
            })
            .collect();
        // The header of every file is read before the note index answers; nothing is pending.
        Ok(Some(FieldRows {
            rows,
            complete: true,
        }))
    }

    /// The index's properties of the notes among `items`, by id.
    fn item_properties<'a>(
        &self,
        items: impl IntoIterator<Item = &'a TagItem>,
    ) -> Result<HashMap<String, Map<String, Value>>, StorageError> {
        let ids = id_list(
            items
                .into_iter()
                .filter(|item| item.kind == ItemKind::Note)
                .map(|item| item.id.as_str()),
        )?;
        self.index
            .read_blocking(move |index| folder_view::properties_of(index, &ids))
    }

    /// How many of the notes `ids` hold each property, `fields` added unheld
    /// ([`folder_view::property_counts`]).
    pub fn property_counts(
        &self,
        ids: &[String],
        fields: &[(String, String)],
    ) -> Result<Vec<PropertyCount>, StorageError> {
        let list = id_list(ids.iter().map(String::as_str))?;
        let held: Vec<(String, String)> = self.index.read_blocking(move |index| {
            let mut statement = index
                .prepare(
                    "SELECT name, type FROM note_properties \
                     WHERE note_id IN (SELECT value FROM json_each(?1)) ORDER BY rowid",
                )
                .map_err(failed)?;
            let rows = statement
                .query_map([&list], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(failed)?;
            rows.collect::<Result<_, _>>().map_err(failed)
        })?;
        Ok(folder_view::property_counts(
            held.iter()
                .map(|(name, type_name)| (name.as_str(), type_name.as_str())),
            fields,
        ))
    }
}

/// The live markdown note beside `folder` that is its own page, when there is one.
fn folder_note(
    data: &rusqlite::Connection,
    folder: &str,
) -> Result<Option<ListedNote>, StorageError> {
    if folder.is_empty() {
        return Ok(None);
    }
    let prefix = format!("{folder}.");
    let mut statement = data
        .prepare(
            "SELECT f.note_id, f.path, f.file_type FROM note_files f \
             JOIN notes n ON n.id = f.note_id AND n.deleted_at IS NULL \
             WHERE substr(f.path, 1, length(?1)) = ?1 ORDER BY f.path",
        )
        .map_err(failed)?;
    let candidates = statement
        .query_map([&prefix], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    for (id, path, file_type) in candidates {
        if paired_folder_path(&path, &file_type, false) == Some(folder) {
            return note_list::by_id(data, &id);
        }
    }
    Ok(None)
}

/// Each filed note's file type, by id.
fn file_types(data: &rusqlite::Connection) -> Result<HashMap<String, String>, StorageError> {
    let mut statement = data
        .prepare("SELECT note_id, file_type FROM note_files")
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}
