//! Project delete (D2): the project's tasks are deleted or moved to the
//! Inbox, then the project is tombstoned and its name removed from linked
//! notes.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::storage::repositories::Change;
use crate::sync::outbox::{self, Durable};

use super::super::notes::{self, failed};
use super::super::tasks;
use super::{ITEM_TYPE, equivalent_status, inbox, links, require_live};

/// What happens to a deleted project's tasks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskDisposition {
    /// Each task moves to the Inbox, onto the equivalent status there.
    MoveToInbox,
    /// Each task is deleted — desktop's only behaviour.
    Delete,
}

/// Deletes the project (`deleteProject`). The Inbox cannot be deleted.
///
/// Its tasks — completed, archived and subtasks included — are deleted or
/// moved to the Inbox first, each through its own task write. Desktop only
/// deletes; moving is the phone's second option, and a moved task takes the
/// Inbox's equivalent status ([`super::equivalent_status`]), exactly as a
/// desktop project change does. The project is tombstoned after its tasks, and
/// its name is then removed from every linked markdown note
/// (`propagateProjectDelete`).
pub fn delete(
    conn: &Connection,
    project_id: &str,
    disposition: TaskDisposition,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<()>, StorageError> {
    let project = require_live(conn, project_id)?;
    if project.is_inbox {
        return Err(StorageError::Invalid {
            what: "cannot delete the inbox project".to_owned(),
        });
    }
    let target = match disposition {
        TaskDisposition::Delete => None,
        TaskDisposition::MoveToInbox => {
            Some(inbox(conn)?.ok_or_else(|| StorageError::Invalid {
                what: "there is no inbox project to move the tasks to".to_owned(),
            })?)
        }
    };
    let note_ids = links::markdown_note_ids(conn, project_id)?;

    for (task_id, status_id) in live_tasks(conn, project_id)? {
        // Re-read: a task write may cascade to subtasks listed after it.
        if !task_is_live(conn, &task_id)? {
            continue;
        }
        match &target {
            None => tasks::delete(conn, &task_id, device_id, now_ms)?.acknowledge(),
            Some(inbox) => {
                let mut changes = vec![("projectId", Change::set(inbox.id.as_str()))];
                if let Some(status) = equivalent_status(conn, &inbox.id, status_id.as_deref())? {
                    changes.push(("statusId", Change::set(status.id)));
                }
                tasks::edit(conn, &task_id, changes, device_id, now_ms)?.acknowledge();
            }
        }
    }

    let deleted = outbox::commit(
        conn,
        &outbox::Change::delete(ITEM_TYPE, project_id),
        now_ms,
        |tx| notes::tombstone_local(tx, ITEM_TYPE, project_id, device_id, now_ms),
    )?;
    links::remove_name_from_notes(conn, &note_ids, &project.name, device_id, now_ms)?;
    Ok(deleted)
}

/// Every live task filed under the project, with its status id: parents
/// before subtasks, so a cascading delete meets the parent first.
fn live_tasks(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<(String, Option<String>)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id, status_id FROM tasks
              WHERE project_id = ?1 AND deleted_at IS NULL
              ORDER BY parent_id IS NOT NULL, position, id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![project_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(failed)?;
    let mut tasks = Vec::new();
    for row in rows {
        tasks.push(row.map_err(failed)?);
    }
    Ok(tasks)
}

fn task_is_live(conn: &Connection, task_id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?1 AND deleted_at IS NULL)",
        params![task_id],
        |row| row.get(0),
    )
    .map_err(failed)
}
