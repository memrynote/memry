//! The tasks that link to a note or a canvas (`tasks:get-linked-tasks`,
//! desktop's `getTasksLinkedToNote`, `queries/tasks.ts:711`).
//!
//! A task names the notes it references in `linkedNoteIds` and the canvases in
//! `linkedCanvasIds`; `task_links` (data migration 0037) holds one row per
//! pair, kept current by triggers on `tasks`, so a lookup seeks by target
//! instead of parsing every task. The note a task was written in
//! (`sourceNoteId`) is not a link, as desktop's `task_notes` holds only
//! `linkedNoteIds`.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

use super::notes::failed;
use super::task_records::{self, TaskRecord};

/// What a task links to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskLinkTarget {
    Note,
    Canvas,
}

impl TaskLinkTarget {
    /// The `task_links.target_type` spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            TaskLinkTarget::Note => "note",
            TaskLinkTarget::Canvas => "canvas",
        }
    }
}

/// The live tasks linking to one target, by task id. `?1` is the target type,
/// `?2` the target id.
#[doc(hidden)]
pub const TASKS_LINKED_TO: &str = "SELECT l.task_id
   FROM task_links l
   JOIN tasks t ON t.id = l.task_id
  WHERE l.target_type = ?1 AND l.target_id = ?2 AND t.deleted_at IS NULL
  ORDER BY l.task_id";

/// The ids of the live tasks linking to `target_id`, ordered by id as
/// desktop's `id IN (...)` lookup over the primary key returns them.
pub fn linked_task_ids(
    conn: &Connection,
    target: TaskLinkTarget,
    target_id: &str,
) -> Result<Vec<String>, StorageError> {
    let mut statement = conn.prepare(TASKS_LINKED_TO).map_err(failed)?;
    let rows = statement
        .query_map(params![target.as_str(), target_id], |row| row.get(0))
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

/// The tasks whose `linkedNoteIds` name `note_id`, archived and completed ones
/// included, as desktop applies no filter.
pub fn linked_tasks(conn: &Connection, note_id: &str) -> Result<Vec<TaskRecord>, StorageError> {
    let mut tasks = Vec::new();
    for id in linked_task_ids(conn, TaskLinkTarget::Note, note_id)? {
        // A row whose payload is gone is no task this vault holds.
        if let Some(task) = task_records::get(conn, &id)? {
            tasks.push(task);
        }
    }
    Ok(tasks)
}
