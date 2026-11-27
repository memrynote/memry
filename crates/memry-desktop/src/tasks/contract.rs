//! The task wire shapes of `packages/domain-tasks/src/types.ts` and the argument structs of
//! `packages/contracts/src/tasks-api.ts`, field for field, camelCase.

use memry_core::domain::projects::Status;
use memry_core::domain::task_records::TaskRecord;
use memry_core::domain::tasks::list::{self, ListQuery, Match, SortBy, TagCount, TaskPage};
use memry_core::domain::tasks::stats::TaskStats;
use memry_core::domain::tasks::{Patch, TaskPatch};
use serde::de::{DeserializeOwned, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `Task`. `createdAt`/`modifiedAt` are empty for a payload that carries none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub id: String,
    pub project_id: String,
    pub status_id: Option<String>,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub priority: i64,
    pub position: i64,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub duration_minutes: Option<i64>,
    pub start_date: Option<String>,
    pub is_repeating: bool,
    pub repeat_config: Option<Value>,
    pub repeat_from: Option<String>,
    pub source_note_id: Option<String>,
    pub completed_at: Option<String>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub modified_at: String,
    pub tags: Vec<String>,
    pub linked_note_ids: Vec<String>,
    pub linked_canvas_ids: Vec<String>,
    pub fields: Map<String, Value>,
}

impl From<TaskRecord> for TaskView {
    fn from(task: TaskRecord) -> Self {
        let is_repeating = task.is_repeating();
        Self {
            id: task.id,
            project_id: task.project_id,
            status_id: task.status_id,
            parent_id: task.parent_id,
            title: task.title,
            description: task.description,
            priority: task.priority,
            position: task.position,
            due_date: task.due_date,
            due_time: task.due_time,
            duration_minutes: task.duration_minutes,
            start_date: task.start_date,
            is_repeating,
            repeat_config: task.repeat_config,
            repeat_from: task.repeat_from,
            source_note_id: task.source_note_id,
            completed_at: task.completed_at,
            archived_at: task.archived_at,
            created_at: task.created_at.unwrap_or_default(),
            modified_at: task.modified_at.unwrap_or_default(),
            tags: task.tags,
            linked_note_ids: task.linked_note_ids,
            linked_canvas_ids: task.linked_canvas_ids,
            fields: task.fields,
        }
    }
}

/// `TaskListItem`: the task and its direct subtasks' counts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskListItemView {
    #[serde(flatten)]
    pub task: TaskView,
    pub has_subtasks: bool,
    pub subtask_count: i64,
    pub completed_subtask_count: i64,
}

impl From<list::TaskListItem> for TaskListItemView {
    fn from(item: list::TaskListItem) -> Self {
        Self {
            has_subtasks: item.has_subtasks(),
            subtask_count: item.subtask_count,
            completed_subtask_count: item.completed_subtask_count,
            task: item.task.into(),
        }
    }
}

/// `TaskListResponse`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskPageView {
    pub tasks: Vec<TaskListItemView>,
    pub total: i64,
    pub has_more: bool,
}

impl From<TaskPage> for TaskPageView {
    fn from(page: TaskPage) -> Self {
        Self {
            tasks: page.tasks.into_iter().map(Into::into).collect(),
            total: page.total,
            has_more: page.has_more,
        }
    }
}

/// `TaskStats`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatsView {
    pub total: i64,
    pub completed: i64,
    pub overdue: i64,
    pub due_today: i64,
    pub due_this_week: i64,
}

impl From<TaskStats> for TaskStatsView {
    fn from(stats: TaskStats) -> Self {
        Self {
            total: stats.total,
            completed: stats.completed,
            overdue: stats.overdue,
            due_today: stats.due_today,
            due_this_week: stats.due_this_week,
        }
    }
}

/// One entry of `tasks:get-tags`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct TaskTagCount {
    pub tag: String,
    pub count: i64,
}

impl From<TagCount> for TaskTagCount {
    fn from(tag: TagCount) -> Self {
        Self {
            tag: tag.tag,
            count: tag.count,
        }
    }
}

/// `Status`. `createdAt` is empty for an entry that carries none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub color: String,
    pub position: i64,
    pub is_default: bool,
    pub is_done: bool,
    pub created_at: String,
}

impl From<Status> for StatusView {
    fn from(status: Status) -> Self {
        Self {
            id: status.id,
            project_id: status.project_id,
            name: status.name,
            color: status.color,
            position: status.position,
            is_default: status.is_default,
            is_done: status.is_done,
            created_at: status.created_at.unwrap_or_default(),
        }
    }
}

/// The `withDb` envelope of a task write: `{ success, task, error }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskMutation {
    pub success: bool,
    pub task: Option<TaskListItemView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

/// The `withDb` envelope of a status write: `{ success, status?, error? }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusMutation {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub status: Option<StatusView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

impl StatusMutation {
    pub fn ok(status: Option<StatusView>) -> Self {
        Self {
            success: true,
            status,
            error: None,
        }
    }

