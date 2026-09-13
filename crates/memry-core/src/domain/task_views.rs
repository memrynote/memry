//! The four task views FR-057 names — **today, upcoming, by-project,
//! completed** — with desktop's membership semantics (T129).
//!
//! Split out of [`super::tasks`] only to stay under the 600-line ceiling; the
//! write side is there and the read side is here.
//!
//! ## Which desktop
//!
//! FR-057 says "the same membership semantics as desktop", and desktop has
//! more than one answer, so this file states which one it reproduces and why.
//! The rules below are the renderer's shared view helpers
//! (`apps/desktop/src/renderer/src/lib/task-utils/task-view-helpers.ts`),
//! which is the code behind the sidebar's task views and the surface FR-057
//! is about. Desktop's main-process SQL
//! (`apps/desktop/src/main/database/queries/tasks.ts`) answers differently —
//! its `getTodayTasks` is `dueDate = today` with no overdue and no start date,
//! its `getUpcomingTasks` includes today — and it feeds IPC and agent
//! consumers rather than the task views. The divergence is recorded as a spec
//! defect rather than resolved here.
//!
//! ## The rules, stated once
//!
//! Every view starts from **live, non-archived** tasks. `archived_at IS NOT
//! NULL` and a tombstone are both out of every view, in every case.
//!
//! - **Completion is the task's status, not `completedAt`.** A task is
//!   complete iff its `status_id` resolves, **within its own project**, to a
//!   `project_statuses` row with `is_done`. An unresolvable status counts as
//!   **incomplete** — desktop's `status?.type !== 'done'` is true when the
//!   lookup misses, so a task whose project has not been pulled yet still
//!   shows up in the open views rather than vanishing.
//! - **Subtasks ride along with their parent.** `today`, `upcoming` and
//!   `completed` match **top-level** tasks only, then re-admit every live
//!   subtask whose parent matched, regardless of the subtask's own status or
//!   dates. `by_project` is the exception: there a subtask is a first-class
//!   member.
//! - **Order is the projection's `position`**, which is the order desktop's
//!   backing query returns and the order its filters preserve. Ties break on
//!   `id` so two devices with equal positions still agree.
//!
//! ## The core does not decide what "today" is
//!
//! `today` is a **calendar date in the user's own time zone**, and this tier
//! has no access to one; deriving it from an instant would file an evening
//! task under tomorrow for half the planet. The caller supplies
//! `YYYY-MM-DD`, exactly as [`crate::domain::journal`] requires. Comparison is then
//! lexicographic over the date's first ten characters, which is chronological
//! because the wire carries date-only values (§A.6) — and taking the first ten
//! characters is what makes a peer that wrote a full timestamp into `dueDate`
//! compare as the day it names rather than as strictly greater.
//!
//! ## A row that will not read is an error
//!
//! There is no `filter_map` over rows in this file. FR-032 states for a
//! zero-row first page that a reader must never report "none" for "could not
//! tell", and a view is the same case with worse consequences: a task silently
//! dropped from every view is a task the user is told does not exist.

use std::collections::BTreeSet;

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::storage::repositories::instants;

/// The width of the upcoming window, in days after today
/// (`weekFromNow = addDays(today, 7)`).
pub const UPCOMING_WINDOW_DAYS: i64 = 7;

const MS_PER_DAY: i64 = 86_400_000;

/// One task as the views report it.
///
/// The columns a list needs, plus [`TaskRow::done`], which is the resolved
/// status the four predicates are written against. The verbatim payload stays
/// the source of record; this is a read over the projection (§A.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRow {
    pub id: String,
    pub title: String,
    pub project_id: String,
    pub status_id: Option<String>,
    pub parent_id: Option<String>,
    pub priority: i64,
    pub position: i64,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub start_date: Option<String>,
    pub completed_at: Option<String>,
    /// Whether `status_id` resolves to a done status **inside this task's own
    /// project**. An unresolvable status is `false`, which is incomplete.
    pub done: bool,
}

impl TaskRow {
    fn is_top_level(&self) -> bool {
        self.parent_id.is_none()
    }

    /// `hasStarted`: a start date that is not after today.
    fn has_started(&self, today: &str) -> bool {
        self.start_date
            .as_deref()
            .is_some_and(|start| date_key(start) <= today)
    }

    fn due_on_or_before(&self, day: &str) -> bool {
        self.due_date
            .as_deref()
            .is_some_and(|due| date_key(due) <= day)
    }

    fn due_within(&self, after: &str, through: &str) -> bool {
        self.due_date.as_deref().is_some_and(|due| {
            let due = date_key(due);
            due > after && due <= through
        })
    }
}

