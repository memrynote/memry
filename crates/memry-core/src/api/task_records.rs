//! The records the task surface crosses the FFI with (spec 004 TP028), and
//! their conversions to and from the domain types.
//!
//! Dates cross as text in the wire's own spelling (`YYYY-MM-DD`, ISO-8601
//! instants), so the shell never re-derives a date the core already holds.
//! A repeat rule crosses as [`RepeatRule`]; the verbatim wire JSON rides along
//! so nothing the core does not model is lost on the way back.

use serde_json::{Map, Value};

use crate::domain::calendar::LocalDateTime;
use crate::domain::projects::{Project, ProjectLink, ProjectSummary, Status};
use crate::domain::repeat_config::{EndType, Frequency, MonthlyType, RepeatConfig};
use crate::domain::task_filter::TaskGroup;
use crate::domain::task_records::TaskRecord;
use crate::domain::tasks::{Completion, Prior, TaskWrite};

/// One task.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TaskItem {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub project_id: String,
    pub status_id: Option<String>,
    pub parent_id: Option<String>,
    /// 0 none, 1 low, 2 medium, 3 high, 4 urgent.
    pub priority: i64,
    pub position: i64,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub start_date: Option<String>,
    /// The parsed rule, when the stored config is in desktop's shape.
    pub repeat: Option<RepeatRule>,
    /// Whether any `repeatConfig` is stored, readable or not (desktop's
    /// `isRepeating: !!repeatConfig`).
    pub is_repeating: bool,
    pub repeat_from: Option<String>,
    pub source_note_id: Option<String>,
    pub completed_at: Option<String>,
    pub archived_at: Option<String>,
    pub tags: Vec<String>,
    pub linked_note_ids: Vec<String>,
    pub linked_canvas_ids: Vec<String>,
    pub created_at: Option<String>,
    pub modified_at: Option<String>,
    /// `todo`, `in_progress` or `done`; `None` when the status does not
    /// resolve in the task's project.
    pub status_type: Option<String>,
    pub is_done: bool,
}

impl From<TaskRecord> for TaskItem {
    fn from(task: TaskRecord) -> Self {
        let repeat = task
            .repeat_config
            .as_ref()
            .and_then(RepeatConfig::from_wire)
            .map(RepeatRule::from);
        Self {
            is_repeating: task.is_repeating(),
            is_done: task.is_done(),
            status_type: task.status_type.map(|kind| kind.as_str().to_owned()),
            id: task.id,
            title: task.title,
            description: task.description,
            project_id: task.project_id,
            status_id: task.status_id,
            parent_id: task.parent_id,
            priority: task.priority,
            position: task.position,
            due_date: task.due_date,
            due_time: task.due_time,
            start_date: task.start_date,
            repeat,
            repeat_from: task.repeat_from,
            source_note_id: task.source_note_id,
            completed_at: task.completed_at,
            archived_at: task.archived_at,
            tags: task.tags,
            linked_note_ids: task.linked_note_ids,
            linked_canvas_ids: task.linked_canvas_ids,
            created_at: task.created_at,
            modified_at: task.modified_at,
        }
    }
}

/// A repeat rule in desktop's `RepeatConfig` terms.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RepeatRule {
    /// `daily`, `weekly`, `monthly` or `yearly`.
    pub frequency: String,
    pub interval: i64,
    /// 0 Sunday .. 6 Saturday.
    pub days_of_week: Option<Vec<i64>>,
    /// `dayOfMonth` or `weekPattern`.
    pub monthly_type: Option<String>,
    pub day_of_month: Option<i64>,
    /// 1..4, or 5 for the last.
    pub week_of_month: Option<i64>,
    pub day_of_week_for_month: Option<i64>,
    /// `never`, `date` or `count`.
    pub end_type: String,
    /// `YYYY-MM-DD`.
    pub end_date: Option<String>,
    pub end_count: Option<i64>,
    pub completed_count: i64,
    pub created_at: Option<String>,
}

