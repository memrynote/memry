//! Writes that touch more than one task, as **one** transaction.
//!
//! Completing a parent completes its open subtasks; completing a repeating
//! task closes it and creates the next occurrence; a bulk action edits every
//! selected task. Each of those is one user action, so each is one
//! transaction: every payload merge and every outbox row commits together or
//! not at all (FR-030), exactly as the single-task writes in [`super`] do
//! through [`crate::sync::outbox::commit`].
//!
//! [`TaskWrite`] is what such a write reports back: the prior value of every
//! field it changed, and the ids it created and deleted — what a shell needs
//! to show the result and to offer an undo ([`undo`]).

use std::collections::HashMap;

use rusqlite::{Connection, Transaction};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::storage::repositories::Change;
use crate::storage::repositories::schema::Object;
use crate::sync::field_merge::TASK_SYNCABLE_FIELDS;
use crate::sync::outbox;

use super::super::notes::{failed, insert_local, tombstone_local};
use super::create::seeded;
use super::model::{find_live, new_task_id};
use super::{ITEM_TYPE, edit_merged_in};

/// The fields outside `TASK_SYNCABLE_FIELDS` a task write may change. They
/// merge by no field clock (§6.7), but they are still user data an undo
/// restores.
const UNCLOCKED_FIELDS: [&str; 3] = ["tags", "linkedNoteIds", "linkedCanvasIds"];

/// What one task looked like before a write changed it: each changed field
/// with its **prior** value (`null` when the key was absent or null).
#[derive(Debug, Clone, PartialEq)]
pub struct Prior {
    pub task_id: String,
    pub fields: Vec<(String, Value)>,
}

/// The result of a task write that may touch several tasks.
///
/// A task edited twice in one write appears twice in `changed`, in write
/// order; [`undo`] replays `changed` newest first, so that is still exact.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TaskWrite {
    /// Every task the write edited, with the prior value of each field it
    /// actually changed. A field already holding the target value is not a
    /// change and is neither written nor listed.
    pub changed: Vec<Prior>,
    /// Ids of the tasks the write created, in creation order.
    pub created: Vec<String>,
    /// Ids of the tasks the write tombstoned.
    pub deleted: Vec<String>,
    /// Each tombstoned task's payload as it was just before the delete, so
    /// [`undo`] can bring it back.
    pub removed: Vec<Removed>,
}

/// A deleted task's last live payload, verbatim (unknown keys included, D7).
#[derive(Debug, Clone, PartialEq)]
pub struct Removed {
    pub task_id: String,
    pub payload: Object,
}

impl TaskWrite {
    /// Whether the write changed nothing at all.
    pub fn is_empty(&self) -> bool {
        self.changed.is_empty() && self.created.is_empty() && self.deleted.is_empty()
    }

    /// The edited task ids, each once, in first-edit order.
    pub fn changed_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        for prior in &self.changed {
            if !ids.contains(&prior.task_id) {
                ids.push(prior.task_id.clone());
            }
        }
        ids
    }
}

/// One open transaction plus the report of what it wrote.
pub(super) struct Batch<'c> {
    tx: Transaction<'c>,
    device_id: String,
    now_ms: i64,
    write: TaskWrite,
}

impl<'c> Batch<'c> {
    pub(super) fn open(
        conn: &'c Connection,
        device_id: &str,
        now_ms: i64,
    ) -> Result<Self, StorageError> {
        Ok(Self {
            tx: conn.unchecked_transaction().map_err(failed)?,
            device_id: device_id.to_owned(),
            now_ms,
            write: TaskWrite::default(),
        })
    }

    pub(super) fn conn(&self) -> &Connection {
        &self.tx
    }

    pub(super) fn now_ms(&self) -> i64 {
        self.now_ms
    }

