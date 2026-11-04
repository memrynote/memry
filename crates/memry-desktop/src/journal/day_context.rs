//! The journal day panel's read (Step 13m-4b, #3530): the tasks due on a day and the count of
//! tasks overdue before it (`journal:getDayContext`, Electron's `getTasksByDueDate` and
//! `countOverdueTasksBeforeDate`). Dates compare as their stored text, as Electron's query
//! does. Calendar events stay empty, as Electron's handler returns them.

use memry_core::api::task_records::TaskItem;
use memry_core::domain::journal::valid_date;
use serde::Serialize;

use crate::notes::error::NotesError;
use crate::notes::service::NotesService;
use crate::session::OpenVault;

/// `DayTask`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DayTaskView {
    pub id: String,
    pub title: String,
    pub completed: bool,
    /// Left out for no priority (`mapPriority`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = DayTaskPriority)]
    pub priority: Option<DayTaskPriority>,
    /// Always `false`: a task due on the day is not overdue for it.
    pub is_overdue: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DayTaskPriority {
    Low,
    Medium,
    High,
    Urgent,
}

/// `ScheduleEvent`: none yet, as in Electron.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub enum DayEventView {}

/// `DayContext`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DayContextView {
    pub date: String,
    /// Not archived, completed ones included; by due time (none first), then position.
    pub tasks: Vec<DayTaskView>,
    pub events: Vec<DayEventView>,
    /// Not completed, not archived, due before the day.
    pub overdue_count: u32,
}

impl NotesService {
    /// The tasks due on `date` and the count overdue before it.
    pub fn journal_day_context(
        &self,
        open: &OpenVault,
        date: &str,
    ) -> Result<DayContextView, NotesError> {
        let date = valid_date(date)?;
        let tasks = open.vault.tasks(self.store.clone())?.all()?;
        Ok(day_context(tasks, date))
    }
}

fn day_context(tasks: Vec<TaskItem>, date: &str) -> DayContextView {
    let open = |task: &&TaskItem| task.archived_at.is_none();
    let overdue = tasks
        .iter()
        .filter(open)
        .filter(|task| task.completed_at.is_none())
        .filter(|task| task.due_date.as_deref().is_some_and(|due| due < date))
        .count();
    let mut due: Vec<&TaskItem> = tasks
        .iter()
        .filter(open)
        .filter(|task| task.due_date.as_deref() == Some(date))
        .collect();
    // Stable: `Tasks::all` is in position, then id order.
    due.sort_by(|a, b| (&a.due_time, a.position).cmp(&(&b.due_time, b.position)));
    DayContextView {
        date: date.to_owned(),
        tasks: due
            .into_iter()
            .map(|task| DayTaskView {
                id: task.id.clone(),
                title: task.title.clone(),
                completed: task.completed_at.is_some(),
                priority: priority(task.priority),
                is_overdue: false,
            })
            .collect(),
        events: Vec::new(),
        overdue_count: u32::try_from(overdue).unwrap_or(u32::MAX),
    }
}

fn priority(stored: i64) -> Option<DayTaskPriority> {
    match stored {
        1 => Some(DayTaskPriority::Low),
        2 => Some(DayTaskPriority::Medium),
        3 => Some(DayTaskPriority::High),
        4 => Some(DayTaskPriority::Urgent),
        _ => None,
    }
}
