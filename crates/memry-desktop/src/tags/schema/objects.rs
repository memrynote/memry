//! Object reads for tags with fields (`ipc/tag-object-handlers.ts`,
//! `packages/contracts/src/tag-objects-api.ts`): the `@` menu and relation picker search, and a
//! note's "Linked here" groups. The rules live in the core ([`memry_core::domain::tag_objects`]);
//! this checks the input as Electron's zod schemas do and shapes the answer.

use memry_core::api::errors::StorageError;
use memry_core::domain::tag_objects::{LinkedGroup, LinkedNote, LinkedTask, ObjectMatch, Resolved};
use memry_core::markdown::frontmatter::js_trim;
use serde::{Deserialize, Serialize};

use super::edit::length;
use super::{SchemaError, Schemas};

/// `SearchObjectsSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchObjectsInput {
    pub query: String,
    /// Only objects of this tag and the tags that extend it (a relation's target).
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `GetLinkedHereSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GetLinkedHereInput {
    pub note_id: String,
    #[serde(default)]
    pub limit_per_group: Option<u32>,
}

/// The most notes a Linked here group returns in one read (`LINKED_HERE_MAX_PER_GROUP`).
pub const LINKED_HERE_MAX_PER_GROUP: u32 = 500;

/// `ObjectMatch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectMatchView {
    pub note_id: String,
    pub title: String,
    pub tag: String,
    pub group_tag: String,
    pub via_tag: Option<String>,
    pub subtitle: Vec<String>,
    pub modified: String,
}

impl From<ObjectMatch> for ObjectMatchView {
    fn from(found: ObjectMatch) -> Self {
        Self {
            note_id: found.note_id,
            title: found.title,
            tag: found.tag,
            group_tag: found.group_tag,
            via_tag: found.via_tag,
            subtitle: found.subtitle,
            modified: found.modified,
        }
    }
}

/// `SearchObjectsResponse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct SearchObjectsView {
    pub matches: Vec<ObjectMatchView>,
    /// Always `true`: the note index has no row from before header tags were measured.
    pub complete: bool,
}

/// `LinkedNoteItem`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkedNoteView {
    pub note_id: String,
    pub title: String,
    pub date: Option<String>,
    pub snippet: Option<String>,
}

impl From<LinkedNote> for LinkedNoteView {
    fn from(note: LinkedNote) -> Self {
        Self {
            note_id: note.note_id,
            title: note.title,
            date: note.date,
            snippet: note.snippet,
        }
    }
}

/// `LinkedTaskItem`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkedTaskView {
    pub task_id: String,
    pub title: String,
    pub due_date: Option<String>,
    pub completed: bool,
}

impl From<LinkedTask> for LinkedTaskView {
    fn from(task: LinkedTask) -> Self {
        Self {
            task_id: task.task_id,
            title: task.title,
            due_date: task.due_date,
            completed: task.completed,
        }
    }
}

/// `LinkedHereGroup`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LinkedHereGroupView {
    #[serde(rename_all = "camelCase")]
    Relation {
        source_tag: String,
        field: String,
        label: String,
        total: u32,
        items: Vec<LinkedNoteView>,
        filter: String,
    },
    #[serde(rename_all = "camelCase")]
    TaskField {
        tag: String,
        field: String,
        total: u32,
        items: Vec<LinkedTaskView>,
        filter: String,
    },
    Mentions {
        total: u32,
        items: Vec<LinkedNoteView>,
    },
}

impl From<LinkedGroup> for LinkedHereGroupView {
    fn from(group: LinkedGroup) -> Self {
        match group {
            LinkedGroup::Relation {
                source_tag,
                field,
                label,
                total,
                items,
                filter,
            } => Self::Relation {
                source_tag,
                field,
                label,
                total,
                items: items.into_iter().map(Into::into).collect(),
                filter,
            },
            LinkedGroup::TaskField {
                tag,
                field,
                total,
                items,
                filter,
            } => Self::TaskField {
                tag,
                field,
                total,
                items: items.into_iter().map(Into::into).collect(),
                filter,
            },
            LinkedGroup::Mentions { total, items } => Self::Mentions {
                total,
                items: items.into_iter().map(Into::into).collect(),
            },
        }
    }
}

/// `GetLinkedHereResponse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct LinkedHereView {
    pub groups: Vec<LinkedHereGroupView>,
}

fn invalid(what: &str) -> SchemaError {
    StorageError::Invalid {
        what: what.to_owned(),
    }
    .into()
}

/// A count in `1..=max`, `default` when absent.
fn bounded(value: Option<u32>, default: u32, max: u32, what: &str) -> Result<usize, SchemaError> {
    match value.unwrap_or(default) {
        count @ 1.. if count <= max => Ok(count as usize),
        _ => Err(invalid(&format!("{what} must be 1 to {max}"))),
    }
}

impl Schemas {
    /// The resolved tags as the definitions stand, no pulled definition settled into the file:
    /// a keystroke never waits on a definition edit nor writes `properties.md`.
    fn read_resolved(&self) -> Result<Resolved, SchemaError> {
        self.resolved_by(self.definitions.read()?)
    }

    /// `tags:search-objects`.
    pub fn search_objects(
        &self,
        input: &SearchObjectsInput,
    ) -> Result<SearchObjectsView, SchemaError> {
        if length(&input.query) > 200 {
            return Err(invalid("a search must be at most 200 characters"));
        }
        let tag = input.tag.as_deref().map(js_trim);
        if tag.is_some_and(|tag| tag.is_empty() || length(tag) > 100) {
            return Err(invalid("a tag name must be 1 to 100 characters"));
        }
        let limit = bounded(input.limit, 12, 50, "a search limit")?;
        let matches =
            self.open
                .search
                .search_objects(&self.read_resolved()?, &input.query, tag, limit)?;
        Ok(SearchObjectsView {
            matches: matches.into_iter().map(Into::into).collect(),
            complete: true,
        })
    }

    /// `tags:get-linked-here`.
    pub fn linked_here(&self, input: &GetLinkedHereInput) -> Result<LinkedHereView, SchemaError> {
        if input.note_id.is_empty() {
            return Err(invalid("a note id is required"));
        }
        let limit = bounded(
            input.limit_per_group,
            2,
            LINKED_HERE_MAX_PER_GROUP,
            "a group limit",
        )?;
        let groups = self
            .open
            .search
            .linked_here(&self.read_resolved()?, &input.note_id, limit)?;
        Ok(LinkedHereView {
            groups: groups.into_iter().map(Into::into).collect(),
        })
    }
}
