//! Where a task sits: its project, status, parent and position, and deleting
//! a task that has subtasks.
//!
//! Two invariants from desktop's `validateSubtaskRelationship` hold across
//! every write here: subtasks are **one level deep**, and a subtask lives in
//! its parent's project. So moving a parent to another project moves its
//! subtasks with it, and a subtask is only attached to a top-level task of
//! its own project.

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::storage::repositories::Change;
use crate::sync::outbox::Durable;

use super::super::notes::iso;
use super::super::projects;
use super::batch::{Batch, TaskWrite};
use super::create::require_parent;
use super::model::{
    ProjectStatuses, StatusKind, StoredTask, find_live, load_live, status_by_id, status_kind,
    subtask_ids,
};
use super::{edit, nullable};

/// What happens to a deleted task's subtasks (`deleteParentWithSubtasks`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubtaskDisposal {
    /// The subtasks are deleted with the parent.
    Delete,
    /// The subtasks become top-level tasks (`parentId: null`).
    Promote,
}

/// Files a task under another project, resolving its status there.
///
/// The status is the equivalent one in the target project — the first of the
/// same type, else the default todo status, else the first column — and
/// `completedAt` follows it: stamped when the task lands in a done status
/// open, cleared when it lands outside one completed (`bulkMoveToProject`).
/// A parent's subtasks move with it. A moved subtask keeps its `parentId`, as
/// desktop's project picker leaves it.
pub fn set_project(
    conn: &Connection,
    task_id: &str,
    project_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    let mut batch = Batch::open(conn, device_id, now_ms)?;
    let task = load_live(batch.conn(), task_id)?;
    move_in(&mut batch, &task, project_id)?;
    batch.commit()
}

/// Sets a task's status, and `completedAt` with it: a done status stamps an
/// open task, any other status clears a completed one (`bulkChangeStatus`,
/// the kanban drop).
///
/// The status must exist; it is written as given, as desktop writes it.
pub fn set_status(
    conn: &Connection,
    task_id: &str,
    status_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    let mut batch = Batch::open(conn, device_id, now_ms)?;
    let kind = require_status_kind(batch.conn(), status_id)?;
    let task = load_live(batch.conn(), task_id)?;
    status_in(&mut batch, &task, status_id, kind)?;
    batch.commit()
}

/// Makes a task a subtask of `parent_id`, or a top-level task with `None`.
///
/// Refused: a task as its own parent, a parent that is itself a subtask, a
/// parent in another project, and a task that has subtasks of its own (one
/// level deep, so no cycle can form).
pub fn set_parent(
    conn: &Connection,
    task_id: &str,
    parent_id: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    if let Some(parent_id) = parent_id {
        let task = load_live(conn, task_id)?;
        require_parent(conn, task_id, parent_id, task.project_id())?;
        if !subtask_ids(conn, task_id)?.is_empty() {
            return Err(StorageError::Invalid {
                what: format!(
                    "task {task_id} cannot be a subtask of {parent_id}: it has subtasks of its own"
                ),
            });
        }
    }
    edit(
        conn,
        task_id,
        vec![("parentId", Change::Set(nullable(parent_id)))],
        device_id,
        now_ms,
    )
}

/// Writes each task's position (`reorderTasks`), in one transaction.
pub fn reorder(
    conn: &Connection,
    task_ids: &[String],
    positions: &[i64],
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    if task_ids.len() != positions.len() {
        return Err(StorageError::Invalid {
            what: "taskIds and positions arrays must have the same length".to_owned(),
        });
    }
    let mut batch = Batch::open(conn, device_id, now_ms)?;
    for (task_id, position) in task_ids.iter().zip(positions) {
        batch.edit(task_id, vec![("position", json!(position))])?;
    }
    batch.commit()
}

