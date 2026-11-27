//! The task writes of desktop's `tasks:*` handlers on [`TaskStore`]. Each runs on the vault's
//! writer in one transaction with its outbox rows, then [`after`]'s bookkeeping: activity rows,
//! the source note's task line and header status. A write on a task no vault holds answers
//! `None` where desktop answers `Task not found`.

use rusqlite::Connection;
use serde_json::{Map, Value, json};

use super::TaskStore;
use crate::api::errors::StorageError;
use crate::api::tasks_write::{after, now_iso, now_ms, source_notes};
use crate::domain::calendar::LocalDateTime;
use crate::domain::task_activity::{self, ActivityPage, ActivityQuery};
use crate::domain::task_records;
use crate::domain::tasks::{
    self, Completing, Completion, NewTask, SubtaskDisposal, TaskDetails, TaskWrite, UpdateRefusal,
};

/// Everything desktop's `createTask` takes (`TaskCreateSchema`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NewDesktopTask {
    pub title: String,
    pub project_id: String,
    pub status_id: Option<String>,
    pub parent_id: Option<String>,
    pub priority: i64,
    pub description: Option<String>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub duration_minutes: Option<i64>,
    pub start_date: Option<String>,
    pub repeat_config: Option<Value>,
    pub repeat_from: Option<String>,
    pub tags: Vec<String>,
    pub linked_note_ids: Vec<String>,
    pub linked_canvas_ids: Vec<String>,
    pub source_note_id: Option<String>,
    pub position: Option<i64>,
    pub fields: Option<Map<String, Value>>,
}

/// `Ok(None)` for a task no vault holds.
fn found<T>(result: Result<T, StorageError>) -> Result<Option<T>, StorageError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(StorageError::NotFound { .. }) => Ok(None),
        Err(error) => Err(error),
    }
}

