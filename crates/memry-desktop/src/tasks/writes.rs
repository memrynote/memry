//! The task writes of `TasksService` (`tasks:create` through `tasks:bulk-archive` and
//! `tasks:get-activity` of `ipc/tasks-handlers.ts`). Core decides each rule; this layer checks
//! the zod bounds, answers Electron's envelopes and lists the events `publisher.ts` sends, in
//! its order.

use memry_core::api::errors::StorageError;
use memry_core::api::task_store::NewDesktopTask;
use memry_core::domain::task_activity::ActivityQuery;
use memry_core::domain::tasks::{Completing, Patch, TaskPatch, TaskUpdate, TaskWrite};
use serde_json::Value;

use super::service::{TaskEvent, TaskWritten, TasksService, invalid, refused};
use super::write_contract::{
    BulkIdsInput, BulkMoveInput, BulkMutation, ConvertToSubtaskInput, TaskAck,
    TaskActivityListInput, TaskActivityPageView, TaskCompleteInput, TaskCompletion,
    TaskCreateInput, TaskMoveInput, TaskReorderInput,
};

/// `Task not found`, the refusal of a write on a task no vault holds.
pub const TASK_NOT_FOUND: &str = "Task not found";
/// `tasks:reorder`'s `withDb` fallback, for lists of different lengths.
pub const REORDER_FAILED: &str = "errors:task.reorderFailed";
/// `tasks:bulk-move`'s `withDb` fallback, for a project no vault holds.
pub const MOVE_MANY_FAILED: &str = "errors:task.moveManyFailed";

impl TasksService {
    /// `tasks:create`: `errors:task.projectMissing` or `errors:task.invalidParent` write nothing.
    pub fn create(&self, input: TaskCreateInput) -> Result<TaskWritten, StorageError> {
        input.as_patch().validate()?;
        let tags = input.tags.unwrap_or_default();
        let has_tags = !tags.is_empty();
        let task = NewDesktopTask {
            title: input.title,
            project_id: input.project_id,
            status_id: input.status_id,
            parent_id: input.parent_id,
            priority: input.priority.unwrap_or(0),
            description: input.description,
            due_date: input.due_date,
            due_time: input.due_time,
            duration_minutes: input.duration_minutes,
            start_date: input.start_date,
            repeat_config: input.repeat_config,
            repeat_from: input.repeat_from,
            tags,
            linked_note_ids: input.linked_note_ids.unwrap_or_default(),
            linked_canvas_ids: input.linked_canvas_ids.unwrap_or_default(),
            source_note_id: input.source_note_id,
            position: input.position,
            fields: input.fields,
        };
        let allow_nested = self.store.nested_subtasks()?;
        let id = match self.store.create(task, allow_nested)? {
            Ok(id) => id,
            Err(refusal) => return Ok(TaskWritten::quiet(refused(refusal.error_key()))),
        };
        let mut events = vec![TaskEvent::Created(id.clone())];
        if has_tags {
            events.push(TaskEvent::TagsChanged);
        }
        Ok(TaskWritten {
            mutation: self.landed(&id)?,
            events,
        })
    }

    /// `tasks:delete`: the task and its subtasks, deepest first. A task no vault holds still
    /// succeeds and is announced, as Electron's `deleteTask` does.
    pub fn delete(&self, id: &str) -> Result<TaskWritten<TaskAck>, StorageError> {
        let write = self.store.delete(id.to_owned())?;
        Ok(TaskWritten {
            mutation: TaskAck::ok(),
            events: deleted(&write, &[id.to_owned()]),
        })
    }

    /// `tasks:complete`: the project's done status and `completedAt`, subtasks left open, and
    /// the next occurrence of a repeating task unless `recordOnly`.
    pub fn complete(
        &self,
        input: TaskCompleteInput,
    ) -> Result<TaskWritten<TaskCompletion>, StorageError> {
        if let Some(at) = &input.completed_at
            && !is_iso_instant(at)
        {
            return Err(invalid("completedAt must be an ISO datetime"));
        }
        let how = Completing {
            subtasks: false,
            roll: !input.record_only.unwrap_or(false),
            completed_at: input.completed_at,
        };
        let Some(done) = self.store.complete(input.id.clone(), (self.now)(), how)? else {
            return Ok(TaskWritten::quiet(TaskCompletion {
                success: false,
                task: None,
                next_occurrence: None,
                error: Some(TASK_NOT_FOUND.to_owned()),
            }));
        };
        let next = match &done.next_occurrence {
            Some(next) => self.get(&next.id)?,
            None => None,
        };
        let mut events = vec![TaskEvent::Completed(input.id.clone())];
        if let Some(next) = &next {
            events.push(TaskEvent::Created(next.task.id.clone()));
            if !next.task.tags.is_empty() {
                events.push(TaskEvent::TagsChanged);
            }
        }
        Ok(TaskWritten {
            mutation: TaskCompletion {
                success: true,
                task: self.get(&input.id)?,
                next_occurrence: next,
                error: None,
            },
            events,
        })
    }

