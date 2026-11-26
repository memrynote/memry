//! The project shapes of `packages/contracts/src/tasks-api.ts` (inputs) and of
//! `packages/domain-tasks/src/types.ts` (`Project`, `ProjectWithStats`, `ProjectWithStatuses`,
//! `ProjectLink`, `ProjectContents`, `ProjectRef`), camelCase.

use memry_core::api::task_store::StoredProject;
use memry_core::domain::projects::{
    LinkedEvent, LinkedFile, LinkedNote, ProjectContents, ProjectLink, ProjectRef, ProjectSummary,
    Status,
};
use serde::{Deserialize, Serialize};

use super::contract::{StatusView, present};

/// `Project`. A stamp the row does not carry is empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub icon: Option<String>,
    pub position: i64,
    pub is_inbox: bool,
    pub created_at: String,
    pub modified_at: String,
    pub archived_at: Option<String>,
    pub home_note_id: Option<String>,
}

impl From<StoredProject> for ProjectView {
    fn from(stored: StoredProject) -> Self {
        let project = stored.project;
        Self {
            id: project.id,
            name: project.name,
            description: project.description,
            color: project.color,
            icon: project.icon,
            position: project.position,
            is_inbox: project.is_inbox,
            created_at: stored.created_at.unwrap_or_default(),
            modified_at: stored.modified_at.unwrap_or_default(),
            archived_at: project.archived_at,
            home_note_id: project.home_note_id,
        }
    }
}

/// `ProjectWithStats`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWithStatsView {
    #[serde(flatten)]
    pub project: ProjectView,
    pub task_count: i64,
    pub completed_count: i64,
    pub overdue_count: i64,
}

impl From<(StoredProject, ProjectSummary)> for ProjectWithStatsView {
    fn from((project, summary): (StoredProject, ProjectSummary)) -> Self {
        Self {
            project: project.into(),
            task_count: summary.task_count,
            completed_count: summary.completed_count,
            overdue_count: summary.overdue_count,
        }
    }
}

/// `tasks:project-list`'s `{ projects }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ProjectListView {
    pub projects: Vec<ProjectWithStatsView>,
}

/// `ProjectWithStatuses`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWithStatusesView {
    #[serde(flatten)]
    pub project: ProjectView,
    pub statuses: Vec<StatusView>,
}

impl From<(StoredProject, Vec<Status>)> for ProjectWithStatusesView {
    fn from((project, statuses): (StoredProject, Vec<Status>)) -> Self {
        Self {
            project: project.into(),
            statuses: statuses.into_iter().map(Into::into).collect(),
        }
    }
}

/// The `withDb` envelope of a project write: `{ success, project?, error? }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMutation {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub project: Option<ProjectWithStatusesView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

impl ProjectMutation {
    pub fn ok(project: Option<ProjectWithStatusesView>) -> Self {
        Self {
            success: true,
            project,
            error: None,
        }
    }

    pub fn refused(error: &str) -> Self {
        Self {
            success: false,
            project: None,
            error: Some(error.to_owned()),
        }
    }
}

/// `StatusInputSchema` (create) and `StatusUpsertSchema` (update, with `id`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatusInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    /// `#6b7280` when absent.
    #[serde(default)]
    pub color: Option<String>,
    /// `todo`, `in_progress` or `done`.
    #[serde(rename = "type")]
    pub status_type: String,
    pub order: i64,
}

/// `ProjectCreateSchema`. Nullish fields are `None` for both absent and `null`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreateInput {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub statuses: Option<Vec<ProjectStatusInput>>,
}

/// `ProjectUpdateSchema`. On `description` and `icon` an absent key keeps the value and `null`
/// clears it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdateInput {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub icon: Option<Option<String>>,
    #[serde(default)]
    pub statuses: Option<Vec<ProjectStatusInput>>,
}

/// `ProjectReorderSchema`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReorderInput {
    pub project_ids: Vec<String>,
    pub positions: Vec<i64>,
}

