//! What a task write reads before it writes: the task's stored payload, its
//! project's statuses resolved to desktop's status types, its subtasks, the
//! next free position, and fresh ids.
//!
//! Values that are **copied or compared** come from the stored payload, the
//! source of record (§13.2 rule 4). The projection is used only to *find*
//! rows — subtasks by `parent_id`, the largest `position`, a status by id —
//! which is what a projection is for.

use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::crypto::sodium::random_bytes;
use crate::storage::repositories::StoredPayload;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::sync_items;

use super::super::notes::failed;
use super::super::projects::{self, Status};
use super::ITEM_TYPE;

/// Desktop's `generateId()` is `nanoid()`: 21 characters of this 64-symbol,
/// URL-safe alphabet (`apps/desktop/src/main/lib/id.ts`).
pub const TASK_ID_LEN: usize = 21;
const NANOID_ALPHABET: &[u8; 64] =
    b"useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/// A fresh task id in desktop's nanoid shape.
///
/// Each random byte is masked to 6 bits, so every symbol of the 64-symbol
/// alphabet is equally likely — the same construction `nanoid` uses.
pub fn new_task_id() -> String {
    random_bytes(TASK_ID_LEN)
        .into_iter()
        .map(|byte| {
            let symbol = NANOID_ALPHABET
                .get(usize::from(byte & 63))
                .copied()
                .unwrap_or(b'_');
            char::from(symbol)
        })
        .collect()
}

/// Desktop's status type, which the wire does not carry (§5 of the plan).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusKind {
    Todo,
    InProgress,
    Done,
}

/// `dbStatusToUiStatus` (`use-task-queries.ts`): `isDone` is done; a default
/// status is todo only at position 0; everything else is in progress.
pub fn status_kind(status: &Status) -> StatusKind {
    if status.is_done {
        StatusKind::Done
    } else if status.is_default && status.position == 0 {
        StatusKind::Todo
    } else {
        StatusKind::InProgress
    }
}

/// One project's statuses in `position` order, with desktop's pickers.
pub(super) struct ProjectStatuses(Vec<Status>);

impl ProjectStatuses {
    pub(super) fn load(conn: &Connection, project_id: &str) -> Result<Self, StorageError> {
        projects::statuses(conn, project_id).map(Self)
    }

    pub(super) fn find(&self, status_id: &str) -> Option<&Status> {
        self.0.iter().find(|status| status.id == status_id)
    }

    fn first_of(&self, kind: StatusKind) -> Option<&Status> {
        self.0.iter().find(|status| status_kind(status) == kind)
    }

    /// `getDefaultTodoStatus`: the first status whose type is todo.
    pub(super) fn default_todo(&self) -> Option<&Status> {
        self.first_of(StatusKind::Todo)
    }

    /// `getDefaultDoneStatus`: the first status whose type is done.
    pub(super) fn default_done(&self) -> Option<&Status> {
        self.first_of(StatusKind::Done)
    }

    /// The status a new task starts in: the default todo status, else the
    /// first column (`getDefaultTodoStatus(project)?.id || statuses[0]?.id`).
    pub(super) fn initial(&self) -> Option<&Status> {
        self.default_todo().or_else(|| self.0.first())
    }

    /// The status a task moved in from another project lands in: the first of
    /// the same type, else the default todo status, else the first column
    /// (`use-drag-handlers.ts` / `use-bulk-actions.ts` `bulkMoveToProject`).
    pub(super) fn equivalent(&self, kind: StatusKind) -> Option<&Status> {
        self.first_of(kind).or_else(|| self.initial())
    }

    /// The type of `status_id` in this project, `None` when it is not one of
    /// this project's statuses.
    pub(super) fn kind_of(&self, status_id: Option<&str>) -> Option<StatusKind> {
        status_id.and_then(|id| self.find(id)).map(status_kind)
    }
}

/// A live status by id, in whichever project holds it.
pub(super) fn status_by_id(
    conn: &Connection,
    status_id: &str,
) -> Result<Option<Status>, StorageError> {
    conn.query_row(
        "SELECT id, name, color, position, COALESCE(is_default, 0), COALESCE(is_done, 0)
           FROM project_statuses
          WHERE id = ?1 AND deleted_at IS NULL",
        params![status_id],
        |row| {
            Ok(Status {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                position: row.get(3)?,
                is_default: row.get::<_, i64>(4)? != 0,
                is_done: row.get::<_, i64>(5)? != 0,
            })
        },
    )
    .optional()
    .map_err(failed)
}

/// A live task's stored payload.
pub(super) struct StoredTask {
    pub id: String,
    pub object: Object,
}

impl StoredTask {
    pub(super) fn str(&self, key: &str) -> Option<&str> {
        self.object.get(key).and_then(Value::as_str)
    }

