//! The reads behind objects, the notes a tag with fields makes into records of a kind
//! (`queries/tag-objects.ts`, `tag-schema-counts.ts`), and the object search and Linked here
//! over them ([`tag_objects`]). Not on the FFI surface: iOS keeps no
//! files.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::journal_ops::links::{Item, live_items};
use crate::domain::link_reads;
use crate::domain::note_properties;
use crate::domain::note_stats;
use crate::domain::notes::failed;
use crate::domain::property_values::indexed_value;
use crate::domain::tag_objects::linked_here::{self, Summary};
use crate::domain::tag_objects::search::{self, Candidate};
use crate::domain::tag_objects::{self, LinkedGroup, ObjectMatch, Resolved};
use crate::markdown::frontmatter::js::iso_string;

use super::Search;

impl Search {
    /// Every markdown note that is not a journal day, with its file's header tags in their
    /// order (Electron's `note_tags` rows with `in_header`, `objectRow`). A note's header is
    /// what makes it an object of a tag, never a body `#tag`.
    pub fn object_headers(&self) -> Result<Vec<(String, Vec<String>)>, StorageError> {
        let headers = self.index.read_blocking(note_stats::undated_header_tags)?;
        let markdown: HashSet<String> = self.data.read_blocking(|data| {
            let mut statement = data
                .prepare("SELECT note_id FROM note_files WHERE file_type = 'markdown'")
                .map_err(failed)?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(failed)?
                .collect::<Result<HashSet<_>, _>>()
                .map_err(failed)?;
            Ok(ids)
        })?;
        Ok(headers
            .into_iter()
            .filter(|(id, tags)| !tags.is_empty() && markdown.contains(id))
            .collect())
    }

    /// The objects whose title matches `query` (`searchObjects`): those of `tag` and the tags
    /// that extend it, or of every tag with fields, at most `limit` of them.
    pub fn search_objects(
        &self,
        resolved: &Resolved,
        query: &str,
        tag: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ObjectMatch>, StorageError> {
        let tags = match tag {
            Some(tag) => tag_objects::family_of(tag, resolved).unwrap_or_default(),
            None => tag_objects::field_tags(resolved),
        };
        if tags.is_empty() {
            return Ok(Vec::new());
        }
        let members = search::members(self.object_headers()?, &tags);
        let found = self.summaries(members.keys().map(String::as_str), false)?;
        let candidates = found
            .into_values()
            .filter(|note| note.date.is_none())
            .filter_map(|note| {
                Some(Candidate {
                    tag: members.get(&note.id)?.clone(),
                    id: note.id,
                    title: note.title,
                    modified: note.modified,
                })
            })
            .collect();
        let ranked = search::ranked(candidates, query, limit);

        let values: HashMap<String, HashMap<String, Value>> =
            self.index.read_blocking(|index| {
                ranked
                    .iter()
                    .map(|candidate| {
                        let values = note_properties::read(index, &candidate.id)?
                            .into_iter()
                            .filter_map(|p| Some((p.name, indexed_value(p.text?, &p.type_name))))
                            .collect();
                        Ok((candidate.id.clone(), values))
                    })
                    .collect()
            })?;
        let refs: Vec<&str> = values
            .values()
            .flat_map(HashMap::values)
            .flat_map(tag_objects::note_refs)
            .collect();
        let titles = self.summaries(refs.into_iter(), false)?;
        let title_of = |id: &str| {
            let note = titles.get(id)?;
            note.date.is_none().then(|| note.title.clone())
        };
        Ok(ranked
            .into_iter()
            .map(|candidate| {
                let subtitle = search::subtitle(
                    values.get(&candidate.id).unwrap_or(&HashMap::new()),
                    resolved.get(&candidate.tag),
                    title_of,
                );
                search::matched(candidate, subtitle, resolved)
            })
            .collect())
    }

    /// What points at the note `note_id` (`getLinkedHere`): the relation groups, the task field
    /// groups, then the notes and journal days whose body links it, at most `limit` items each.
    pub fn linked_here(
        &self,
        resolved: &Resolved,
        note_id: &str,
        limit: usize,
    ) -> Result<Vec<LinkedGroup>, StorageError> {
        let refs = self
            .index
            .read_blocking(|index| linked_here::incoming_refs(index, note_id))?;
        let sources: HashMap<String, Summary> = self
            .summaries(refs.iter().map(|(source, _)| source.as_str()), true)?
            .into_iter()
            .filter(|(_, note)| note.date.is_none())
            .collect();
        let headers = self.index.read_blocking(|index| {
            tag_objects::measured(index, sources.keys().map(String::as_str))
        })?;
        let headers = headers
            .into_iter()
            .map(|(id, measured)| (id, measured.header_tags))
            .collect();
        let mut groups =
            linked_here::relation_groups(note_id, &refs, &sources, &headers, resolved, limit);

        let tasks = self
            .data
            .read_blocking(|data| linked_here::tasks_mentioning(data, note_id))?;
        groups.extend(linked_here::task_groups(note_id, &tasks, resolved, limit));

        let linking = self
            .index
            .read_blocking(|index| link_reads::linking_ids(index, note_id))?;
        let mentions: Vec<Summary> = self
            .summaries(linking.iter().map(String::as_str), true)?
            .into_values()
            .filter(|note| note.id != note_id)
            .collect();
        groups.extend(linked_here::mentions_group(&mentions, limit));
        Ok(groups)
    }

    /// The live notes and journal days among `ids`, a day titled by its date, with the snippet
    /// the note index measured when `snippets`.
    fn summaries<'a>(
        &self,
        ids: impl Iterator<Item = &'a str>,
        snippets: bool,
    ) -> Result<HashMap<String, Summary>, StorageError> {
        let ids: Vec<&str> = ids.collect();
        let live = self
            .data
            .read_blocking(|data| live_items(data, ids.iter().copied()))?;
        let mut measured = if snippets {
            self.index.read_blocking(|index| {
                tag_objects::measured(index, live.keys().map(String::as_str))
            })?
        } else {
            HashMap::new()
        };
        Ok(live
            .into_iter()
            .map(|(id, source)| {
                let (title, date, stamp) = match source.item {
                    Item::Note { title, stamp } => (title, None, stamp),
                    Item::Journal { date, stamp } => (date.clone(), Some(date), stamp),
                };
                let snippet = measured.remove(&id).and_then(|m| m.snippet);
                let summary = Summary {
                    id: id.clone(),
                    title,
                    date,
                    modified: iso_string(stamp),
                    snippet,
                };
                (id, summary)
            })
            .collect())
    }
}
