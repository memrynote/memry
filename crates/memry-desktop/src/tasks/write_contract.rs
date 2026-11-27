//! The task write shapes of `packages/contracts/src/tasks-api.ts` (inputs) and of desktop's
//! `createTasksCommands` results (envelopes), camelCase.

use memry_core::domain::task_activity::{ActivityEntry, ActivityPage};
use memry_core::domain::tasks::{Patch, TaskPatch};
use memry_core::storage::repositories::instants;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::contract::{TaskListItemView, present};

/// `TaskCreateSchema`. Nullish fields are `None` for both absent and `null`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreateInput {
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub status_id: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub due_time: Option<String>,
    #[serde(default)]
    pub duration_minutes: Option<i64>,
    #[serde(default)]
    pub start_date: Option<String>,
    /// Derived from `repeatConfig`; a sent value is ignored.
    #[serde(default)]
    pub is_repeating: Option<bool>,
    #[serde(default)]
    pub repeat_config: Option<Value>,
    #[serde(default)]
    pub repeat_from: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub linked_note_ids: Option<Vec<String>>,
    #[serde(default)]
    pub linked_canvas_ids: Option<Vec<String>>,
    #[serde(default)]
    pub source_note_id: Option<String>,
    #[serde(default)]
    pub position: Option<i64>,
    #[serde(default)]
    pub fields: Option<Map<String, Value>>,
}

impl TaskCreateInput {
    /// The same bounds as a patch setting every field (`TaskCreateSchema` and
    /// `TaskUpdateSchema` share them), checked by core's [`TaskPatch::validate`].
    pub fn as_patch(&self) -> TaskPatch {
        let set = |value: &Option<String>| value.clone().map_or(Patch::Keep, Patch::Set);
        TaskPatch {
            title: Some(self.title.clone()),
            description: set(&self.description),
            priority: self.priority,
            due_date: set(&self.due_date),
            due_time: set(&self.due_time),
            duration_minutes: self.duration_minutes.map_or(Patch::Keep, Patch::Set),
            start_date: set(&self.start_date),
            repeat_config: self.repeat_config.clone().map_or(Patch::Keep, Patch::Set),
            repeat_from: set(&self.repeat_from),
            tags: self.tags.clone(),
            fields: self.fields.clone(),
            ..TaskPatch::default()
        }
    }
}

/// `TaskCompleteSchema`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompleteInput {
    pub id: String,
    /// An ISO instant (`z.iso.datetime()`); absent is now.
    #[serde(default)]
    pub completed_at: Option<String>,
    /// A completion recorded from elsewhere: closes without rolling a repeat series.
    #[serde(default)]
    pub record_only: Option<bool>,
}

/// `TaskMoveSchema`. Absent `targetStatusId`/`targetParentId` keep the value, `null` clears it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskMoveInput {
    pub task_id: String,
    #[serde(default)]
    pub target_project_id: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub target_status_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub target_parent_id: Option<Option<String>>,
    pub position: i64,
}

impl TaskMoveInput {
    pub fn patch(self) -> (String, TaskPatch) {
        let patch = |value: Option<Option<String>>| match value {
            None => Patch::Keep,
            Some(None) => Patch::Clear,
            Some(Some(id)) => Patch::Set(id),
        };
        let moved = TaskPatch {
            project_id: self.target_project_id,
            status_id: patch(self.target_status_id),
            parent_id: patch(self.target_parent_id),
            position: Some(self.position),
            named_status_wins: true,
            ..TaskPatch::default()
        };
        (self.task_id, moved)
    }
}

/// `TaskReorderSchema`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskReorderInput {
    pub task_ids: Vec<String>,
    pub positions: Vec<i64>,
}

/// `ConvertToSubtaskSchema`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConvertToSubtaskInput {
    pub task_id: String,
    pub parent_id: String,
}

/// `BulkIdsSchema`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct BulkIdsInput {
    pub ids: Vec<String>,
}

/// `BulkMoveSchema`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BulkMoveInput {
    pub ids: Vec<String>,
    pub project_id: String,
}

/// `TaskActivityListSchema`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivityListInput {
    pub task_id: String,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
    #[serde(default)]
    pub actions: Option<Vec<String>>,
}

/// The `{ success, error? }` envelope of a write that answers no task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct TaskAck {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

impl TaskAck {
    pub fn ok() -> Self {
        Self {
            success: true,
            error: None,
        }
    }

    pub fn refused(error: &str) -> Self {
        Self {
            success: false,
            error: Some(error.to_owned()),
        }
    }
}

/// `completeTask`'s envelope: `{ success, task, nextOccurrence }`, or the refusal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompletion {
    pub success: bool,
    pub task: Option<TaskListItemView>,
    pub next_occurrence: Option<TaskListItemView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

/// A bulk write's envelope: `{ success, count }`, or `{ success: false, error }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct BulkMutation {
    pub success: bool,
    pub count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

/// `TaskActivityEntry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivityEntryView {
    pub id: String,
    pub task_id: String,
    pub action: String,
    pub field: Option<String>,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub actor: String,
    pub is_this_device: bool,
    /// Empty for a row that carries no time.
    pub created_at: String,
}

impl From<ActivityEntry> for TaskActivityEntryView {
    fn from(entry: ActivityEntry) -> Self {
        Self {
            id: entry.id,
            task_id: entry.task_id,
            action: entry.action,
            field: entry.field,
            old_value: entry.old_value,
            new_value: entry.new_value,
            actor: entry.actor,
            is_this_device: entry.is_this_device,
            created_at: entry
                .created_at_ms
                .and_then(instants::to_iso8601)
                .unwrap_or_default(),
        }
    }
}

/// `TaskActivityListResponse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivityPageView {
    pub entries: Vec<TaskActivityEntryView>,
    pub total: i64,
    pub has_more: bool,
}

impl From<ActivityPage> for TaskActivityPageView {
    fn from(page: ActivityPage) -> Self {
        Self {
            entries: page.entries.into_iter().map(Into::into).collect(),
            total: i64::try_from(page.total).unwrap_or(i64::MAX),
            has_more: page.has_more,
        }
    }
}
