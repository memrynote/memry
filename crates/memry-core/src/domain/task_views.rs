//! Task view membership (spec 004 D4, superseding FR-057's four views).
//!
//! The phone's Tasks tab shows what desktop's Tasks page shows: **All, Today,
//! Tomorrow, Next 7 days, Archived**, the Done section under each, the project
//! scope, and the tab badges. Every rule here is a port of
//! `packages/domain-tasks/src/parsing/due-window.ts` and is pinned by the
//! `dueWindows` section of the `task-parsing` vectors
//! (`tests/task_views_vectors.rs`), so the two cannot drift.
//!
//! ## The rules, stated once
//!
//! - **Completion is the status type**, resolved inside the task's own project.
//!   An unresolvable status (a project not pulled yet, a deleted status) reads
//!   as **incomplete**, so the task stays visible rather than vanishing.
//!   `completedAt` is only the Done-section rule, as on desktop.
//! - **Overdue leads Today and Next 7**, never Tomorrow.
//! - **A started task** (start date not after today) is in Today whatever its
//!   due date says, unless it is overdue — then it leads as overdue.
//! - **Subtasks ride with a matching parent** and are never matched on their
//!   own. The due windows re-admit a matching parent's subtasks from the whole
//!   list, archived ones included, exactly as desktop does.
//! - **Order is the input order**, which is the projection's `position` then
//!   `id` — the order desktop's backing query returns.
//!
//! ## The core does not decide what "today" is
//!
//! `now` is the caller's local wall clock ([`LocalDateTime`]); this tier has no
//! time zone. A stored due date is a date-only key (local midnight) or, from an
//! older peer, a full timestamp, which is read as the wall clock it names.
//!
//! ## A row that will not read is an error
//!
//! [`load`] never `filter_map`s rows: a task silently dropped from every view is
//! a task the user is told does not exist (FR-032's rule, generalised).

use std::collections::HashSet;

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::calendar::{CivilDate, LocalDateTime};
use crate::domain::notes::failed;

/// One task as the view predicates read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewTask {
    pub id: String,
    pub project_id: String,
    pub status_id: Option<String>,
    pub parent_id: Option<String>,
    pub position: i64,
    pub due: Option<LocalDateTime>,
    pub start: Option<LocalDateTime>,
    pub completed_at: Option<LocalDateTime>,
    pub archived_at: Option<LocalDateTime>,
    /// Whether `status_id` resolves to a done status inside the task's own
    /// project. Unresolvable is `false`, which is incomplete.
    pub done: bool,
}

impl ViewTask {
    fn is_top_level(&self) -> bool {
        self.parent_id.is_none()
    }

    fn is_archived(&self) -> bool {
        self.archived_at.is_some()
    }

    /// `hasStarted`: a start date whose day is not after today.
    fn has_started(&self, today: CivilDate) -> bool {
        self.start.is_some_and(|start| start.date() <= today)
    }
}

/// A due-date window of the Tasks page. `All` is "no window", not a range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DueWindow {
    Today,
    Tomorrow,
    Next7,
}

impl DueWindow {
    /// Inclusive day offsets from today (`DUE_WINDOW_DAYS`).
    fn days(self) -> (i64, i64) {
        match self {
            Self::Today => (0, 0),
            Self::Tomorrow => (1, 1),
            Self::Next7 => (0, 6),
        }
    }
}

/// The sidebar/tasks-page selection `getFilteredTasks` answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Selection {
    /// A view id: `all`, `today`, `upcoming`, `tomorrow`, `week`, `completed`;
    /// anything else lands on the `all` arm, as on desktop.
    View(String),
    Project(String),
}

/// The Tasks page tab badges: parents only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TabCounts {
    pub all: u32,
    pub archived: u32,
    pub today: u32,
    pub tomorrow: u32,
    pub next7: u32,
}

/// `includeSubtasksForMatchingParents`: the matched tasks, plus every subtask
/// of one from `all`, in `all`'s order.
fn with_subtasks<'a>(matching: &[&'a ViewTask], all: &'a [ViewTask]) -> Vec<&'a ViewTask> {
    let ids: HashSet<&str> = matching.iter().map(|task| task.id.as_str()).collect();
    all.iter()
        .filter(|task| {
            ids.contains(task.id.as_str())
                || task
                    .parent_id
                    .as_deref()
                    .is_some_and(|parent| ids.contains(parent))
        })
        .collect()
}