/// `ProjectLinkItemSchema`; `itemType` is `note`, `calendar_event` or `file`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLinkItemInput {
    pub project_id: String,
    pub item_type: String,
    pub item_id: String,
}

/// `ProjectSetHomeNoteSchema`; `null` clears the home note.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSetHomeNoteInput {
    pub project_id: String,
    pub note_id: Option<String>,
}

/// `ProjectSetLinkPinnedSchema`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSetLinkPinnedInput {
    pub project_id: String,
    pub item_id: String,
    pub pinned: bool,
}

/// `ProjectListForItemSchema`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListForItemInput {
    pub item_type: String,
    pub item_id: String,
}

/// `ProjectLink`. `createdAt` is empty for an entry that carries none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLinkView {
    pub id: String,
    pub project_id: String,
    pub item_type: String,
    pub item_id: String,
    pub position: i64,
    pub created_at: String,
}

impl From<ProjectLink> for ProjectLinkView {
    fn from(link: ProjectLink) -> Self {
        Self {
            id: link.id,
            project_id: link.project_id,
            item_type: link.item_type,
            item_id: link.item_id,
            position: link.position,
            created_at: link.created_at.unwrap_or_default(),
        }
    }
}

/// `ProjectLinkedNote`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLinkedNoteView {
    pub id: String,
    pub title: String,
    pub emoji: Option<String>,
    pub modified_at: String,
    pub pinned: bool,
}

/// `ProjectLinkedFile`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLinkedFileView {
    pub id: String,
    pub title: String,
    pub file_type: String,
    pub mime_type: Option<String>,
    pub file_size: Option<i64>,
    pub modified_at: String,
}

/// `ProjectLinkedEvent`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLinkedEventView {
    pub id: String,
    pub title: String,
    pub start_at: String,
    pub end_at: Option<String>,
    pub is_all_day: bool,
}

/// `ProjectContents['counts']`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ProjectContentCounts {
    pub notes: i64,
    pub files: i64,
    pub events: i64,
}

/// `ProjectContents`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ProjectContentsView {
    pub notes: Vec<ProjectLinkedNoteView>,
    pub files: Vec<ProjectLinkedFileView>,
    pub events: Vec<ProjectLinkedEventView>,
    pub counts: ProjectContentCounts,
}

impl From<ProjectContents> for ProjectContentsView {
    fn from(contents: ProjectContents) -> Self {
        let count = |n: usize| i64::try_from(n).unwrap_or(i64::MAX);
        let counts = ProjectContentCounts {
            notes: count(contents.notes.len()),
            files: count(contents.files.len()),
            events: count(contents.events.len()),
        };
        Self {
            notes: contents.notes.into_iter().map(note).collect(),
            files: contents.files.into_iter().map(file).collect(),
            events: contents.events.into_iter().map(event).collect(),
            counts,
        }
    }
}

fn note(note: LinkedNote) -> ProjectLinkedNoteView {
    ProjectLinkedNoteView {
        id: note.id,
        title: note.title,
        emoji: note.emoji,
        modified_at: note.modified_at.unwrap_or_default(),
        pinned: note.pinned,
    }
}

fn file(file: LinkedFile) -> ProjectLinkedFileView {
    ProjectLinkedFileView {
        id: file.id,
        title: file.title,
        file_type: file.file_type,
        mime_type: file.mime_type,
        file_size: file.file_size,
        modified_at: file.modified_at.unwrap_or_default(),
    }
}

fn event(event: LinkedEvent) -> ProjectLinkedEventView {
    ProjectLinkedEventView {
        id: event.id,
        title: event.title,
        start_at: event.start_at,
        end_at: event.end_at,
        is_all_day: event.is_all_day,
    }
}

/// `ProjectRef`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ProjectRefView {
    pub id: String,
    pub name: String,
    pub color: String,
    pub icon: Option<String>,
}

impl From<ProjectRef> for ProjectRefView {
    fn from(project: ProjectRef) -> Self {
        Self {
            id: project.id,
            name: project.name,
            color: project.color,
            icon: project.icon,
        }
    }
}
