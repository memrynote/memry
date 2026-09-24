//! Task filters, sorts and groups (spec 004 TP018, D5), ported from desktop's
//! `packages/domain-tasks/src/filtering` and pinned by the `task-filtering`
//! vectors recorded from that TypeScript.
//!
//! Everything here is pure: it reads projection-like rows ([`FilterTask`],
//! [`FilterProject`], [`TaskNoteInfo`]) the caller has already loaded, and the
//! caller's local wall-clock `now` and week start. Nothing reads a clock or the
//! database.
//!
//! The TypeScript's quirks are part of the contract and are reproduced on
//! purpose: `endOfMonth` on the 31st lands on the next month's last day (JS
//! `setMonth` rollover), `endOfWeek` and `endOfMonth` are the *start* of their
//! last day, an empty `dueTime` sorts as missing (JS truthiness), and every
//! sort is stable (`Array.prototype.sort`). Text orders with
//! [`locale_compare`], a model of the ICU root collation `localeCompare` uses.
//!
//! [`TaskFilters`] and [`TaskSort`] are desktop's saved-filter `config` shape
//! (`packages/contracts/src/saved-filters-api.ts`). A saved filter syncs, so a
//! value written by a newer build is kept verbatim (the `Other` variants) and
//! behaves as the TypeScript `switch` default does.

mod collation;
mod config;
mod filters;
mod grouping;

pub use collation::locale_compare;
pub use config::{
    CompletionFilter, DueDateFilter, DueDateKind, HasTimeFilter, RepeatFilter, SortDirection,
    SortField, TaskFilters, TaskSort,
};
pub use filters::{
    apply_filters_and_sort, count_active_filters, filter_by_completion, filter_by_due_date_range,
    filter_by_has_time, filter_by_priorities, filter_by_projects, filter_by_repeat_type,
    filter_by_search, filter_by_statuses, filter_by_tags, has_active_filters, sort_tasks_advanced,
};
pub use grouping::{TaskGroup, group_tasks_for_sort, task_note_id};

use crate::domain::calendar::LocalDateTime;

/// A task's priority. The wire integer is `0` (none) through `4` (urgent).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Priority {
    None,
    Low,
    Medium,
    High,
    Urgent,
}

impl Priority {
    /// The wire integer (`none = 0` .. `urgent = 4`). `None` outside `0..=4`.
    pub fn from_wire(value: i64) -> Option<Self> {
        match value {
            0 => Some(Self::None),
            1 => Some(Self::Low),
            2 => Some(Self::Medium),
            3 => Some(Self::High),
            4 => Some(Self::Urgent),
            _ => None,
        }
    }

    pub fn to_wire(self) -> i64 {
        match self {
            Self::None => 0,
            Self::Low => 1,
            Self::Medium => 2,
            Self::High => 3,
            Self::Urgent => 4,
        }
    }

    /// Desktop's name (`none`, `low`, `medium`, `high`, `urgent`), which is
    /// what a saved filter's `priorities` array holds.
    pub fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Urgent => "urgent",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "none" => Some(Self::None),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "urgent" => Some(Self::Urgent),
            _ => None,
        }
    }
}

/// What a project status means: desktop's `StatusType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StatusType {
    Todo,
    InProgress,
    Done,
}

impl StatusType {
    /// Desktop's name: `todo`, `in_progress`, `done`.
    pub fn name(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::InProgress => "in_progress",
            Self::Done => "done",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "todo" => Some(Self::Todo),
            "in_progress" => Some(Self::InProgress),
            "done" => Some(Self::Done),
            _ => None,
        }
    }
}

/// The part of a task the filters, sorts and groups read (desktop's
/// `FilterTask`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterTask {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub project_id: String,
    pub status_id: String,
    pub parent_id: Option<String>,
    pub priority: Priority,
    /// A date-only due date is its local midnight.
    pub due_date: Option<LocalDateTime>,
    /// `HH:MM`, as the wire carries it.
    pub due_time: Option<String>,
    pub created_at: LocalDateTime,
    pub completed_at: Option<LocalDateTime>,
    pub archived_at: Option<LocalDateTime>,
    pub is_repeating: bool,
    pub tags: Vec<String>,
    pub source_note_id: Option<String>,
    pub linked_note_ids: Vec<String>,
}

/// One status of a project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterStatus {
    pub id: String,
    pub status_type: StatusType,
    pub color: String,
    pub order: i64,
}

/// A project with its statuses, in the order the caller holds them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterProject {
    pub id: String,
    pub name: String,
    pub color: String,
    pub statuses: Vec<FilterStatus>,
}

/// A task's source note, resolved for the `folder` and `note` groupings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskNoteInfo {
    pub id: String,
    pub title: String,
    /// Vault-relative folder, `""` for the vault root.
    pub folder_path: String,
}

/// `projects.find((p) => p.id === id)?.statuses.find((s) => s.id === status)`.
fn find_status<'a>(
    projects: &'a [FilterProject],
    project_id: &str,
    status_id: &str,
) -> Option<&'a FilterStatus> {
    projects
        .iter()
        .find(|project| project.id == project_id)?
        .statuses
        .iter()
        .find(|status| status.id == status_id)
}