/// `getFilteredTasks`: a view or a project, over non-archived tasks.
pub fn filtered<'a>(
    tasks: &'a [ViewTask],
    selection: &Selection,
    now: LocalDateTime,
) -> Vec<&'a ViewTask> {
    let live: Vec<ViewTask> = tasks
        .iter()
        .filter(|task| !task.is_archived())
        .cloned()
        .collect();
    let keep: HashSet<String> = match selection {
        Selection::Project(project) => live
            .iter()
            .filter(|task| &task.project_id == project)
            .map(|task| task.id.clone())
            .collect(),
        Selection::View(view) => view_matches(&live, view, now),
    };
    // Re-borrow from the caller's slice so the lifetime is theirs.
    tasks
        .iter()
        .filter(|task| !task.is_archived() && keep.contains(&task.id))
        .collect()
}

fn view_matches(live: &[ViewTask], view: &str, now: LocalDateTime) -> HashSet<String> {
    let today = now.date();
    let week_from_now = today.add_days(7);
    let incomplete_top: Vec<&ViewTask> = live
        .iter()
        .filter(|task| !task.done && task.is_top_level())
        .collect();
    let due_day = |task: &ViewTask| task.due.map(LocalDateTime::date);
    let matching: Vec<&ViewTask> = match view {
        "today" => incomplete_top
            .into_iter()
            .filter(|task| task.has_started(today) || due_day(task).is_some_and(|d| d <= today))
            .collect(),
        "upcoming" => incomplete_top
            .into_iter()
            .filter(|task| due_day(task).is_some_and(|d| d > today && d <= week_from_now))
            .collect(),
        "tomorrow" => incomplete_top
            .into_iter()
            .filter(|task| due_day(task) == Some(today.add_days(1)))
            .collect(),
        "week" => {
            let week_end = today.end_of_week(0);
            incomplete_top
                .into_iter()
                .filter(|task| due_day(task).is_some_and(|d| d >= today && d <= week_end))
                .collect()
        }
        "completed" => live
            .iter()
            .filter(|task| task.done && task.is_top_level())
            .collect(),
        _ => incomplete_top,
    };
    with_subtasks(&matching, live)
        .into_iter()
        .map(|task| task.id.clone())
        .collect()
}

/// `getTasksInDueWindow`: one window's tasks, overdue first (Today, Next 7).
pub fn in_due_window(tasks: &[ViewTask], window: DueWindow, now: LocalDateTime) -> Vec<&ViewTask> {
    let today = now.date();
    let (first, last) = window.days();
    let start_ms = today.add_days(first).start_ms();
    let end_ms = today.add_days(last).end_ms();
    let include_overdue = window != DueWindow::Tomorrow;

    let mut overdue = Vec::new();
    let mut in_window = Vec::new();
    for task in tasks {
        if task.done || !task.is_top_level() || task.is_archived() {
            continue;
        }
        let due_day = task.due.map(LocalDateTime::date);
        if window == DueWindow::Today
            && task.has_started(today)
            && due_day.is_none_or(|day| day >= today)
        {
            in_window.push(task);
            continue;
        }
        let (Some(due), Some(day)) = (task.due, due_day) else {
            continue;
        };
        if day < today {
            if include_overdue {
                overdue.push(task);
            }
        } else if (start_ms..=end_ms).contains(&due.ms()) {
            in_window.push(task);
        }
    }

    let mut result = with_subtasks(&overdue, tasks);
    result.extend(with_subtasks(&in_window, tasks));
    result
}

/// `getCompletedTasksInDueWindow`: done by `completedAt`, scoped by due date.
pub fn completed_in_due_window(
    tasks: &[ViewTask],
    window: DueWindow,
    now: LocalDateTime,
) -> Vec<&ViewTask> {
    let today = now.date();
    let (first, last) = window.days();
    let start_ms = today.add_days(first).start_ms();
    let end_ms = today.add_days(last).end_ms();
    tasks
        .iter()
        .filter(|task| {
            task.completed_at.is_some()
                && !task.is_archived()
                && task.is_top_level()
                && task
                    .due
                    .is_some_and(|due| (start_ms..=end_ms).contains(&due.ms()))
        })
        .collect()
}

/// `getCompletedTasks`: the All tab's Done section.
pub fn completed_all(tasks: &[ViewTask]) -> Vec<&ViewTask> {
    tasks
        .iter()
        .filter(|task| task.completed_at.is_some() && !task.is_archived() && task.is_top_level())
        .collect()
}

/// `getCompletedTodayTasks`: the Today tab's Done section.
pub fn completed_today(tasks: &[ViewTask], now: LocalDateTime) -> Vec<&ViewTask> {
    let today = now.date();
    tasks
        .iter()
        .filter(|task| {
            task.completed_at.is_some_and(|at| at.date() == today)
                && !task.is_archived()
                && task.is_top_level()
        })
        .collect()
}

