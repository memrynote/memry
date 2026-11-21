//! The desktop task surface: plain Rust over one opened vault, not on the FFI
//! surface. iOS keeps [`super::tasks::Tasks`]; desktop's tasks service calls
//! this and returns domain types.
//!
//! Every write runs on the vault's writer in one transaction with its outbox
//! rows, then the same after-commit bookkeeping as [`super::tasks::Tasks`]:
//! activity rows, the source note's task line and header status
//! ([`super::tasks_write::after`]).

use std::sync::Arc;

use crate::api::errors::{AuthError, StorageError};
use crate::api::tasks::Tasks;
use crate::api::tasks_write::{after, now_ms, source_notes};
use crate::domain::calendar::LocalDateTime;
use crate::domain::projects::{
    self, NewStatus, Status, StatusPatch, create_status, delete_status, reorder_statuses,
    update_status,
};
use crate::domain::task_records::TaskRecord;
use crate::domain::tasks::list::{self, ListQuery, TagCount, TaskListItem, TaskPage};
use crate::domain::tasks::stats::{self, TaskStats};
use crate::domain::tasks::{self, TaskPatch, TaskUpdate, UpdateRefusal};
use crate::domain::{task_links, task_settings};
use crate::seams::secure_store::SecureStore;
use crate::storage::Db;

mod project_writes;
mod writes;

pub use project_writes::{ProjectRefusal, StoredProject};
pub use writes::NewDesktopTask;

/// Built by [`crate::api::vault::Vault::task_store`].
pub struct TaskStore {
    db: Db,
    device_id: String,
}

impl TaskStore {
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        let Tasks { db, device_id } = Tasks::over(db, store)?;
        Ok(Self { db, device_id })
    }

    /// Desktop's `updateTask`: every field of `patch` in one transaction
    /// ([`tasks::update::apply`]). `Ok(Err(_))` is a refusal desktop answers
    /// with `{ success: false, error }`; nothing was written. `allow_nested`
    /// is the `tasks.nestedSubtasks` setting.
    pub fn update(
        &self,
        id: String,
        patch: TaskPatch,
        local_now: LocalDateTime,
        allow_nested: bool,
    ) -> Result<Result<TaskUpdate, UpdateRefusal>, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let now = now_ms();
            let before = source_notes(conn)?;
            let update =
                tasks::update::apply(conn, &id, &patch, local_now, allow_nested, &device_id, now)?;
            if let Ok(update) = &update {
                after(conn, &update.write, &before, &device_id, now);
            }
            Ok(update)
        })
    }

    /// `tasks:get` ([`list::get`]).
    pub fn get(&self, id: &str) -> Result<Option<TaskListItem>, StorageError> {
        self.db.read_blocking(|conn| list::get(conn, id))
    }

    /// `tasks:list` ([`list::page`]).
    pub fn list(&self, query: &ListQuery) -> Result<TaskPage, StorageError> {
        self.db.read_blocking(|conn| list::page(conn, query))
    }

    /// `tasks:get-subtasks` ([`list::subtasks`]).
    pub fn subtasks(&self, parent_id: &str) -> Result<Vec<TaskListItem>, StorageError> {
        self.db
            .read_blocking(|conn| list::subtasks(conn, parent_id))
    }

    /// `tasks:get-tags` ([`list::tag_counts`]).
    pub fn tag_counts(&self) -> Result<Vec<TagCount>, StorageError> {
        self.db.read_blocking(list::tag_counts)
    }

    /// `tasks:get-stats`; `local_now` is the device's wall clock.
    pub fn stats(&self, local_now: LocalDateTime) -> Result<TaskStats, StorageError> {
        self.db
            .read_blocking(|conn| stats::stats(conn, local_now.date()))
    }

    /// `tasks:get-today`.
    pub fn today(&self, local_now: LocalDateTime) -> Result<Vec<TaskListItem>, StorageError> {
        self.db
            .read_blocking(|conn| stats::today(conn, local_now.date()))
    }

    /// `tasks:get-upcoming`: due within `days` of today.
    pub fn upcoming(
        &self,
        local_now: LocalDateTime,
        days: i64,
    ) -> Result<Vec<TaskListItem>, StorageError> {
        self.db
            .read_blocking(|conn| stats::upcoming(conn, local_now.date(), days))
    }

    /// `tasks:get-overdue`.
    pub fn overdue(&self, local_now: LocalDateTime) -> Result<Vec<TaskListItem>, StorageError> {
        self.db
            .read_blocking(|conn| stats::overdue(conn, local_now.date()))
    }

    /// `tasks:get-linked-tasks` ([`task_links::linked_tasks`]).
    pub fn linked_tasks(&self, note_id: &str) -> Result<Vec<TaskRecord>, StorageError> {
        self.db
            .read_blocking(|conn| task_links::linked_tasks(conn, note_id))
    }

    /// `tasks:status-list` ([`projects::statuses`]).
    pub fn statuses(&self, project_id: &str) -> Result<Vec<Status>, StorageError> {
        self.db
            .read_blocking(|conn| projects::statuses(conn, project_id))
    }

    /// `tasks:status-create` ([`projects::create_status`]).
    pub fn create_status(&self, status: NewStatus<'_>) -> Result<Status, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            create_status(conn, &status, &device_id, now_ms()).map(|d| d.acknowledge())
        })
    }

    /// `tasks:status-update` ([`projects::update_status`]): the status after
    /// the edit. An edit that changes nothing writes nothing and reads it back.
    pub fn update_status(&self, id: &str, patch: StatusPatch<'_>) -> Result<Status, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            if let Some(written) = update_status(conn, id, &patch, &device_id, now_ms())? {
                return Ok(written.acknowledge());
            }
            projects::status_by_id(conn, id)?.ok_or_else(|| StorageError::NotFound {
                what: format!("no status {id}"),
            })
        })
    }

    /// The `tasks.nestedSubtasks` setting [`TaskStore::update`] takes.
    pub fn nested_subtasks(&self) -> Result<bool, StorageError> {
        self.db
            .read_blocking(|conn| task_settings::read(conn).map(|s| s.nested_subtasks))
    }

    /// `tasks:status-delete` ([`projects::delete_status`]): the project the
    /// status left, `None` when no live project held it.
    pub fn delete_status(&self, id: &str) -> Result<Option<String>, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            delete_status(conn, id, &device_id, now_ms())
                .map(|written| written.map(|d| d.acknowledge()))
        })
    }

    /// `tasks:status-reorder` ([`projects::reorder_statuses`]): the moved
    /// statuses, one commit per project.
    pub fn reorder_statuses(
        &self,
        ids: &[&str],
        positions: &[i64],
    ) -> Result<Vec<Status>, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let written = reorder_statuses(conn, ids, positions, &device_id, now_ms())?;
            Ok(written.into_iter().flat_map(|d| d.acknowledge()).collect())
        })
    }
}
