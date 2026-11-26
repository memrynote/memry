//! `TasksService`: the open vault's task and status commands (`tasks:*` of
//! `apps/desktop/src/main/ipc/tasks-handlers.ts`) over core's [`TaskStore`]. The core decides
//! every rule; this layer checks the zod bounds the core does not, maps a refusal to the
//! `withDb` envelope (`{ success: false, error }`) and says what the shell must announce.

use std::sync::Arc;

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::{AuthError, StorageError};
use memry_core::api::task_store::TaskStore;
use memry_core::domain::calendar::LocalDateTime;
use memry_core::domain::projects::{NewStatus, StatusPatch};
use memry_core::seams::secure_store::SecureStore;

use super::contract::{
    StatusCreateInput, StatusMutation, StatusReorderInput, StatusUpdateInput, StatusView,
    TaskListInput, TaskListItemView, TaskMutation, TaskPageView, TaskStatsView, TaskTagCount,
    TaskUpdateInput, TaskView,
};
use crate::session::OpenVault;

/// `createStatus` falls back to this when its write throws (`tasks-handlers.ts`).
pub const STATUS_CREATE_FAILED: &str = "errors:taskStatus.createFailed";
/// `updateStatus`'s refusal of an id no project holds.
pub const STATUS_NOT_FOUND: &str = "Status not found";

/// The device's wall clock as a local date and time.
pub fn local_now() -> LocalDateTime {
    let local = chrono::Local::now().naive_local();
    LocalDateTime::from_ms(local.and_utc().timestamp_millis())
}

/// One renderer event of a committed task write, as `publisher.ts` sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskEvent {
    /// `tasks:created`.
    Created(String),
    /// `tasks:updated`.
    Updated(String),
    /// `tasks:deleted`.
    Deleted(String),
    /// `tasks:completed`.
    Completed(String),
    /// `tasks:moved`.
    Moved(String),
    /// `notes:tags-changed`: task tags share the global tag list.
    TagsChanged,
}

/// A task command's answer and the events the shell sends for it, in Electron's order. A
/// refusal has no events.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskWritten<M = TaskMutation> {
    pub mutation: M,
    pub events: Vec<TaskEvent>,
}

impl<M> TaskWritten<M> {
    pub fn quiet(mutation: M) -> Self {
        Self {
            mutation,
            events: Vec::new(),
        }
    }
}

pub struct TasksService {
    pub(super) store: TaskStore,
    pub(super) now: fn() -> LocalDateTime,
}

impl TasksService {
    /// The service of the open vault, with the device's signing identity in place.
    pub fn open(open: &OpenVault, store: Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        ensure_device_identity(store.clone())?;
        Ok(Self::new(open.vault.task_store(&store)?))
    }

    pub fn new(store: TaskStore) -> Self {
        Self {
            store,
            now: local_now,
        }
    }

    /// The same service on another clock (tests).
    pub fn with_clock(self, now: fn() -> LocalDateTime) -> Self {
        Self { now, ..self }
    }

    /// `tasks:get`.
    pub fn get(&self, id: &str) -> Result<Option<TaskListItemView>, StorageError> {
        Ok(self.store.get(id)?.map(Into::into))
    }

    /// `tasks:list`; a `TaskListSchema` bound it breaks is `Invalid`.
    pub fn list(&self, input: TaskListInput) -> Result<TaskPageView, StorageError> {
        let query = input.query().map_err(invalid)?;
        Ok(self.store.list(&query)?.into())
    }

    /// `tasks:get-subtasks`.
    pub fn subtasks(&self, parent_id: &str) -> Result<Vec<TaskListItemView>, StorageError> {
        Ok(views(self.store.subtasks(parent_id)?))
    }

    /// `tasks:get-tags`.
    pub fn tags(&self) -> Result<Vec<TaskTagCount>, StorageError> {
        Ok(views(self.store.tag_counts()?))
    }

    /// `tasks:get-stats`.
    pub fn stats(&self) -> Result<TaskStatsView, StorageError> {
        Ok(self.store.stats((self.now)())?.into())
    }

    /// `tasks:get-today`.
    pub fn today(&self) -> Result<Vec<TaskListItemView>, StorageError> {
        Ok(views(self.store.today((self.now)())?))
    }

    /// `tasks:get-upcoming`; `GetUpcomingSchema` bounds `days` to 1 through 365, default 7.
    pub fn upcoming(&self, days: Option<i64>) -> Result<Vec<TaskListItemView>, StorageError> {
        let days = days.unwrap_or(7);
        if !(1..=365).contains(&days) {
            return Err(invalid("days must be 1 to 365"));
        }
        Ok(views(self.store.upcoming((self.now)(), days)?))
    }