    /// `tasks:uncomplete`: no `completedAt`, and a task in a done status moves to the default
    /// open status.
    pub fn uncomplete(&self, id: &str) -> Result<TaskWritten, StorageError> {
        match self.store.uncomplete(id.to_owned())? {
            Some(_) => self.updated(id),
            None => Ok(TaskWritten::quiet(refused(TASK_NOT_FOUND))),
        }
    }

    /// `tasks:archive`, or `tasks:unarchive` with `false`.
    pub fn set_archived(
        &self,
        id: &str,
        archived: bool,
    ) -> Result<TaskWritten<TaskAck>, StorageError> {
        Ok(match self.store.set_archived(id.to_owned(), archived)? {
            Some(_) => TaskWritten {
                mutation: TaskAck::ok(),
                events: vec![TaskEvent::Updated(id.to_owned())],
            },
            None => TaskWritten::quiet(TaskAck::refused(TASK_NOT_FOUND)),
        })
    }

    /// `tasks:move`: project, status, parent and position in one write. A status the move
    /// names wins; without one, a project change takes the equivalent status. A done status
    /// completes the task and rolls a repeating one.
    pub fn move_task(&self, input: TaskMoveInput) -> Result<TaskWritten, StorageError> {
        let (id, patch) = input.patch();
        let update = match self.patch(&id, patch)? {
            Ok(update) => update,
            Err(refusal) => return Ok(TaskWritten::quiet(refused(refusal))),
        };
        let mut events = vec![TaskEvent::Moved(id.clone())];
        events.extend(
            update
                .next_occurrence
                .map(|next| TaskEvent::Created(next.id)),
        );
        Ok(TaskWritten {
            mutation: self.landed(&id)?,
            events,
        })
    }

    /// `tasks:reorder`. Lists of different lengths write nothing and answer Electron's
    /// fallback key. It sends no renderer event, as Electron's `taskReordered` sends none.
    pub fn reorder(&self, input: TaskReorderInput) -> Result<TaskWritten<TaskAck>, StorageError> {
        if input.task_ids.len() != input.positions.len() {
            return Ok(TaskWritten::quiet(TaskAck::refused(REORDER_FAILED)));
        }
        self.store.reorder(input.task_ids, input.positions)?;
        Ok(TaskWritten::quiet(TaskAck::ok()))
    }

    /// `tasks:duplicate`: "Copy of" the task, then a copy of each direct subtask under it.
    pub fn duplicate(&self, id: &str) -> Result<TaskWritten, StorageError> {
        let Some(write) = self.store.duplicate(id.to_owned())? else {
            return Ok(TaskWritten::quiet(refused(TASK_NOT_FOUND)));
        };
        let mut events = Vec::new();
        for created in &write.created {
            events.push(TaskEvent::Created(created.clone()));
            if self
                .get(created)?
                .is_some_and(|copy| !copy.task.tags.is_empty())
            {
                events.push(TaskEvent::TagsChanged);
            }
        }
        let copy = write.created.first().map(String::as_str).unwrap_or(id);
        Ok(TaskWritten {
            mutation: self.landed(copy)?,
            events,
        })
    }

    /// `tasks:convert-to-subtask`.
    pub fn convert_to_subtask(
        &self,
        input: ConvertToSubtaskInput,
    ) -> Result<TaskWritten, StorageError> {
        let patch = TaskPatch {
            parent_id: Patch::Set(input.parent_id),
            ..TaskPatch::default()
        };
        match self.patch(&input.task_id, patch)? {
            Ok(_) => self.updated(&input.task_id),
            Err(refusal) => Ok(TaskWritten::quiet(refused(refusal))),
        }
    }

    /// `tasks:convert-to-task`: the task leaves its parent.
    pub fn convert_to_task(&self, id: &str) -> Result<TaskWritten, StorageError> {
        let patch = TaskPatch {
            parent_id: Patch::Clear,
            ..TaskPatch::default()
        };
        match self.patch(id, patch)? {
            Ok(_) => self.updated(id),
            Err(refusal) => Ok(TaskWritten::quiet(refused(refusal))),
        }
    }

    /// `tasks:bulk-complete`: done status and `completedAt` for each open task, in one
    /// transaction; no subtask cascade and no roll, as desktop's `bulkComplete`.
    pub fn bulk_complete(
        &self,
        input: BulkIdsInput,
    ) -> Result<TaskWritten<BulkMutation>, StorageError> {
        let write = self.store.bulk_complete(input.ids.clone())?;
        self.bulk(&input.ids, &write, TaskEvent::Completed)
    }

    /// `tasks:bulk-delete`: each task and its subtasks, in one transaction.
    pub fn bulk_delete(
        &self,
        input: BulkIdsInput,
    ) -> Result<TaskWritten<BulkMutation>, StorageError> {
        let write = self.store.bulk_delete(input.ids.clone())?;
        let count = input
            .ids
            .iter()
            .filter(|id| write.deleted.contains(id))
            .count();
        Ok(TaskWritten {
            mutation: bulk_ok(count),
            events: deleted(&write, &input.ids),
        })
    }