/// **Today**: incomplete top-level tasks that have started, or are due today
/// or **overdue**, plus the live subtasks of each.
///
/// Overdue is in on purpose — desktop's predicate is
/// `isSameDay(due, today) || isBefore(due, today)` — and a task whose start
/// date has arrived is in **whatever its due date says**, including none at
/// all. A task with neither a due date nor a start date is out.
pub fn today(conn: &Connection, today: &str) -> Result<Vec<TaskRow>, StorageError> {
    let today = valid_date(today)?;
    let tasks = live_tasks(conn)?;
    let matching = tasks
        .iter()
        .filter(|task| {
            !task.done
                && task.is_top_level()
                && (task.has_started(today) || task.due_on_or_before(today))
        })
        .map(|task| task.id.clone())
        .collect();
    Ok(with_subtasks(tasks, &matching))
}

/// **Upcoming**: incomplete top-level tasks due **strictly after today** and
/// no later than `today + days`, plus the live subtasks of each.
///
/// Neither overdue nor today's tasks are in it — those are [`today`]'s — and
/// an undated task is never in it whatever its start date says.
pub fn upcoming(conn: &Connection, today: &str, days: i64) -> Result<Vec<TaskRow>, StorageError> {
    let today = valid_date(today)?;
    let through = add_days(today, days)?;
    let tasks = live_tasks(conn)?;
    let matching = tasks
        .iter()
        .filter(|task| !task.done && task.is_top_level() && task.due_within(today, &through))
        .map(|task| task.id.clone())
        .collect();
    Ok(with_subtasks(tasks, &matching))
}

/// **By project**: every live task filed under `project_id`.
///
/// The one view with no completion filter and no parent filter: desktop's
/// project arm is `projectId === selectedId && !archivedAt` and nothing else,
/// so a completed task and a subtask are both first-class rows. The Inbox is
/// not a view — it is an ordinary project carrying `is_inbox`
/// ([`crate::domain::projects::inbox`]), and `tasks.project_id` is never null.
pub fn by_project(conn: &Connection, project_id: &str) -> Result<Vec<TaskRow>, StorageError> {
    Ok(live_tasks(conn)?
        .into_iter()
        .filter(|task| task.project_id == project_id)
        .collect())
}

/// **Completed**: top-level tasks whose status is done, plus the live subtasks
/// of each.
///
/// Keyed on the status, not on `completed_at`: that is the sidebar view's rule
/// and it is the one FR-057 is about. Desktop's separate "Done" section under
/// the task list keys on `completedAt` instead, which is the second half of
/// the spec defect this module's header records.
pub fn completed(conn: &Connection) -> Result<Vec<TaskRow>, StorageError> {
    let tasks = live_tasks(conn)?;
    let matching = tasks
        .iter()
        .filter(|task| task.done && task.is_top_level())
        .map(|task| task.id.clone())
        .collect();
    Ok(with_subtasks(tasks, &matching))
}

/// Every live, non-archived task in `position` order, with its status
/// resolved.
///
/// The join is on **both** `status_id` and `project_id`, because desktop looks
/// the status up inside the task's own project's status list; a status id that
/// belongs to another project resolves to nothing and the task reads as
/// incomplete.
pub fn live_tasks(conn: &Connection) -> Result<Vec<TaskRow>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT t.id, t.title, t.project_id, t.status_id, t.parent_id, t.priority,
                    t.position, t.due_date, t.due_time, t.start_date, t.completed_at,
                    COALESCE(s.is_done, 0)
               FROM tasks t
               LEFT JOIN project_statuses s
                 ON s.id = t.status_id
                AND s.project_id = t.project_id
                AND s.deleted_at IS NULL
              WHERE t.deleted_at IS NULL
                AND t.archived_at IS NULL
              ORDER BY t.position, t.id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![], |row| {
            Ok(TaskRow {
                id: row.get(0)?,
                title: row.get(1)?,
                project_id: row.get(2)?,
                status_id: row.get(3)?,
                parent_id: row.get(4)?,
                priority: row.get(5)?,
                position: row.get(6)?,
                due_date: row.get(7)?,
                due_time: row.get(8)?,
                start_date: row.get(9)?,
                completed_at: row.get(10)?,
                done: row.get::<_, i64>(11)? != 0,
            })
        })
        .map_err(failed)?;

    // Collected with the error kept, never `filter_map`: a row this build
    // cannot read is a hard failure, not a task that does not exist.
    let mut tasks = Vec::new();
    for row in rows {
        tasks.push(row.map_err(failed)?);
    }
    Ok(tasks)
}

/// `includeSubtasksForMatchingParents`: the matched tasks, plus every live
/// subtask of one, in the input's own order.
fn with_subtasks(tasks: Vec<TaskRow>, matching: &BTreeSet<String>) -> Vec<TaskRow> {
    tasks
        .into_iter()
        .filter(|task| {
            matching.contains(&task.id)
                || task
                    .parent_id
                    .as_deref()
                    .is_some_and(|parent| matching.contains(parent))
        })
        .collect()
}

