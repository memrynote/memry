//! `Tasks`: every task, project, saved-filter, reminder and activity read and
//! write for one opened vault (spec 004 TP028).
//!
//! One object rather than one per noun, because every write needs the same two
//! things — the vault's database and this device's identity — and every read
//! the shell makes is followed by a write on the same screen. The methods are
//! split over four files (`tasks.rs` reads, `tasks_write.rs`, `projects.rs`,
//! `task_extras.rs`) purely for the 600-line ceiling.
//!
//! **Every method blocks** (spec-defect 90): local SQLite only. The shell runs
//! them on its serial core queue. Nothing here touches the network; a write is
//! durable locally and in the outbox when it returns, and reaches other devices
//! on the next [`crate::api::sync::VaultSync::sync_now`].
//!
//! **Dates are the caller's.** "Now" for anything calendar-shaped (today, a
//! completion's anchor day) is the shell's local wall clock as
//! `YYYY-MM-DDTHH:MM:SS`; stored instants (`completedAt`, `createdAt`) are the
//! core's UTC clock, as desktop writes them.

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::api::errors::{AuthError, StorageError};
use crate::api::task_records::{ProjectItem, TaskGroupItem, TaskItem};
use crate::crypto::keys;
use crate::domain::calendar::LocalDateTime;
use crate::domain::notes::failed;
use crate::domain::projects;
use crate::domain::task_filter::{
    self, CompletionFilter, FilterProject, FilterStatus, SortDirection, SortField, StatusType,
    TaskFilters, TaskNoteInfo, TaskSort,
};
use crate::domain::task_records::{self, TaskRecord};
use crate::domain::task_views::{self, DueWindow, Selection, ViewTask};
use crate::seams::secure_store::{SecureStore, SecureStoreKey};
use crate::storage::Db;

/// The task surface over one opened vault.
#[derive(uniffi::Object)]
pub struct Tasks {
    pub(crate) db: Db,
    pub(crate) device_id: String,
}

impl Tasks {
    /// Built by [`crate::api::vault::Vault::tasks`]. The device id is derived
    /// from the keychain's signing key exactly as `NotesWriter` does, so both
    /// write surfaces tick the same clock entry.
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        let secret =
            store
                .get(SecureStoreKey::DeviceSigningKey)?
                .ok_or(AuthError::MalformedToken {
                    what: "this device has no signing key, so it has no identity to write under"
                        .to_string(),
                })?;
        let public = secret
            .get(32..64)
            .ok_or(AuthError::MalformedToken {
                what: "device signing key is not 64 bytes".to_string(),
            })?
            .to_vec();
        Ok(Self {
            db,
            device_id: keys::local_device_id_hex(&public)?,
        })
    }
}

/// One Tasks-page query: the tab, the project picker, the filter bar and the
/// sort, exactly the inputs desktop's `pages/tasks.tsx` combines.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskViewQuery {
    /// `all`, `today`, `tomorrow`, `next7` or `archived`.
    pub tab: String,
    /// The project picker's scope; `None` is every project.
    pub project_id: Option<String>,
    /// The saved-filter `filters` object as JSON; `None` is desktop's defaults.
    pub filters_json: Option<String>,
    /// `{field, direction}` as JSON; `None` is due date ascending.
    pub sort_json: Option<String>,
    /// The shell's local wall clock, `YYYY-MM-DDTHH:MM:SS`.
    pub now: String,
    /// 0 Sunday, 1 Monday (the Calendar `weekStartDay` setting).
    pub week_starts_on: u32,
}

/// What a Tasks-page query shows.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TaskViewResult {
    /// The list, in order: filtered and sorted, then (on a window tab) the
    /// window's overdue-first order. Subtasks ride with their parents.
    pub task_ids: Vec<String>,
    /// The groups the sort field produces over the top-level rows; empty for
    /// `title`, `completedAt` and an unknown field.
    pub groups: Vec<TaskGroupItem>,
    /// The Done section under the list.
    pub done_ids: Vec<String>,
    pub counts: TaskTabCounts,
    /// Rows before the filter bar, and after it (for the "filters hid
    /// everything" empty state).
    pub total_count: u32,
    pub filtered_count: u32,
}