/// Deletes a task and, per `disposal`, deletes or promotes its subtasks, in
/// one transaction.
pub fn delete_with_subtasks(
    conn: &Connection,
    task_id: &str,
    disposal: SubtaskDisposal,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    let mut batch = Batch::open(conn, device_id, now_ms)?;
    load_live(batch.conn(), task_id)?;
    delete_in(&mut batch, task_id, disposal)?;
    batch.commit()
}

/// [`set_project`] inside a batch, subtasks included.
pub(super) fn move_in(
    batch: &mut Batch<'_>,
    task: &StoredTask,
    project_id: &str,
) -> Result<(), StorageError> {
    if projects::get(batch.conn(), project_id)?.is_none() {
        return Err(StorageError::NotFound {
            what: format!("no project {project_id} to move task {} to", task.id),
        });
    }
    let target = ProjectStatuses::load(batch.conn(), project_id)?;
    move_one(batch, task, project_id, &target)?;
    if task.parent_id().is_none() {
        for subtask_id in subtask_ids(batch.conn(), &task.id)? {
            let subtask = load_live(batch.conn(), &subtask_id)?;
            move_one(batch, &subtask, project_id, &target)?;
        }
    }
    Ok(())
}

fn move_one(
    batch: &mut Batch<'_>,
    task: &StoredTask,
    project_id: &str,
    target: &ProjectStatuses,
) -> Result<(), StorageError> {
    let source = ProjectStatuses::load(batch.conn(), task.project_id())?;
    // `currentStatus?.type || 'todo'`.
    let kind = source.kind_of(task.status_id()).unwrap_or(StatusKind::Todo);
    let mut changes = vec![("projectId", json!(project_id))];
    if let Some(status) = target.equivalent(kind) {
        changes.push(("statusId", json!(status.id)));
        if let Some(completed_at) = completed_at_for(task, status_kind(status), batch.now_ms())? {
            changes.push(("completedAt", completed_at));
        }
    }
    batch.edit(&task.id, changes)?;
    Ok(())
}

/// [`set_status`] inside a batch.
pub(super) fn status_in(
    batch: &mut Batch<'_>,
    task: &StoredTask,
    status_id: &str,
    kind: StatusKind,
) -> Result<bool, StorageError> {
    let mut changes = vec![("statusId", json!(status_id))];
    if let Some(completed_at) = completed_at_for(task, kind, batch.now_ms())? {
        changes.push(("completedAt", completed_at));
    }
    batch.edit(&task.id, changes)
}

/// The type of an existing status, or an error naming it.
pub(super) fn require_status_kind(
    conn: &Connection,
    status_id: &str,
) -> Result<StatusKind, StorageError> {
    status_by_id(conn, status_id)?
        .map(|status| status_kind(&status))
        .ok_or_else(|| StorageError::NotFound {
            what: format!("no status {status_id}"),
        })
}

/// [`delete_with_subtasks`] inside a batch. A task already gone is skipped.
pub(super) fn delete_in(
    batch: &mut Batch<'_>,
    task_id: &str,
    disposal: SubtaskDisposal,
) -> Result<(), StorageError> {
    if find_live(batch.conn(), task_id)?.is_none() {
        return Ok(());
    }
    for subtask_id in subtask_ids(batch.conn(), task_id)? {
        match disposal {
            SubtaskDisposal::Delete => batch.delete(&subtask_id)?,
            SubtaskDisposal::Promote => {
                batch.edit(&subtask_id, vec![("parentId", Value::Null)])?;
            }
        }
    }
    batch.delete(task_id)
}

/// The `completedAt` a status change implies, or `None` when it keeps the
/// current one: a done status stamps an open task, any other status clears a
/// completed one.
fn completed_at_for(
    task: &StoredTask,
    kind: StatusKind,
    now_ms: i64,
) -> Result<Option<Value>, StorageError> {
    Ok(match (kind, task.is_completed()) {
        (StatusKind::Done, false) => Some(json!(iso(now_ms)?)),
        (StatusKind::Todo | StatusKind::InProgress, true) => Some(Value::Null),
        _ => None,
    })
}
