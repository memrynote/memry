//! Complete and uncomplete, as desktop's `completeTaskWithUndo` and
//! `uncompleteTaskWithUndo` (`use-undoable-task-actions.ts`) write them.
//!
//! Completion is two fields, never one: `statusId` moves to the project's
//! done status and `completedAt` is stamped, and uncompleting moves back to
//! the default todo status with an explicit `null` (§13.4). Completing a
//! parent completes its open subtasks with it.
//!
//! Completing a **repeating** task (spec 004 D3) closes this occurrence —
//! `repeatConfig` becomes `null` (desktop also clears the local-only
//! `isRepeating`, which is not a wire field) — and creates the next one under
//! a new id. The next due date and the series end are
//! [`crate::domain::recurrence::complete_repeating_task`], pinned by vectors.

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;

use super::super::calendar::LocalDateTime;
use super::super::notes::iso;
use super::super::recurrence::complete_repeating_task;
use super::super::repeat_config::{RepeatConfig, with_completed_count};
use super::batch::{Batch, TaskWrite};
use super::create::{copied, seeded};
use super::model::{
    ProjectStatuses, StatusKind, StoredTask, load_live, new_task_id, next_position, status_kind,
    subtask_ids,
};

/// The fields the next occurrence copies from the one completed. Desktop
/// spreads the whole task and re-creates it through `tasksService.create`,
/// which carries these and not `sourceNoteId`; `dueDate`, `statusId`,
/// `repeatConfig` and `position` are set separately.
const OCCURRENCE_FIELDS: [&str; 11] = [
    "title",
    "description",
    "projectId",
    "parentId",
    "priority",
    "dueTime",
    "startDate",
    "repeatFrom",
    "tags",
    "linkedNoteIds",
    "linkedCanvasIds",
];

/// The occurrence a repeating completion created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NextOccurrence {
    pub id: String,
    /// `YYYY-MM-DD`.
    pub due_date: String,
}

/// What [`complete`] wrote.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Completion {
    /// The task and every subtask completed with it (their prior `statusId`,
    /// `completedAt` and, for a repeating task, `repeatConfig`), plus the next
    /// occurrence in `created`. Empty when the task was already complete.
    /// [`super::undo`] reverts all of it, next occurrence included.
    pub write: TaskWrite,
    /// Whether the task was a repeating one (a desktop-shaped `repeatConfig`
    /// and a due date).
    pub repeating: bool,
    /// The next occurrence, or `None` — for a repeating task that means the
    /// series has ended and this was the final occurrence.
    pub next_occurrence: Option<NextOccurrence>,
}