impl From<RepeatConfig> for RepeatRule {
    fn from(config: RepeatConfig) -> Self {
        Self {
            frequency: config.frequency.as_str().to_owned(),
            interval: config.interval,
            days_of_week: config.days_of_week.clone(),
            monthly_type: config.monthly_type.map(|kind| kind.as_str().to_owned()),
            day_of_month: config.day_of_month,
            week_of_month: config.week_of_month,
            day_of_week_for_month: config.day_of_week_for_month,
            end_type: config.end_type.as_str().to_owned(),
            end_date: config.end_day().map(|day| day.key()),
            end_count: config.end_count,
            completed_count: config.completed_count,
            created_at: config.created_at,
        }
    }
}

impl RepeatRule {
    /// The core's config for this rule.
    pub(crate) fn config(&self) -> RepeatConfig {
        let frequency = match self.frequency.as_str() {
            "daily" => Frequency::Daily,
            "weekly" => Frequency::Weekly,
            "monthly" => Frequency::Monthly,
            "yearly" => Frequency::Yearly,
            other => Frequency::Other(other.to_owned()),
        };
        let end_type = match self.end_type.as_str() {
            "never" => EndType::Never,
            "date" => EndType::Date,
            "count" => EndType::Count,
            other => EndType::Other(other.to_owned()),
        };
        RepeatConfig {
            frequency,
            interval: self.interval,
            days_of_week: self.days_of_week.clone(),
            monthly_type: match self.monthly_type.as_deref() {
                Some("dayOfMonth") => Some(MonthlyType::DayOfMonth),
                Some("weekPattern") => Some(MonthlyType::WeekPattern),
                _ => None,
            },
            day_of_month: self.day_of_month,
            week_of_month: self.week_of_month,
            day_of_week_for_month: self.day_of_week_for_month,
            end_type,
            end_date: self.end_date.as_deref().and_then(LocalDateTime::parse),
            end_count: self.end_count,
            completed_count: self.completed_count,
            created_at: self.created_at.clone(),
        }
    }

    /// Desktop's wire JSON for this rule, laid over `previous` so a key this
    /// build does not model survives the edit (D7). `created_at` falls back to
    /// `now_iso` for a rule the user just made.
    pub(crate) fn to_wire(&self, previous: Option<&Value>, now_iso: &str) -> Value {
        let mut config = self.config();
        if config.created_at.is_none() {
            config.created_at = Some(now_iso.to_owned());
        }
        let mut merged: Map<String, Value> = previous
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        // Keys a rule may legitimately drop (e.g. daysOfWeek when switching to
        // monthly) are removed first, then the rule's own keys are laid on.
        for key in [
            "daysOfWeek",
            "monthlyType",
            "dayOfMonth",
            "weekOfMonth",
            "dayOfWeekForMonth",
            "endCount",
        ] {
            merged.remove(key);
        }
        if let Value::Object(fresh) = config.to_wire() {
            merged.extend(fresh);
        }
        Value::Object(merged)
    }
}

/// One field's value before a write, as JSON text.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FieldValue {
    pub field: String,
    pub json: String,
}

/// One task's fields before a write.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskPrior {
    pub task_id: String,
    pub fields: Vec<FieldValue>,
}

/// What a write did, in the shape [`crate::api::tasks::Tasks::undo`] takes.
#[derive(Debug, Clone, PartialEq, Eq, Default, uniffi::Record)]
pub struct TaskChange {
    pub changed: Vec<TaskPrior>,
    pub created: Vec<String>,
    pub deleted: Vec<String>,
}

impl From<TaskWrite> for TaskChange {
    fn from(write: TaskWrite) -> Self {
        Self {
            changed: write
                .changed
                .into_iter()
                .map(|prior| TaskPrior {
                    task_id: prior.task_id,
                    fields: prior
                        .fields
                        .into_iter()
                        .map(|(field, value)| FieldValue {
                            field,
                            json: value.to_string(),
                        })
                        .collect(),
                })
                .collect(),
            created: write.created,
            deleted: write.deleted,
        }
    }
}

