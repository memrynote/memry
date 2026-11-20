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
use crate::domain::tasks::list::{self, ListQuery, TagCount, TaskListItem, TaskPage};
use crate::domain::tasks::stats::{self, TaskStats};
use crate::domain::tasks::{self, TaskPatch, TaskUpdate, UpdateRefusal};
use crate::seams::secure_store::SecureStore;
use crate::storage::Db;

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
}