    /// `tasks:get-overdue`.
    pub fn overdue(&self) -> Result<Vec<TaskListItemView>, StorageError> {
        Ok(views(self.store.overdue((self.now)())?))
    }

    /// `tasks:get-linked-tasks`: the tasks whose `linkedNoteIds` name the note.
    pub fn linked_tasks(&self, note_id: &str) -> Result<Vec<TaskView>, StorageError> {
        Ok(views(self.store.linked_tasks(note_id)?))
    }

    /// `tasks:update`. A refusal is the envelope with `UpdateRefusal::error_key` and writes
    /// nothing; a `TaskUpdateSchema` bound the patch breaks is `Invalid`.
    pub fn update(&self, input: TaskUpdateInput) -> Result<TaskWritten, StorageError> {
        let (id, patch) = input.patch();
        let allow_nested = self.store.nested_subtasks()?;
        let update = match self
            .store
            .update(id.clone(), patch, (self.now)(), allow_nested)?
        {
            Ok(update) => update,
            Err(refusal) => return Ok(TaskWritten::quiet(refused(refusal.error_key()))),
        };
        // `taskUpdated`, its tags-changed, then the rolled occurrence's `taskCreated`.
        let mut events = vec![TaskEvent::Updated(id.clone())];
        if update.changed_fields.iter().any(|field| field == "tags") {
            events.push(TaskEvent::TagsChanged);
        }
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

    /// The `{ success: true, task }` envelope of a write that landed on `id`.
    pub(super) fn landed(&self, id: &str) -> Result<TaskMutation, StorageError> {
        Ok(TaskMutation {
            success: true,
            task: self.get(id)?,
            error: None,
        })
    }

    /// `tasks:status-list`.
    pub fn statuses(&self, project_id: &str) -> Result<Vec<StatusView>, StorageError> {
        Ok(views(self.store.statuses(project_id)?))
    }

    /// `tasks:status-create`. A project no vault holds is Electron's fallback key, as its
    /// foreign key throws there.
    pub fn create_status(&self, input: StatusCreateInput) -> Result<StatusMutation, StorageError> {
        let status = NewStatus {
            project_id: &input.project_id,
            name: &input.name,
            color: input.color.as_deref(),
            is_done: input.is_done.unwrap_or(false),
        };
        match self.store.create_status(status) {
            Ok(status) => Ok(StatusMutation::ok(Some(status.into()))),
            Err(StorageError::NotFound { .. }) => Ok(StatusMutation::refused(STATUS_CREATE_FAILED)),
            Err(error) => Err(error),
        }
    }

    /// `tasks:status-update`.
    pub fn update_status(&self, input: StatusUpdateInput) -> Result<StatusMutation, StorageError> {
        let patch = StatusPatch {
            name: input.name.as_deref(),
            color: input.color.as_deref(),
            position: input.position,
            is_default: input.is_default,
            is_done: input.is_done,
        };
        match self.store.update_status(&input.id, patch) {
            Ok(status) => Ok(StatusMutation::ok(Some(status.into()))),
            Err(StorageError::NotFound { .. }) => Ok(StatusMutation::refused(STATUS_NOT_FOUND)),
            Err(error) => Err(error),
        }
    }

    /// `tasks:status-delete`: succeeds for an id no project holds, as Electron does.
    pub fn delete_status(&self, id: &str) -> Result<StatusMutation, StorageError> {
        self.store.delete_status(id)?;
        Ok(StatusMutation::ok(None))
    }

    /// `tasks:status-reorder`.
    pub fn reorder_statuses(
        &self,
        input: StatusReorderInput,
    ) -> Result<StatusMutation, StorageError> {
        let ids: Vec<&str> = input.status_ids.iter().map(String::as_str).collect();
        self.store.reorder_statuses(&ids, &input.positions)?;
        Ok(StatusMutation::ok(None))
    }
}

/// The `{ success: false, task: null, error }` envelope.
pub(super) fn refused(error: &str) -> TaskMutation {
    TaskMutation {
        success: false,
        task: None,
        error: Some(error.to_owned()),
    }
}

fn views<T, V: From<T>>(items: Vec<T>) -> Vec<V> {
    items.into_iter().map(Into::into).collect()
}

pub(super) fn invalid(what: &str) -> StorageError {
    StorageError::Invalid {
        what: what.to_owned(),
    }
}