/// The Archived tab: every archived task (the archived scope feeds the raw
/// list, not `getFilteredTasks`, which drops archived tasks first).
pub fn archived(tasks: &[ViewTask]) -> Vec<&ViewTask> {
    tasks.iter().filter(|task| task.is_archived()).collect()
}

/// Narrows to one project; `None` keeps every project.
pub fn scoped(tasks: &[ViewTask], project_id: Option<&str>) -> Vec<ViewTask> {
    tasks
        .iter()
        .filter(|task| project_id.is_none_or(|project| task.project_id == project))
        .cloned()
        .collect()
}

/// `getTaskTabCounts`: the badges, scoped by the project picker.
pub fn tab_counts(tasks: &[ViewTask], scope: Option<&str>, now: LocalDateTime) -> TabCounts {
    let scoped = scoped(tasks, scope);
    let parents = |list: Vec<&ViewTask>| count(list.iter().filter(|task| task.is_top_level()));
    TabCounts {
        all: count(filtered(&scoped, &Selection::View("all".into()), now).iter()),
        archived: count(
            scoped
                .iter()
                .filter(|task| task.is_archived() && task.is_top_level()),
        ),
        today: parents(in_due_window(&scoped, DueWindow::Today, now)),
        tomorrow: parents(in_due_window(&scoped, DueWindow::Tomorrow, now)),
        next7: parents(in_due_window(&scoped, DueWindow::Next7, now)),
    }
}

fn count<T>(items: impl Iterator<Item = T>) -> u32 {
    u32::try_from(items.count()).unwrap_or(u32::MAX)
}

/// A stored date: a `YYYY-MM-DD` key is local midnight, a timestamp is the
/// wall clock it names (`parseDueDate`). Unreadable text reads as absent.
pub fn stored_date(value: Option<&str>) -> Option<LocalDateTime> {
    value.and_then(LocalDateTime::parse)
}

/// Every live task, archived ones included, in `position` then `id` order,
/// with its status resolved inside its own project.
pub fn load(conn: &Connection) -> Result<Vec<ViewTask>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT t.id, t.project_id, t.status_id, t.parent_id, t.position,
                    t.due_date, t.start_date, t.completed_at, t.archived_at,
                    COALESCE(s.is_done, 0)
               FROM tasks t
               LEFT JOIN project_statuses s
                 ON s.id = t.status_id
                AND s.project_id = t.project_id
                AND s.deleted_at IS NULL
              WHERE t.deleted_at IS NULL
              ORDER BY t.position, t.id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![], |row| {
            Ok(ViewTask {
                id: row.get(0)?,
                project_id: row.get(1)?,
                status_id: row.get(2)?,
                parent_id: row.get(3)?,
                position: row.get(4)?,
                due: stored_date(row.get::<_, Option<String>>(5)?.as_deref()),
                start: stored_date(row.get::<_, Option<String>>(6)?.as_deref()),
                completed_at: stored_date(row.get::<_, Option<String>>(7)?.as_deref()),
                archived_at: stored_date(row.get::<_, Option<String>>(8)?.as_deref()),
                done: row.get::<_, i64>(9)? != 0,
            })
        })
        .map_err(failed)?;

    let mut tasks = Vec::new();
    for row in rows {
        tasks.push(row.map_err(failed)?);
    }
    Ok(tasks)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, parent: Option<&str>, due: Option<&str>) -> ViewTask {
        ViewTask {
            id: id.to_owned(),
            project_id: "p".to_owned(),
            status_id: None,
            parent_id: parent.map(str::to_owned),
            position: 0,
            due: stored_date(due),
            start: None,
            completed_at: None,
            archived_at: None,
            done: false,
        }
    }

    fn at(text: &str) -> LocalDateTime {
        LocalDateTime::parse(text).expect("a local instant")
    }

    #[test]
    fn tomorrow_carries_no_overdue_backlog() {
        let tasks = vec![
            task("overdue", None, Some("2026-01-01")),
            task("tomorrow", None, Some("2026-01-15")),
        ];
        let ids = |list: Vec<&ViewTask>| list.iter().map(|t| t.id.clone()).collect::<Vec<_>>();
        let now = at("2026-01-14T12:00:00");
        assert_eq!(
            ids(in_due_window(&tasks, DueWindow::Tomorrow, now)),
            ["tomorrow"]
        );
        assert_eq!(
            ids(in_due_window(&tasks, DueWindow::Next7, now)),
            ["overdue", "tomorrow"]
        );
    }

    #[test]
    fn a_subtask_is_never_matched_on_its_own() {
        let tasks = vec![task("child", Some("gone"), Some("2026-01-14"))];
        let now = at("2026-01-14T12:00:00");
        assert!(in_due_window(&tasks, DueWindow::Today, now).is_empty());
    }
}