    /// The value as stored, with an absent key read as `null`.
    pub(super) fn value(&self, key: &str) -> Value {
        self.object.get(key).cloned().unwrap_or(Value::Null)
    }

    pub(super) fn project_id(&self) -> &str {
        self.str("projectId").unwrap_or_default()
    }

    pub(super) fn status_id(&self) -> Option<&str> {
        self.str("statusId")
    }

    pub(super) fn parent_id(&self) -> Option<&str> {
        self.str("parentId").filter(|id| !id.is_empty())
    }

    pub(super) fn is_completed(&self) -> bool {
        self.str("completedAt").is_some()
    }

    pub(super) fn position(&self) -> i64 {
        match self.object.get("position") {
            Some(Value::Number(number)) => number
                .as_i64()
                .or_else(|| number.as_f64().map(|value| value as i64))
                .unwrap_or(0),
            _ => 0,
        }
    }
}

/// The live task `task_id`, or `None` when there is no row, it is a tombstone,
/// or it has no payload yet. A payload that will not parse is an error.
pub(super) fn find_live(
    conn: &Connection,
    task_id: &str,
) -> Result<Option<StoredTask>, StorageError> {
    let Some(row) = sync_items::load(conn, ITEM_TYPE, task_id)? else {
        return Ok(None);
    };
    if row.deleted_at.is_some() {
        return Ok(None);
    }
    let Some(raw) = row.payload else {
        return Ok(None);
    };
    let parsed = StoredPayload::parse(&raw).map_err(|error| StorageError::Failed {
        what: format!("task {task_id} payload will not read: {error}"),
    })?;
    Ok(Some(StoredTask {
        id: task_id.to_owned(),
        object: parsed.object().clone(),
    }))
}

/// [`find_live`] for a task the caller named: absence is an error.
pub(super) fn load_live(conn: &Connection, task_id: &str) -> Result<StoredTask, StorageError> {
    find_live(conn, task_id)?.ok_or_else(|| StorageError::Failed {
        what: format!("no task {task_id}"),
    })
}

/// The live subtasks of `parent_id`, in `position` then `id` order.
pub(super) fn subtask_ids(conn: &Connection, parent_id: &str) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id FROM tasks
              WHERE parent_id = ?1 AND deleted_at IS NULL
              ORDER BY position, id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![parent_id], |row| row.get::<_, String>(0))
        .map_err(failed)?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(failed)?);
    }
    Ok(ids)
}

/// `getNextTaskPosition(projectId, parentId)`: one past the largest position
/// among the project's top-level tasks, or among `parent_id`'s subtasks.
pub(super) fn next_position(
    conn: &Connection,
    project_id: &str,
    parent_id: Option<&str>,
) -> Result<i64, StorageError> {
    let largest: Option<i64> = conn
        .query_row(
            "SELECT max(position) FROM tasks
              WHERE project_id = ?1 AND deleted_at IS NULL
                AND ((?2 IS NULL AND parent_id IS NULL) OR parent_id = ?2)",
            params![project_id, parent_id],
            |row| row.get(0),
        )
        .map_err(failed)?;
    Ok(largest.map_or(0, |position| position + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(position: i64, is_default: bool, is_done: bool) -> Status {
        Status {
            id: format!("s{position}"),
            name: String::new(),
            color: String::new(),
            position,
            is_default,
            is_done,
        }
    }

    #[test]
    fn a_minted_id_has_nanoid_s_length_and_alphabet() {
        let id = new_task_id();
        assert_eq!(id.len(), TASK_ID_LEN);
        assert!(
            id.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        );
        assert_ne!(id, new_task_id());
    }

    #[test]
    fn the_status_type_is_derived_the_way_desktop_derives_it() {
        assert_eq!(status_kind(&status(0, true, false)), StatusKind::Todo);
        assert_eq!(status_kind(&status(1, true, false)), StatusKind::InProgress);
        assert_eq!(
            status_kind(&status(1, false, false)),
            StatusKind::InProgress
        );
        assert_eq!(status_kind(&status(2, false, true)), StatusKind::Done);
    }

    #[test]
    fn an_equivalent_status_falls_back_to_todo_then_the_first_column() {
        let statuses = ProjectStatuses(vec![status(0, true, false), status(1, false, true)]);
        assert_eq!(
            statuses
                .equivalent(StatusKind::InProgress)
                .map(|s| s.id.as_str()),
            Some("s0")
        );
        assert_eq!(
            statuses.equivalent(StatusKind::Done).map(|s| s.id.as_str()),
            Some("s1")
        );
        let no_todo = ProjectStatuses(vec![status(1, false, false)]);
        assert_eq!(no_todo.initial().map(|s| s.id.as_str()), Some("s1"));
    }
}