impl TaskStore {
    /// Runs one write with the before/after bookkeeping around it.
    fn write<T, F>(&self, work: F) -> Result<T, StorageError>
    where
        F: FnOnce(&Connection, &str, i64) -> Result<(T, Option<TaskWrite>), StorageError>,
    {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let now = now_ms();
            let before = source_notes(conn)?;
            let (answer, write) = work(conn, &device_id, now)?;
            if let Some(write) = &write {
                after(conn, write, &before, &device_id, now);
            }
            Ok(answer)
        })
    }

    /// One [`TaskWrite`] answered as itself.
    fn write_all<F>(&self, work: F) -> Result<TaskWrite, StorageError>
    where
        F: FnOnce(&Connection, &str, i64) -> Result<TaskWrite, StorageError>,
    {
        self.write(|conn, device, now| {
            let write = work(conn, device, now)?;
            Ok((write.clone(), Some(write)))
        })
    }

    /// One [`TaskWrite`] on one task; `None` when no vault holds it.
    fn write_found<F>(&self, work: F) -> Result<Option<TaskWrite>, StorageError>
    where
        F: FnOnce(&Connection, &str, i64) -> Result<TaskWrite, StorageError>,
    {
        self.write(|conn, device, now| {
            let write = found(work(conn, device, now))?;
            Ok((write.clone(), write))
        })
    }

    /// Desktop's `createTask`: the new task's id, or the refusal desktop answers with
    /// `{ success: false, error }`, having written nothing. `allow_nested` is the
    /// `tasks.nestedSubtasks` setting.
    pub fn create(
        &self,
        task: NewDesktopTask,
        allow_nested: bool,
    ) -> Result<Result<String, UpdateRefusal>, StorageError> {
        self.write(move |conn, device, now| {
            let id = tasks::new_task_id();
            let parent = task.parent_id.as_deref();
            if let Some(refusal) =
                tasks::create_refusal(conn, &id, &task.project_id, parent, allow_nested)?
            {
                return Ok((Err(refusal), None));
            }
            let new = NewTask {
                id: &id,
                title: &task.title,
                project_id: &task.project_id,
                due_date: task.due_date.as_deref(),
                due_time: task.due_time.as_deref(),
                priority: task.priority,
                repeat_config: task.repeat_config.as_ref(),
                tags: &task.tags,
            };
            let details = TaskDetails {
                description: task.description.as_deref(),
                status_id: task.status_id.as_deref(),
                parent_id: parent,
                start_date: task.start_date.as_deref(),
                repeat_from: task.repeat_from.as_deref(),
                linked_note_ids: &task.linked_note_ids,
                linked_canvas_ids: &task.linked_canvas_ids,
                source_note_id: task.source_note_id.as_deref(),
                position: task.position,
                duration_minutes: task.duration_minutes,
                fields: task.fields.as_ref(),
            };
            tasks::create_detailed(conn, &new, &details, device, now)?.acknowledge();
            let write = TaskWrite {
                created: vec![id.clone()],
                ..TaskWrite::default()
            };
            Ok((Ok(id), Some(write)))
        })
    }

    /// Desktop's `deleteTask`: the task and every subtask under it, deepest first. A task no
    /// vault holds deletes nothing and succeeds, as desktop's does.
    pub fn delete(&self, id: String) -> Result<TaskWrite, StorageError> {
        self.write_all(move |conn, device, now| {
            let disposal = SubtaskDisposal::Delete;
            Ok(found(tasks::delete_with_subtasks(
                conn, &id, disposal, device, now,
            ))?
            .unwrap_or_default())
        })
    }

    /// Desktop's `completeTask` ([`tasks::complete_with`]). `local_now` is the device's wall
    /// clock, which a repeating series rolled here anchors on.
    pub fn complete(
        &self,
        id: String,
        local_now: LocalDateTime,
        how: Completing,
    ) -> Result<Option<Completion>, StorageError> {
        self.write(move |conn, device, now| {
            let completion = found(tasks::complete_with(
                conn, &id, local_now, &how, device, now,
            ))?;
            let write = completion.as_ref().map(|done| done.write.clone());
            Ok((completion, write))
        })
    }

    /// Desktop's `uncompleteTask` ([`tasks::uncomplete`]).
    pub fn uncomplete(&self, id: String) -> Result<Option<TaskWrite>, StorageError> {
        self.write_found(move |conn, device, now| tasks::uncomplete(conn, &id, device, now))
    }

    /// Desktop's `archiveTask`, or `unarchiveTask` with `false`.
    pub fn set_archived(
        &self,
        id: String,
        archived: bool,
    ) -> Result<Option<TaskWrite>, StorageError> {
        self.write_found(move |conn, device, now| {
            let at = if archived {
                json!(now_iso(now))
            } else {
                Value::Null
            };
            tasks::write_fields(conn, &id, vec![("archivedAt".to_owned(), at)], device, now)
        })
    }

    /// Desktop's `duplicateTask`: the copy, then a copy of each direct subtask under it.
    pub fn duplicate(&self, id: String) -> Result<Option<TaskWrite>, StorageError> {
        self.write_found(move |conn, device, now| tasks::duplicate(conn, &id, true, device, now))
    }

    /// Desktop's `reorderTasks`. An id no vault holds is skipped, as desktop's `UPDATE … WHERE
    /// id = ?` skips it; the caller checks that the two lists are as long.
    pub fn reorder(
        &self,
        ids: Vec<String>,
        positions: Vec<i64>,
    ) -> Result<TaskWrite, StorageError> {
        self.write_all(move |conn, device, now| {
            let (mut live, mut at) = (Vec::new(), Vec::new());
            for (id, position) in ids.into_iter().zip(positions) {
                if task_records::get(conn, &id)?.is_some() {
                    live.push(id);
                    at.push(position);
                }
            }
            tasks::reorder(conn, &live, &at, device, now)
        })
    }

    /// Desktop's `bulkComplete` ([`tasks::bulk_complete`]).
    pub fn bulk_complete(&self, ids: Vec<String>) -> Result<TaskWrite, StorageError> {
        self.write_all(move |conn, device, now| tasks::bulk_complete(conn, &ids, device, now))
    }

    /// Desktop's `bulkDelete` ([`tasks::bulk_delete`]).
    pub fn bulk_delete(&self, ids: Vec<String>) -> Result<TaskWrite, StorageError> {
        self.write_all(move |conn, device, now| tasks::bulk_delete(conn, &ids, device, now))
    }

    /// Desktop's `bulkMove` ([`tasks::bulk_move`]); a project no vault holds is `NotFound`.
    pub fn bulk_move(
        &self,
        ids: Vec<String>,
        project_id: String,
    ) -> Result<TaskWrite, StorageError> {
        self.write_all(move |conn, device, now| {
            tasks::bulk_move(conn, &ids, &project_id, device, now)
        })
    }

    /// Desktop's `bulkArchive` ([`tasks::bulk_archive`]).
    pub fn bulk_archive(&self, ids: Vec<String>) -> Result<TaskWrite, StorageError> {
        self.write_all(move |conn, device, now| tasks::bulk_archive(conn, &ids, device, now))
    }

    /// `tasks:get-activity` ([`task_activity::list`]): one task's feed inside retention, newest
    /// first, with this device's rows marked.
    pub fn activity(&self, query: ActivityQuery<'_>) -> Result<ActivityPage, StorageError> {
        let device_id = self.device_id.as_str();
        self.db
            .read_blocking(|conn| task_activity::list(conn, &query, Some(device_id), now_ms()))
    }
}
