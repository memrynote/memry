//! Bulk actions: the subtask menu (`subtask-bulk-utils.ts`) and the
//! multi-select bar (`use-bulk-actions.ts`). Each call is one transaction and
//! returns a [`TaskWrite`] the shell can count and [`super::undo`].
//!
//! A selected id with no live task behind it (deleted meanwhile, or never
//! synced) is skipped rather than failing the whole selection, as desktop's
//! `WHERE id IN (…)` skips it.

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;

use super::super::notes::iso;
use super::batch::{Batch, TaskWrite};
use super::lifecycle::{close_in, reopen_in};
use super::model::{StoredTask, find_live, load_live, subtask_ids};
use super::nullable;
use super::structure::{SubtaskDisposal, delete_in, move_in, require_status_kind, status_in};

/// Completes every open subtask of `parent_id` (`completeAllSubtasks`): the
/// done status and `completedAt`, as a completion writes everywhere.
pub fn complete_all_subtasks(
    conn: &Connection,
    parent_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    over_subtasks(conn, parent_id, device_id, now_ms, |batch, subtask| {
        if !subtask.is_completed() {
            close_in(batch, subtask)?;
        }
        Ok(())
    })
}

/// Reopens every completed subtask of `parent_id`
/// (`markAllSubtasksIncomplete`).
pub fn mark_all_subtasks_incomplete(
    conn: &Connection,
    parent_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    over_subtasks(conn, parent_id, device_id, now_ms, |batch, subtask| {
        if subtask.is_completed() {
            reopen_in(batch, subtask)?;
        }
        Ok(())
    })
}

/// Sets or clears the due date of `parent_id`'s subtasks — the open ones, or
/// all of them with `include_completed` (`setDueDateForAllSubtasks`). Only
/// `dueDate` is written, as on desktop.
pub fn set_due_date_for_all_subtasks(
    conn: &Connection,
    parent_id: &str,
    due_date: Option<&str>,
    include_completed: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    over_subtasks(conn, parent_id, device_id, now_ms, |batch, subtask| {
        if include_completed || !subtask.is_completed() {
            batch.edit(&subtask.id, vec![("dueDate", nullable(due_date))])?;
        }
        Ok(())
    })
}

/// Sets the priority of `parent_id`'s subtasks — the open ones, or all of
/// them with `include_completed` (`setPriorityForAllSubtasks`).
pub fn set_priority_for_all_subtasks(
    conn: &Connection,
    parent_id: &str,
    priority: i64,
    include_completed: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    over_subtasks(conn, parent_id, device_id, now_ms, |batch, subtask| {
        if include_completed || !subtask.is_completed() {
            batch.edit(&subtask.id, vec![("priority", json!(priority))])?;
        }
        Ok(())
    })
}

/// Deletes every subtask of `parent_id` (`deleteAllSubtasks`).
pub fn delete_all_subtasks(
    conn: &Connection,
    parent_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    over_subtasks(conn, parent_id, device_id, now_ms, |batch, subtask| {
        batch.delete(&subtask.id)
    })
}

/// Completes each selected task not already done (`bulkComplete`): its
/// project's done status and `completedAt`. As on desktop, the multi-select
/// completion neither cascades to subtasks nor rolls a repeating series.
pub fn bulk_complete(
    conn: &Connection,
    task_ids: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    over_ids(conn, task_ids, device_id, now_ms, |batch, task| {
        close_in(batch, task).map(drop)
    })
}

/// Reopens each selected task (`bulkUncomplete`): the default todo status and
/// a cleared `completedAt`.
pub fn bulk_uncomplete(
    conn: &Connection,
    task_ids: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    over_ids(conn, task_ids, device_id, now_ms, |batch, task| {
        reopen_in(batch, task).map(drop)
    })
}

/// Deletes each selected task together with its subtasks, so no subtask is
/// left behind under a parent that no longer exists.
pub fn bulk_delete(
    conn: &Connection,
    task_ids: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    over_ids(conn, task_ids, device_id, now_ms, |batch, task| {
        delete_in(batch, &task.id, SubtaskDisposal::Delete)
    })
}