/// Completes a task (`completeTaskWithUndo`), in one transaction.
///
/// `local_now` is the device's wall clock: it anchors a `repeatFrom:
/// "completion"` series and is what a date-bounded series ends against.
/// `completedAt` is stamped from `now_ms` as an instant.
///
/// A task already in a done status is left alone. A task whose status is not
/// one of its project's is complete when it carries a `completedAt`.
pub fn complete(
    conn: &Connection,
    task_id: &str,
    local_now: LocalDateTime,
    device_id: &str,
    now_ms: i64,
) -> Result<Completion, StorageError> {
    let mut batch = Batch::open(conn, device_id, now_ms)?;
    let task = load_live(batch.conn(), task_id)?;
    let statuses = ProjectStatuses::load(batch.conn(), task.project_id())?;
    if is_complete(&task, &statuses) {
        return Ok(Completion {
            write: batch.commit()?,
            ..Completion::default()
        });
    }

    let repeat_wire = task.value("repeatConfig");
    let due = task
        .str("dueDate")
        .and_then(LocalDateTime::parse)
        .map(LocalDateTime::date);
    let series = RepeatConfig::from_wire(&repeat_wire).zip(due);

    let at = json!(iso(now_ms)?);
    let done = done_status(&task, &statuses);
    let mut changes = vec![("statusId", done), ("completedAt", at.clone())];
    if series.is_some() {
        changes.push(("repeatConfig", Value::Null));
    }
    batch.edit(task_id, changes)?;

    for subtask_id in subtask_ids(batch.conn(), task_id)? {
        let subtask = load_live(batch.conn(), &subtask_id)?;
        if subtask.is_completed() {
            continue;
        }
        let done = done_status(&subtask, &statuses);
        batch.edit(
            &subtask_id,
            vec![("statusId", done), ("completedAt", at.clone())],
        )?;
    }

    let mut next_occurrence = None;
    if let Some((config, due)) = &series {
        let completion = complete_repeating_task(*due, config, task.str("repeatFrom"), local_now);
        if let Some(next_due) = completion.next_due_date {
            let id = new_task_id();
            let due_date = next_due.key();
            let mut fields = copied(&task, &OCCURRENCE_FIELDS);
            let status = statuses
                .default_todo()
                .map(|status| json!(status.id))
                .unwrap_or_else(|| task.value("statusId"));
            if !status.is_null() {
                fields.insert("statusId".to_owned(), status);
            }
            fields.insert("dueDate".to_owned(), json!(due_date));
            fields.insert(
                "repeatConfig".to_owned(),
                with_completed_count(&repeat_wire, completion.completed_count),
            );
            let position = next_position(batch.conn(), task.project_id(), task.parent_id())?;
            fields.insert("position".to_owned(), json!(position));
            batch.create(&id, seeded(fields, device_id, now_ms)?)?;
            next_occurrence = Some(NextOccurrence { id, due_date });
        }
    }

    Ok(Completion {
        write: batch.commit()?,
        repeating: series.is_some(),
        next_occurrence,
    })
}

/// Reopens a task (`uncompleteTaskWithUndo`): the project's default todo
/// status (the current one when the project has none) and an explicit `null`
/// `completedAt`. Subtasks are not touched, as on desktop.
pub fn uncomplete(
    conn: &Connection,
    task_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    let mut batch = Batch::open(conn, device_id, now_ms)?;
    let task = load_live(batch.conn(), task_id)?;
    reopen_in(&mut batch, &task)?;
    batch.commit()
}

/// Desktop's "already done" test: the status's type, or — for a status the
/// project does not have — the `completedAt` stamp.
pub(super) fn is_complete(task: &StoredTask, statuses: &ProjectStatuses) -> bool {
    match task.status_id().and_then(|id| statuses.find(id)) {
        Some(status) => status_kind(status) == StatusKind::Done,
        None => task.is_completed(),
    }
}

/// `doneStatus?.id || task.statusId`.
fn done_status(task: &StoredTask, statuses: &ProjectStatuses) -> Value {
    statuses
        .default_done()
        .map(|status| json!(status.id))
        .unwrap_or_else(|| task.value("statusId"))
}

/// Marks `task` done in its own project's done status, unless it already is.
pub(super) fn close_in(batch: &mut Batch<'_>, task: &StoredTask) -> Result<bool, StorageError> {
    let statuses = ProjectStatuses::load(batch.conn(), task.project_id())?;
    if is_complete(task, &statuses) {
        return Ok(false);
    }
    let at = json!(iso(batch.now_ms())?);
    let done = done_status(task, &statuses);
    batch.edit(&task.id, vec![("statusId", done), ("completedAt", at)])
}

/// Reopens `task` into its project's default todo status.
pub(super) fn reopen_in(batch: &mut Batch<'_>, task: &StoredTask) -> Result<bool, StorageError> {
    let statuses = ProjectStatuses::load(batch.conn(), task.project_id())?;
    let todo = statuses
        .default_todo()
        .map(|status| json!(status.id))
        .unwrap_or_else(|| task.value("statusId"));
    batch.edit(
        &task.id,
        vec![("statusId", todo), ("completedAt", Value::Null)],
    )
}