/// The date half of a wire value, so a peer that wrote `2026-04-20T09:00:00Z`
/// into a date-only field still compares as the day it names.
fn date_key(value: &str) -> &str {
    value.get(0..10).unwrap_or(value)
}

/// `YYYY-MM-DD`, validated rather than assumed: a malformed date compared
/// lexicographically would quietly match the wrong side of every predicate.
fn valid_date(date: &str) -> Result<&str, StorageError> {
    let ok = date.len() == 10 && instants::to_epoch_ms(date).is_some();
    if ok {
        Ok(date)
    } else {
        Err(StorageError::Failed {
            what: format!("`{date}` is not a YYYY-MM-DD calendar date"),
        })
    }
}

/// `date + days`, as a calendar date.
///
/// Both ends are date-only at UTC midnight, so this is plain calendar
/// arithmetic and invents no time zone: the caller's day plus seven days is
/// the same civil date wherever they are.
fn add_days(date: &str, days: i64) -> Result<String, StorageError> {
    let shifted = instants::to_epoch_ms(date)
        .and_then(|start| start.checked_add(days.checked_mul(MS_PER_DAY)?))
        .and_then(instants::to_iso8601)
        .ok_or_else(|| StorageError::Failed {
            what: format!("`{date}` plus {days} days is outside the representable range"),
        })?;
    Ok(date_key(&shifted).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, parent: Option<&str>) -> TaskRow {
        TaskRow {
            id: id.to_owned(),
            title: id.to_owned(),
            project_id: "proj-1".to_owned(),
            status_id: None,
            parent_id: parent.map(str::to_owned),
            priority: 0,
            position: 0,
            due_date: None,
            due_time: None,
            start_date: None,
            completed_at: None,
            done: false,
        }
    }

    #[test]
    fn a_window_is_seven_calendar_days_across_a_month_and_a_leap_day() {
        assert_eq!(add_days("2026-04-16", 7).unwrap(), "2026-04-23");
        assert_eq!(add_days("2026-04-28", 7).unwrap(), "2026-05-05");
        assert_eq!(add_days("2024-02-26", 7).unwrap(), "2024-03-04");
        assert_eq!(add_days("2026-12-31", 1).unwrap(), "2027-01-01");
    }

    #[test]
    fn a_malformed_today_is_refused_rather_than_compared() {
        assert!(valid_date("2026-04-16").is_ok());
        assert!(valid_date("2026-4-16").is_err());
        assert!(valid_date("").is_err());
        assert!(valid_date("2026-13-01").is_err());
    }

    #[test]
    fn a_timestamp_written_into_a_date_field_compares_as_its_own_day() {
        let mut due_today = task("t1", None);
        due_today.due_date = Some("2026-04-16T09:00:00.000Z".to_owned());
        assert!(due_today.due_on_or_before("2026-04-16"));
        assert!(!due_today.due_within("2026-04-16", "2026-04-23"));
    }

    #[test]
    fn a_started_task_is_in_today_whatever_its_due_date_says() {
        let mut started = task("t1", None);
        started.start_date = Some("2026-04-10".to_owned());
        started.due_date = Some("2026-12-01".to_owned());
        assert!(started.has_started("2026-04-16"));
        assert!(!started.due_on_or_before("2026-04-16"));

        let mut later = task("t2", None);
        later.start_date = Some("2026-04-17".to_owned());
        assert!(!later.has_started("2026-04-16"));
    }

    #[test]
    fn upcoming_excludes_today_and_includes_the_last_day_of_the_window() {
        let mut due = task("t1", None);
        due.due_date = Some("2026-04-16".to_owned());
        assert!(!due.due_within("2026-04-16", "2026-04-23"));
        due.due_date = Some("2026-04-17".to_owned());
        assert!(due.due_within("2026-04-16", "2026-04-23"));
        due.due_date = Some("2026-04-23".to_owned());
        assert!(due.due_within("2026-04-16", "2026-04-23"));
        due.due_date = Some("2026-04-24".to_owned());
        assert!(!due.due_within("2026-04-16", "2026-04-23"));
    }

    #[test]
    fn a_subtask_rides_along_with_its_parent_and_never_on_its_own() {
        let tasks = vec![
            task("parent", None),
            task("child", Some("parent")),
            task("orphan-child", Some("other")),
            task("other-top", None),
        ];
        let matching = ["parent".to_owned()].into_iter().collect();
        let kept: Vec<String> = with_subtasks(tasks, &matching)
            .into_iter()
            .map(|task| task.id)
            .collect();
        assert_eq!(kept, vec!["parent".to_owned(), "child".to_owned()]);
    }
}