/// Moves each selected task to `project_id` with the equivalent status there,
/// subtasks following their parent ([`super::set_project`]).
pub fn bulk_move(
    conn: &Connection,
    task_ids: &[String],
    project_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    over_ids(conn, task_ids, device_id, now_ms, |batch, task| {
        move_in(batch, task, project_id)
    })
}

/// Sets each selected task's status, and `completedAt` with it
/// (`bulkChangeStatus`, [`super::set_status`]).
pub fn bulk_set_status(
    conn: &Connection,
    task_ids: &[String],
    status_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    let kind = require_status_kind(conn, status_id)?;
    over_ids(conn, task_ids, device_id, now_ms, |batch, task| {
        status_in(batch, task, status_id, kind).map(drop)
    })
}

/// Sets each selected task's priority (`bulkChangePriority`).
pub fn bulk_set_priority(
    conn: &Connection,
    task_ids: &[String],
    priority: i64,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    over_ids(conn, task_ids, device_id, now_ms, |batch, task| {
        batch
            .edit(&task.id, vec![("priority", json!(priority))])
            .map(drop)
    })
}

/// Sets or clears each selected task's due date and time. `None` for the date
/// clears both, as a cleared due date has no time.
pub fn bulk_set_due(
    conn: &Connection,
    task_ids: &[String],
    due_date: Option<&str>,
    due_time: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    let due_time = due_date.and(due_time);
    over_ids(conn, task_ids, device_id, now_ms, |batch, task| {
        batch
            .edit(
                &task.id,
                vec![
                    ("dueDate", nullable(due_date)),
                    ("dueTime", nullable(due_time)),
                ],
            )
            .map(drop)
    })
}

/// Archives each selected task (`bulkArchive`).
pub fn bulk_archive(
    conn: &Connection,
    task_ids: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    let at = json!(iso(now_ms)?);
    over_ids(conn, task_ids, device_id, now_ms, |batch, task| {
        // An archived task keeps the stamp it was archived with.
        if task.str("archivedAt").is_some() {
            return Ok(());
        }
        batch
            .edit(&task.id, vec![("archivedAt", at.clone())])
            .map(drop)
    })
}

/// Unarchives each selected task.
pub fn bulk_unarchive(
    conn: &Connection,
    task_ids: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    over_ids(conn, task_ids, device_id, now_ms, |batch, task| {
        batch
            .edit(&task.id, vec![("archivedAt", Value::Null)])
            .map(drop)
    })
}

/// Runs `action` over each live task in `task_ids`, re-read at its turn so an
/// earlier action in the same selection (a parent moving its subtasks) is
/// seen, in one transaction.
fn over_ids<F>(
    conn: &Connection,
    task_ids: &[String],
    device_id: &str,
    now_ms: i64,
    mut action: F,
) -> Result<TaskWrite, StorageError>
where
    F: FnMut(&mut Batch<'_>, &StoredTask) -> Result<(), StorageError>,
{
    let mut batch = Batch::open(conn, device_id, now_ms)?;
    for task_id in task_ids {
        if let Some(task) = find_live(batch.conn(), task_id)? {
            action(&mut batch, &task)?;
        }
    }
    batch.commit()
}

/// Runs `action` over each live subtask of the live task `parent_id`, in
/// position order, in one transaction.
fn over_subtasks<F>(
    conn: &Connection,
    parent_id: &str,
    device_id: &str,
    now_ms: i64,
    mut action: F,
) -> Result<TaskWrite, StorageError>
where
    F: FnMut(&mut Batch<'_>, &StoredTask) -> Result<(), StorageError>,
{
    let mut batch = Batch::open(conn, device_id, now_ms)?;
    load_live(batch.conn(), parent_id)?;
    for subtask_id in subtask_ids(batch.conn(), parent_id)? {
        let subtask = load_live(batch.conn(), &subtask_id)?;
        action(&mut batch, &subtask)?;
    }
    batch.commit()
}