    pub fn refused(error: &str) -> Self {
        Self {
            success: false,
            status: None,
            error: Some(error.to_owned()),
        }
    }
}

/// `TaskListSchema.sortBy`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TaskSortBy {
    #[default]
    Position,
    DueDate,
    Priority,
    Created,
    Modified,
}

/// `TaskListSchema.sortOrder`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TaskSortOrder {
    #[default]
    Asc,
    Desc,
}

/// `TaskListSchema`. Absent `statusId`/`parentId` match any value, `null` matches none.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskListInput {
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub status_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub parent_id: Option<Option<String>>,
    #[serde(default)]
    pub include_completed: Option<bool>,
    #[serde(default)]
    pub include_archived: Option<bool>,
    #[serde(default)]
    pub due_before: Option<String>,
    #[serde(default)]
    pub due_after: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// Accepted and ignored, as desktop's `listTasks` reads no search.
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub sort_by: Option<TaskSortBy>,
    #[serde(default)]
    pub sort_order: Option<TaskSortOrder>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

impl TaskListInput {
    /// The query after zod's defaults; `Err` names the check `TaskListSchema` fails
    /// (`limit` 1 to 1000, `offset` at least 0).
    pub fn query(self) -> Result<ListQuery, &'static str> {
        let limit = self.limit.unwrap_or(100);
        if !(1..=1000).contains(&limit) {
            return Err("limit must be 1 to 1000");
        }
        let offset = self.offset.unwrap_or(0);
        if offset < 0 {
            return Err("offset must be at least 0");
        }
        let matching = |value: Option<Option<String>>| match value {
            None => Match::Any,
            Some(None) => Match::Null,
            Some(Some(id)) => Match::Is(id),
        };
        Ok(ListQuery {
            project_id: self.project_id,
            status_id: matching(self.status_id),
            parent_id: matching(self.parent_id),
            include_completed: self.include_completed.unwrap_or(false),
            include_archived: self.include_archived.unwrap_or(false),
            due_before: self.due_before,
            due_after: self.due_after,
            tags: self.tags.unwrap_or_default(),
            sort_by: match self.sort_by.unwrap_or_default() {
                TaskSortBy::Position => SortBy::Position,
                TaskSortBy::DueDate => SortBy::DueDate,
                TaskSortBy::Priority => SortBy::Priority,
                TaskSortBy::Created => SortBy::Created,
                TaskSortBy::Modified => SortBy::Modified,
            },
            descending: matches!(self.sort_order, Some(TaskSortOrder::Desc)),
            limit: u32::try_from(limit).map_err(|_| "limit must be 1 to 1000")?,
            offset: u32::try_from(offset).map_err(|_| "offset is too large")?,
        })
    }
}

/// `TaskUpdateSchema`. A nullish field is absent (keep), `null` (clear) or a value.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdateInput {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub status_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub parent_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub due_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub due_time: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<i64>)]
    pub duration_minutes: Option<Option<i64>>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub start_date: Option<Option<String>>,
    /// `isRepeating` is derived from `repeatConfig`; a sent value is ignored.
    #[serde(default)]
    pub is_repeating: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<Value>)]
    pub repeat_config: Option<Option<Value>>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub repeat_from: Option<Option<String>>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub linked_note_ids: Option<Vec<String>>,
    #[serde(default)]
    pub linked_canvas_ids: Option<Vec<String>>,
    #[serde(default)]
    pub fields: Option<Map<String, Value>>,
}

impl TaskUpdateInput {
    pub fn patch(self) -> (String, TaskPatch) {
        fn patch<T>(value: Option<Option<T>>) -> Patch<T> {
            match value {
                None => Patch::Keep,
                Some(None) => Patch::Clear,
                Some(Some(value)) => Patch::Set(value),
            }
        }
        let patch = TaskPatch {
            title: self.title,
            description: patch(self.description),
            priority: self.priority,
            project_id: self.project_id,
            status_id: patch(self.status_id),
            parent_id: patch(self.parent_id),
            due_date: patch(self.due_date),
            due_time: patch(self.due_time),
            duration_minutes: patch(self.duration_minutes),
            start_date: patch(self.start_date),
            repeat_config: patch(self.repeat_config),
            repeat_from: patch(self.repeat_from),
            tags: self.tags,
            linked_note_ids: self.linked_note_ids,
            linked_canvas_ids: self.linked_canvas_ids,
            fields: self.fields,
            ..TaskPatch::default()
        };
        (self.id, patch)
    }
}

/// `StatusCreateSchema`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusCreateInput {
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub is_done: Option<bool>,
}

/// `StatusUpdateSchema`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusUpdateInput {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub position: Option<i64>,
    #[serde(default)]
    pub is_default: Option<bool>,
    #[serde(default)]
    pub is_done: Option<bool>,
}

/// `StatusReorderSchema`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusReorderInput {
    pub status_ids: Vec<String>,
    pub positions: Vec<i64>,
}

/// A present field, `null` included: `Some(None)` for `null`.
pub(super) fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    Option::<T>::deserialize(d).map(Some)
}
