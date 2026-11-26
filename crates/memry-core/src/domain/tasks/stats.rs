//! Desktop's dated task reads: `tasks:get-stats`, `tasks:get-today`,
//! `tasks:get-upcoming` and `tasks:get-overdue`
//! (`apps/desktop/src/main/database/queries/tasks.ts:295-410,802-836`).
//!
//! "Today" is the device's local date, which the caller passes in. Due dates
//! compare as `YYYY-MM-DD` text, as desktop's do. "Open" means no
//! `completedAt`; archived tasks never count.

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, params};

use super::list::{LIVE, TaskListItem, ids_where, items};
use crate::api::errors::StorageError;
use crate::domain::calendar::CivilDate;
use crate::domain::notes::failed;

/// `getTaskStats` over the live, unarchived tasks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TaskStats {
    /// Completed ones included.
    pub total: i64,
    pub completed: i64,
    /// Open, due before today.
    pub overdue: i64,
    /// Open, due today.
    pub due_today: i64,
    /// Open, due from today through today plus 7 days.
    pub due_this_week: i64,
}

/// `getTaskStats`.
pub fn stats(conn: &Connection, today: CivilDate) -> Result<TaskStats, StorageError> {
    let week = today.add_days(7).key();
    conn.query_row(
        &format!(
            "SELECT COUNT(*),
                    COALESCE(SUM(t.completed_at IS NOT NULL), 0),
                    COALESCE(SUM(t.due_date < ?1 AND t.completed_at IS NULL), 0),
                    COALESCE(SUM(t.due_date = ?1 AND t.completed_at IS NULL), 0),
                    COALESCE(SUM(t.due_date >= ?1 AND t.due_date <= ?2
                                 AND t.completed_at IS NULL), 0)
             {LIVE} AND t.archived_at IS NULL"
        ),
        params![today.key(), week],
        |row| {
            Ok(TaskStats {
                total: row.get(0)?,
                completed: row.get(1)?,
                overdue: row.get(2)?,
                due_today: row.get(3)?,
                due_this_week: row.get(4)?,
            })
        },
    )
    .map_err(failed)
}

/// `getTodayTasks`: open tasks due today, by due time then position.
pub fn today(conn: &Connection, today: CivilDate) -> Result<Vec<TaskListItem>, StorageError> {
    open_due(
        conn,
        "AND t.due_date = ?",
        vec![today.key()],
        "t.due_time, t.position, t.id",
    )
}

/// `getUpcomingTasks`: open tasks due from today through today plus `days`,
/// by due date, due time, then position.
pub fn upcoming(
    conn: &Connection,
    today: CivilDate,
    days: i64,
) -> Result<Vec<TaskListItem>, StorageError> {
    open_due(
        conn,
        "AND t.due_date >= ? AND t.due_date <= ?",
        vec![today.key(), today.add_days(days).key()],
        "t.due_date, t.due_time, t.position, t.id",
    )
}

/// `getOverdueTasks`: open tasks due before today, by due date then position.
pub fn overdue(conn: &Connection, today: CivilDate) -> Result<Vec<TaskListItem>, StorageError> {
    open_due(
        conn,
        "AND t.due_date < ?",
        vec![today.key()],
        "t.due_date, t.position, t.id",
    )
}

fn open_due(
    conn: &Connection,
    due: &str,
    days: Vec<String>,
    order: &str,
) -> Result<Vec<TaskListItem>, StorageError> {
    let filter = format!(
        "AND t.due_date IS NOT NULL AND t.completed_at IS NULL AND t.archived_at IS NULL {due}"
    );
    let args = days.into_iter().map(SqlValue::from).collect();
    let ids = ids_where(conn, &filter, args, order)?;
    items(conn, &ids)
}
