//! Complete and uncomplete, as desktop's `completeTaskWithUndo`
//! (`use-undoable-task-actions.ts`) and `uncompleteTask` (`commands.ts`)
//! write them.
//!
//! Completion is two fields, never one: `statusId` moves to the project's
//! done status and `completedAt` is stamped, and uncompleting moves a task in
//! a done status to the default open status with an explicit `null` (§13.4).
//! Completing a parent completes the open tasks of its whole branch with it.
//!
//! Completing a **repeating** task (spec 004 D3) closes this occurrence —
//! `repeatConfig` becomes `null` (desktop also clears the local-only
//! `isRepeating`, which is not a wire field) — and creates the next one under
//! a new random id, as desktop does (chapter 13 §13.7.3). The next due date
//! and the series end are [`crate::domain::recurrence::complete_repeating_task`],
//! pinned by the `task-completion-spawn` vectors.

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;

use super::super::calendar::{CivilDate, LocalDateTime};
use super::super::notes::iso;
use super::super::recurrence::complete_repeating_task;
use super::super::repeat_config::{RepeatConfig, with_completed_count};
use super::batch::{Batch, TaskWrite};
use super::create::{copied, seeded};
use super::model::{
    ProjectStatuses, StatusKind, StoredTask, descendant_ids, load_live, new_task_id, next_position,
    status_by_id, status_kind,
};

/// The fields the next occurrence copies from the one completed. Desktop
/// spreads the whole task and re-creates it through `tasksService.create`,
/// which carries these and not `sourceNoteId`; `dueDate`, `statusId`,
/// `repeatConfig` and `position` are set separately, and `startDate` moves
/// with the due date. `durationMinutes` as `rollRepeatingSeries` copies it.
const OCCURRENCE_FIELDS: [&str; 13] = [
    "title",
    "description",
    "projectId",
    "parentId",
    "priority",
    "dueTime",
    "durationMinutes",
    "startDate",
    "repeatFrom",
    "tags",
    "linkedNoteIds",
    "linkedCanvasIds",
    "fields",
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
    complete_with(
        conn,
        task_id,
        local_now,
        &Completing::default(),
        device_id,
        now_ms,
    )
}

/// How [`complete_with`] completes. The default is [`complete`]'s: open subtasks close with
/// the task, a repeating task rolls, and `completedAt` is `now_ms`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completing {
    /// Close the task's open subtasks too. Desktop's `tasks:complete` does not.
    pub subtasks: bool,
    /// Roll a repeating task to its next occurrence. Off is desktop's `recordOnly`: a
    /// completion recorded from elsewhere closes the task and leaves its series alone.
    pub roll: bool,
    /// The `completedAt` to stamp, an ISO instant; `None` is `now_ms`.
    pub completed_at: Option<String>,
}

impl Default for Completing {
    fn default() -> Self {
        Self {
            subtasks: true,
            roll: true,
            completed_at: None,
        }
    }
}

/// [`complete`] as `how` says.
pub fn complete_with(
    conn: &Connection,
    task_id: &str,
    local_now: LocalDateTime,
    how: &Completing,
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

    let series = if how.roll { series_of(&task) } else { None };

    let at = match &how.completed_at {
        Some(at) => json!(at),
        None => json!(iso(now_ms)?),
    };
    let done = done_status(&task, &statuses);
    let mut changes = vec![("statusId", done), ("completedAt", at.clone())];
    if series.is_some() {
        changes.push(("repeatConfig", Value::Null));
    }
    batch.edit(task_id, changes)?;

    let subtasks = if how.subtasks {
        descendant_ids(batch.conn(), task_id)?
    } else {
        Vec::new()
    };
    for subtask_id in subtasks {
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

    let next_occurrence = match &series {
        Some(series) => spawn_next(&mut batch, &task, &statuses, series, local_now)?,
        None => None,
    };

    Ok(Completion {
        write: batch.commit()?,
        repeating: series.is_some(),
        next_occurrence,
    })
}

/// A repeating task's series: a readable `repeatConfig` and a due date.
pub(super) fn series_of(task: &StoredTask) -> Option<(RepeatConfig, CivilDate)> {
    let due = task
        .str("dueDate")
        .and_then(LocalDateTime::parse)
        .map(LocalDateTime::date);
    RepeatConfig::from_wire(&task.value("repeatConfig")).zip(due)
}

/// Creates the occurrence after `task` in `batch`, or nothing when the series
/// has ended. `task` is the occurrence as it was before it closed
/// (`rollRepeatingSeries` reads `before`), and `statuses` its project's.
pub(super) fn spawn_next(
    batch: &mut Batch<'_>,
    task: &StoredTask,
    statuses: &ProjectStatuses,
    (config, due): &(RepeatConfig, CivilDate),
    local_now: LocalDateTime,
) -> Result<Option<NextOccurrence>, StorageError> {
    let completion = complete_repeating_task(*due, config, task.str("repeatFrom"), local_now);
    let Some(next_due) = completion.next_due_date else {
        return Ok(None);
    };
    // A random id, as desktop's `generateId()`: two devices that complete
    // the same occurrence before syncing each create their own, and an undo
    // tombstones only the one this device created (§13.7.3).
    let id = new_task_id();
    let due_date = next_due.key();
    let mut fields = copied(task, &OCCURRENCE_FIELDS);
    let status = statuses
        .default_open()
        .map(|status| json!(status.id))
        .unwrap_or_else(|| task.value("statusId"));
    if !status.is_null() {
        fields.insert("statusId".to_owned(), status);
    }
    fields.insert("dueDate".to_owned(), json!(due_date));
    // The start keeps its distance to the due date: start Wednesday,
    // due Sunday stays Wednesday to Sunday every week.
    if let Some(start) = task.str("startDate").and_then(LocalDateTime::parse) {
        let shift = next_due.days_since_epoch() - due.days_since_epoch();
        fields.insert(
            "startDate".to_owned(),
            json!(start.date().add_days(shift).key()),
        );
    }
    fields.insert(
        "repeatConfig".to_owned(),
        with_completed_count(&task.value("repeatConfig"), completion.completed_count),
    );
    let position = next_position(batch.conn(), task.project_id(), task.parent_id())?;
    fields.insert("position".to_owned(), json!(position));
    let seeded = seeded(fields, batch.device_id(), batch.now_ms())?;
    batch.create(&id, seeded)?;
    Ok(Some(NextOccurrence { id, due_date }))
}

/// Reopens a task (`uncompleteTask`, `commands.ts:501-529`): an explicit
/// `null` `completedAt` and, when the task sits in a done status, its
/// project's default open status. Subtasks are not touched, as on desktop.
pub fn uncomplete(
    conn: &Connection,
    task_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    let mut batch = Batch::open(conn, device_id, now_ms)?;
    let task = load_live(batch.conn(), task_id)?;
    let mut changes = vec![("completedAt", Value::Null)];
    let in_done = match task.status_id() {
        Some(id) => status_by_id(batch.conn(), id)?.is_some_and(|status| status.is_done),
        None => false,
    };
    if in_done
        && let Some(open) = ProjectStatuses::load(batch.conn(), task.project_id())?.default_open()
    {
        changes.insert(0, ("statusId", json!(open.id)));
    }
    batch.edit(task_id, changes)?;
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

/// Reopens `task` into its project's default todo status, as the renderer's
/// bulk bar and subtask menu do (`getDefaultTodoStatus`).
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
