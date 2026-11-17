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
}