/// The tab badges.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct TaskTabCounts {
    pub all: u32,
    pub archived: u32,
    pub today: u32,
    pub tomorrow: u32,
    pub next7: u32,
}

#[uniffi::export]
impl Tasks {
    /// Every live task, archived ones included, in `position` order.
    pub fn all(&self) -> Result<Vec<TaskItem>, StorageError> {
        self.db.call_blocking(|conn| {
            Ok(task_records::all(conn)?
                .into_iter()
                .map(TaskItem::from)
                .collect())
        })
    }

    /// One live task, or `nil` when this vault holds none by that id (deleted
    /// elsewhere, or not pulled yet).
    pub fn get(&self, id: String) -> Result<Option<TaskItem>, StorageError> {
        self.db
            .call_blocking(move |conn| Ok(task_records::get(conn, &id)?.map(TaskItem::from)))
    }

    /// Every project with its statuses; archived ones only when asked.
    pub fn projects(&self, include_archived: bool) -> Result<Vec<ProjectItem>, StorageError> {
        self.db.call_blocking(move |conn| {
            let mut items = Vec::new();
            for project in projects::list(conn, include_archived)? {
                let statuses = projects::statuses(conn, &project.id)?;
                items.push(ProjectItem::new(project, statuses));
            }
            Ok(items)
        })
    }

    /// One Tasks-page query, answered with desktop's rules end to end.
    pub fn view(&self, query: TaskViewQuery) -> Result<TaskViewResult, StorageError> {
        self.db.call_blocking(move |conn| view(conn, &query))
    }
}

fn parse_now(now: &str) -> Result<LocalDateTime, StorageError> {
    LocalDateTime::parse(now).ok_or_else(|| StorageError::Invalid {
        what: format!("`{now}` is not a local YYYY-MM-DDTHH:MM:SS instant"),
    })
}

fn json_or(text: Option<&str>) -> Value {
    text.and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or(Value::Object(Default::default()))
}