    /// Edits one task: drops every change that would not change the stored
    /// value, then — when anything is left — ticks the document clock and the
    /// changed fields' clocks, merges, and queues the outbox row. Returns
    /// whether anything was written.
    pub(super) fn edit(
        &mut self,
        task_id: &str,
        changes: Vec<(&'static str, Value)>,
    ) -> Result<bool, StorageError> {
        let Some(stored) = find_live(&self.tx, task_id)? else {
            return Err(StorageError::NotFound {
                what: format!("no task {task_id}"),
            });
        };
        let mut prior = Vec::new();
        let mut effective = Vec::new();
        for (key, value) in changes {
            let before = stored.value(key);
            if before == value {
                continue;
            }
            prior.push((key.to_owned(), before));
            effective.push((key, Change::Set(value)));
        }
        if effective.is_empty() {
            return Ok(false);
        }
        edit_merged_in(
            &self.tx,
            ITEM_TYPE,
            &TASK_SYNCABLE_FIELDS,
            task_id,
            effective,
            &self.device_id,
            self.now_ms,
        )?;
        outbox::enqueue(
            &self.tx,
            &outbox::Change::upsert(ITEM_TYPE, task_id),
            self.now_ms,
        )?;
        self.write.changed.push(Prior {
            task_id: task_id.to_owned(),
            fields: prior,
        });
        Ok(true)
    }

    /// Inserts a new task payload the caller built and queues it.
    pub(super) fn create(
        &mut self,
        task_id: &str,
        payload: Object,
    ) -> Result<String, StorageError> {
        let stored = insert_local(&self.tx, ITEM_TYPE, task_id, payload, self.now_ms)?;
        outbox::enqueue(
            &self.tx,
            &outbox::Change::upsert(ITEM_TYPE, task_id),
            self.now_ms,
        )?;
        self.write.created.push(task_id.to_owned());
        Ok(stored)
    }

    /// Tombstones one task and queues the delete.
    pub(super) fn delete(&mut self, task_id: &str) -> Result<(), StorageError> {
        if let Some(stored) = find_live(&self.tx, task_id)? {
            self.write.removed.push(Removed {
                task_id: task_id.to_owned(),
                payload: stored.object,
            });
        }
        tombstone_local(&self.tx, ITEM_TYPE, task_id, &self.device_id, self.now_ms)?;
        outbox::enqueue(
            &self.tx,
            &outbox::Change::delete(ITEM_TYPE, task_id),
            self.now_ms,
        )?;
        self.write.deleted.push(task_id.to_owned());
        Ok(())
    }

    /// Commits, and only then reports (§C.4: durable before acknowledged).
    pub(super) fn commit(self) -> Result<TaskWrite, StorageError> {
        self.tx.commit().map_err(failed)?;
        Ok(self.write)
    }
}

/// Reverts a [`TaskWrite`] as one new local write: every deleted task comes
/// back, every changed field is set back to its prior value (newest change
/// first) and every created task is tombstoned.
///
/// A new write, not a rollback: the clocks tick again, so the revert syncs
/// like any other edit. A task that has since been deleted is skipped.
///
/// **A deleted task returns under a new id.** A tombstone is final on the wire
/// (a peer that saw the delete never resurrects the id), so this recreates
/// the task from its last payload, as desktop's undo does (`addTask(snapshot)`
/// in `use-undoable-task-actions.ts`). Subtasks deleted with their parent come
/// back under the parent's new id, and a prior `parentId` that named a
/// deleted task is rewritten to its new id.
pub fn undo(
    conn: &Connection,
    write: &TaskWrite,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    let mut batch = Batch::open(conn, device_id, now_ms)?;
    let renamed: HashMap<&str, String> = write
        .removed
        .iter()
        .map(|removed| (removed.task_id.as_str(), new_task_id()))
        .collect();
    let remap = |value: &Value| match value.as_str().and_then(|id| renamed.get(id)) {
        Some(id) => Value::String(id.clone()),
        None => value.clone(),
    };
    let (parents, subtasks): (Vec<&Removed>, Vec<&Removed>) =
        write.removed.iter().partition(|removed| {
            !removed
                .payload
                .get("parentId")
                .is_some_and(|p| !p.is_null())
        });
    for removed in parents.into_iter().chain(subtasks) {
        let Some(id) = renamed.get(removed.task_id.as_str()) else {
            continue;
        };
        let mut fields = removed.payload.clone();
        for key in [
            "id",
            "clock",
            "fieldClocks",
            "createdAt",
            "modifiedAt",
            "deletedAt",
        ] {
            fields.remove(key);
        }
        if let Some(parent) = fields.get("parentId").map(&remap) {
            fields.insert("parentId".to_owned(), parent);
        }
        batch.create(id, seeded(fields, device_id, now_ms)?)?;
    }
    for prior in write.changed.iter().rev() {
        if find_live(batch.conn(), &prior.task_id)?.is_none() {
            continue;
        }
        let mut changes = Vec::new();
        for (field, value) in &prior.fields {
            let value = if field == "parentId" {
                remap(value)
            } else {
                value.clone()
            };
            changes.push((restorable_field(field)?, value));
        }
        batch.edit(&prior.task_id, changes)?;
    }
    for task_id in &write.created {
        if find_live(batch.conn(), task_id)?.is_some() {
            batch.delete(task_id)?;
        }
    }
    batch.commit()
}

/// Writes one task's fields in one transaction and reports what they were
/// before, so any edit can be undone the way a batch can (spec 004 TP051).
///
/// Only task fields are accepted (the same list an undo may restore); a field
/// already holding the value is skipped with no clock tick and no outbox row.
pub fn write_fields(
    conn: &Connection,
    task_id: &str,
    changes: Vec<(String, Value)>,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    let mut batch = Batch::open(conn, device_id, now_ms)?;
    let mut typed = Vec::new();
    for (field, value) in changes {
        typed.push((restorable_field(&field)?, value));
    }
    batch.edit(task_id, typed)?;
    batch.commit()
}

/// The static spelling of a field an undo may write, or an error for any
/// other key: a [`Prior`] is data the shell handed back, and it must not be a
/// way to write `clock` or `fieldClocks`.
fn restorable_field(field: &str) -> Result<&'static str, StorageError> {
    TASK_SYNCABLE_FIELDS
        .iter()
        .chain(UNCLOCKED_FIELDS.iter())
        .copied()
        .find(|known| *known == field)
        .ok_or_else(|| StorageError::Invalid {
            what: format!("`{field}` is not a task field an undo can restore"),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_task_fields_are_restorable() {
        assert_eq!(restorable_field("statusId").ok(), Some("statusId"));
        assert_eq!(restorable_field("tags").ok(), Some("tags"));
        assert!(restorable_field("clock").is_err());
        assert!(restorable_field("fieldClocks").is_err());
    }

    #[test]
    fn changed_ids_lists_each_task_once() {
        let prior = |id: &str| Prior {
            task_id: id.to_owned(),
            fields: Vec::new(),
        };
        let write = TaskWrite {
            changed: vec![prior("a"), prior("b"), prior("a")],
            ..TaskWrite::default()
        };
        assert_eq!(write.changed_ids(), ["a", "b"]);
    }
}