    /// `tasks:bulk-move`: each task, subtasks following, into the project, in one transaction.
    pub fn bulk_move(
        &self,
        input: BulkMoveInput,
    ) -> Result<TaskWritten<BulkMutation>, StorageError> {
        let write = match self.store.bulk_move(input.ids.clone(), input.project_id) {
            Ok(write) => write,
            Err(StorageError::NotFound { .. }) => {
                return Ok(TaskWritten::quiet(BulkMutation {
                    success: false,
                    count: 0,
                    error: Some(MOVE_MANY_FAILED.to_owned()),
                }));
            }
            Err(error) => return Err(error),
        };
        self.bulk(&input.ids, &write, TaskEvent::Updated)
    }

    /// `tasks:bulk-archive`, in one transaction.
    pub fn bulk_archive(
        &self,
        input: BulkIdsInput,
    ) -> Result<TaskWritten<BulkMutation>, StorageError> {
        let write = self.store.bulk_archive(input.ids.clone())?;
        self.bulk(&input.ids, &write, TaskEvent::Updated)
    }

    /// `tasks:get-activity`; `TaskActivityListSchema` bounds `limit` to 1 through 200
    /// (default 50) and `offset` to at least 0.
    pub fn activity(
        &self,
        input: TaskActivityListInput,
    ) -> Result<TaskActivityPageView, StorageError> {
        if input.task_id.is_empty() {
            return Err(invalid("taskId must not be empty"));
        }
        let limit = input.limit.unwrap_or(50);
        if !(1..=200).contains(&limit) {
            return Err(invalid("limit must be 1 to 200"));
        }
        let offset = input.offset.unwrap_or(0);
        if offset < 0 {
            return Err(invalid("offset must be at least 0"));
        }
        let actions = input.actions.unwrap_or_default();
        let query = ActivityQuery {
            task_id: &input.task_id,
            actions: &actions,
            limit: usize::try_from(limit).unwrap_or(50),
            offset: usize::try_from(offset).map_err(|_| invalid("offset is too large"))?,
        };
        Ok(self.store.activity(query)?.into())
    }

    /// One patch through core's `updateTask`; `Err` is the refusal's key.
    fn patch(
        &self,
        id: &str,
        patch: TaskPatch,
    ) -> Result<Result<TaskUpdate, &'static str>, StorageError> {
        let allow_nested = self.store.nested_subtasks()?;
        Ok(self
            .store
            .update(id.to_owned(), patch, (self.now)(), allow_nested)?
            .map_err(|refusal| refusal.error_key()))
    }

    /// A landed write on `id` announced as `tasks:updated`.
    fn updated(&self, id: &str) -> Result<TaskWritten, StorageError> {
        Ok(TaskWritten {
            mutation: self.landed(id)?,
            events: vec![TaskEvent::Updated(id.to_owned())],
        })
    }

    /// A bulk write's envelope: the selected tasks it changed, and `event` for each selected
    /// task still live, as Electron announces each one it reads back.
    fn bulk(
        &self,
        ids: &[String],
        write: &TaskWrite,
        event: fn(String) -> TaskEvent,
    ) -> Result<TaskWritten<BulkMutation>, StorageError> {
        let changed = write.changed_ids();
        let count = ids.iter().filter(|id| changed.contains(id)).count();
        let mut events = Vec::new();
        for id in ids {
            if self.get(id)?.is_some() {
                events.push(event(id.clone()));
            }
        }
        Ok(TaskWritten {
            mutation: bulk_ok(count),
            events,
        })
    }
}

fn bulk_ok(count: usize) -> BulkMutation {
    BulkMutation {
        success: true,
        count: i64::try_from(count).unwrap_or(i64::MAX),
        error: None,
    }
}

/// `taskDeleted` for each tombstoned task, and for each `asked` id the write did not find, as
/// Electron announces every id it was asked to delete; each followed by tags-changed when the
/// deleted task carried tags.
fn deleted(write: &TaskWrite, asked: &[String]) -> Vec<TaskEvent> {
    let tagged = |id: &str| {
        write.removed.iter().any(|removed| {
            removed.task_id == id
                && removed
                    .payload
                    .get("tags")
                    .and_then(Value::as_array)
                    .is_some_and(|tags| !tags.is_empty())
        })
    };
    let missing = asked.iter().filter(|id| !write.deleted.contains(id));
    let mut events = Vec::new();
    for id in write.deleted.iter().chain(missing) {
        events.push(TaskEvent::Deleted(id.clone()));
        if tagged(id) {
            events.push(TaskEvent::TagsChanged);
        }
    }
    events
}

/// `z.iso.datetime()`: an RFC 3339 instant in UTC (`Z`).
fn is_iso_instant(value: &str) -> bool {
    value.ends_with('Z') && chrono::DateTime::parse_from_rfc3339(value).is_ok()
}