fn view(conn: &Connection, query: &TaskViewQuery) -> Result<TaskViewResult, StorageError> {
    let now = parse_now(&query.now)?;
    let records = task_records::all(conn)?;
    let projects = filter_projects(conn)?;
    let notes = note_index(conn)?;

    let mut filters = TaskFilters::from_json(&json_or(query.filters_json.as_deref()));
    if query.tab == "archived" {
        filters.completion = CompletionFilter::Archived;
    }
    let sort = query
        .sort_json
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| TaskSort::from_json(&value))
        .unwrap_or(TaskSort {
            field: SortField::DueDate,
            direction: SortDirection::Asc,
        });
    let archived_scope = filters.completion == CompletionFilter::Archived;

    let view_tasks: Vec<ViewTask> = records.iter().map(TaskRecord::view_task).collect();
    // `getFilteredTasks(tasks, 'all')` — or, for the archived scope, the raw
    // list — narrowed by the project picker.
    let base_ids: Vec<String> = if archived_scope {
        records.iter().map(|task| task.id.clone()).collect()
    } else {
        task_views::filtered(&view_tasks, &Selection::View("all".into()), now)
            .into_iter()
            .map(|task| task.id.clone())
            .collect()
    };
    let scope = query.project_id.as_deref();
    let by_id: HashMap<&str, &TaskRecord> = records
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    let base: Vec<task_filter::FilterTask> = base_ids
        .iter()
        .filter_map(|id| by_id.get(id.as_str()))
        .filter(|task| scope.is_none_or(|project| task.project_id == project))
        .map(|task| task.filter_task())
        .collect();
    let filtered: Vec<&task_filter::FilterTask> = task_filter::apply_filters_and_sort(
        &base,
        &filters,
        &sort,
        &projects,
        now,
        query.week_starts_on,
    );

    let window = match query.tab.as_str() {
        "today" if !archived_scope => Some(DueWindow::Today),
        "tomorrow" if !archived_scope => Some(DueWindow::Tomorrow),
        "next7" if !archived_scope => Some(DueWindow::Next7),
        _ => None,
    };
    let task_ids: Vec<String> = match window {
        Some(window) => {
            let in_order: Vec<ViewTask> = filtered
                .iter()
                .filter_map(|task| by_id.get(task.id.as_str()))
                .map(|task| task.view_task())
                .collect();
            task_views::in_due_window(&in_order, window, now)
                .into_iter()
                .map(|task| task.id.clone())
                .collect()
        }
        None => filtered.iter().map(|task| task.id.clone()).collect(),
    };

    let filtered_by_id: HashMap<&str, &task_filter::FilterTask> = filtered
        .iter()
        .map(|task| (task.id.as_str(), *task))
        .collect();
    let visible: Vec<&task_filter::FilterTask> = task_ids
        .iter()
        .filter_map(|id| filtered_by_id.get(id.as_str()).copied())
        .filter(|task| task.parent_id.is_none())
        .collect();
    let groups = task_filter::group_tasks_for_sort(
        &visible,
        &sort.field,
        &sort.direction,
        &projects,
        now,
        Some(&notes),
    )
    .into_iter()
    .map(TaskGroupItem::from)
    .collect();

    let scoped_views = task_views::scoped(&view_tasks, scope);
    let done: Vec<&ViewTask> = if archived_scope {
        Vec::new()
    } else {
        match query.tab.as_str() {
            "today" => task_views::completed_today(&scoped_views, now),
            "tomorrow" => {
                task_views::completed_in_due_window(&scoped_views, DueWindow::Tomorrow, now)
            }
            "next7" => task_views::completed_in_due_window(&scoped_views, DueWindow::Next7, now),
            _ => task_views::completed_all(&scoped_views),
        }
    };
    let counts = task_views::tab_counts(&view_tasks, scope, now);
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);

    Ok(TaskViewResult {
        filtered_count: count(filtered.len()),
        total_count: count(base.len()),
        task_ids,
        groups,
        done_ids: done.into_iter().map(|task| task.id.clone()).collect(),
        counts: TaskTabCounts {
            all: counts.all,
            archived: counts.archived,
            today: counts.today,
            tomorrow: counts.tomorrow,
            next7: counts.next7,
        },
    })
}

/// Every project as the filters read it, archived ones included (a task in an
/// archived project still sorts and groups by it).
pub(crate) fn filter_projects(conn: &Connection) -> Result<Vec<FilterProject>, StorageError> {
    let mut out = Vec::new();
    for project in projects::list(conn, true)? {
        let statuses = projects::statuses(conn, &project.id)?
            .into_iter()
            .map(|status| FilterStatus {
                status_type: StatusType::from_name(status.status_type().as_str())
                    .unwrap_or(StatusType::InProgress),
                id: status.id,
                color: status.color,
                order: status.position,
            })
            .collect();
        out.push(FilterProject {
            id: project.id,
            name: project.name,
            color: project.color,
            statuses,
        });
    }
    Ok(out)
}

/// The note index the folder and note groupings resolve source notes with.
fn note_index(conn: &Connection) -> Result<HashMap<String, TaskNoteInfo>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id, COALESCE(title, ''), COALESCE(folder_path, '')
               FROM notes WHERE deleted_at IS NULL",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![], |row| {
            Ok(TaskNoteInfo {
                id: row.get(0)?,
                title: row.get(1)?,
                folder_path: row.get(2)?,
            })
        })
        .map_err(failed)?;
    let mut index = HashMap::new();
    for row in rows {
        let info = row.map_err(failed)?;
        index.insert(info.id.clone(), info);
    }
    Ok(index)
}