impl TaskChange {
    /// Back to the domain's write. A value that is not JSON reads as `null`.
    pub(crate) fn write(&self) -> TaskWrite {
        TaskWrite {
            changed: self
                .changed
                .iter()
                .map(|prior| Prior {
                    task_id: prior.task_id.clone(),
                    fields: prior
                        .fields
                        .iter()
                        .map(|field| {
                            (
                                field.field.clone(),
                                serde_json::from_str(&field.json).unwrap_or(Value::Null),
                            )
                        })
                        .collect(),
                })
                .collect(),
            created: self.created.clone(),
            deleted: self.deleted.clone(),
        }
    }
}

/// What completing a task did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskCompletion {
    pub change: TaskChange,
    pub repeating: bool,
    /// The next occurrence's id and due date, when the series continues.
    pub next_task_id: Option<String>,
    pub next_due_date: Option<String>,
}

impl From<Completion> for TaskCompletion {
    fn from(completion: Completion) -> Self {
        let (next_task_id, next_due_date) = match completion.next_occurrence {
            Some(next) => (Some(next.id), Some(next.due_date)),
            None => (None, None),
        };
        Self {
            change: completion.write.into(),
            repeating: completion.repeating,
            next_task_id,
            next_due_date,
        }
    }
}

/// One status of a project.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StatusItem {
    pub id: String,
    pub name: String,
    pub color: String,
    pub position: i64,
    pub is_default: bool,
    pub is_done: bool,
    /// `todo`, `in_progress` or `done`, desktop's derivation.
    pub status_type: String,
}

impl From<Status> for StatusItem {
    fn from(status: Status) -> Self {
        Self {
            status_type: status.status_type().as_str().to_owned(),
            id: status.id,
            name: status.name,
            color: status.color,
            position: status.position,
            is_default: status.is_default,
            is_done: status.is_done,
        }
    }
}

/// One project with its statuses.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ProjectItem {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub icon: Option<String>,
    pub position: i64,
    pub is_inbox: bool,
    pub archived_at: Option<String>,
    pub home_note_id: Option<String>,
    pub statuses: Vec<StatusItem>,
}

impl ProjectItem {
    pub(crate) fn new(project: Project, statuses: Vec<Status>) -> Self {
        Self {
            id: project.id,
            name: project.name,
            description: project.description,
            color: project.color,
            icon: project.icon,
            position: project.position,
            is_inbox: project.is_inbox,
            archived_at: project.archived_at,
            home_note_id: project.home_note_id,
            statuses: statuses.into_iter().map(StatusItem::from).collect(),
        }
    }
}

/// One item linked to a project hub.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ProjectLinkItem {
    pub id: String,
    pub item_type: String,
    pub item_id: String,
    pub position: i64,
    pub pinned: bool,
    pub created_at: Option<String>,
}

impl From<ProjectLink> for ProjectLinkItem {
    fn from(link: ProjectLink) -> Self {
        Self {
            id: link.id,
            item_type: link.item_type,
            item_id: link.item_id,
            position: link.position,
            pinned: link.pinned,
            created_at: link.created_at,
        }
    }
}

/// A project's progress numbers.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ProjectStats {
    pub project_id: String,
    pub task_count: u32,
    pub completed_count: u32,
    pub overdue_count: u32,
}

impl From<ProjectSummary> for ProjectStats {
    fn from(summary: ProjectSummary) -> Self {
        let count = |n: i64| u32::try_from(n).unwrap_or(0);
        Self {
            project_id: summary.project_id,
            task_count: count(summary.task_count),
            completed_count: count(summary.completed_count),
            overdue_count: count(summary.overdue_count),
        }
    }
}

/// One group of a task list.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskGroupItem {
    pub key: String,
    /// A fixed label's key (`dueDate.overdue`, `status.todo`, …).
    pub label_key: Option<String>,
    /// User data naming the group (a project, a folder, a note).
    pub name: Option<String>,
    pub color: Option<String>,
    pub variant: Option<String>,
    pub task_ids: Vec<String>,
}

impl From<TaskGroup> for TaskGroupItem {
    fn from(group: TaskGroup) -> Self {
        Self {
            key: group.key,
            label_key: group.label_key,
            name: group.name,
            color: group.color,
            variant: group.variant,
            task_ids: group.task_ids,
        }
    }
}
