//! Every live task as the shell renders it (spec 004 TP028).
//!
//! Read from the **stored payload** — the source of record (§13.2 rule 4) —
//! because the projection has no column for `linkedCanvasIds` and keeps
//! `repeatConfig` as text. The status is resolved inside the task's own
//! project, as [`crate::domain::task_views`] does, so `done` here and the view
//! predicates can never disagree.
//!
//! A payload that will not parse is an error, never a task that does not
//! exist (FR-032's rule).

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::domain::calendar::LocalDateTime;
use crate::domain::notes::failed;
use crate::domain::projects::{self, StatusType};
use crate::domain::task_filter::{FilterTask, Priority};
use crate::domain::task_views::{self, ViewTask};

/// One task, every field the shell shows.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskRecord {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub project_id: String,
    pub status_id: Option<String>,
    pub parent_id: Option<String>,
    pub priority: i64,
    pub position: i64,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub start_date: Option<String>,
    /// The raw `repeatConfig` JSON, verbatim (`None` for absent or null).
    pub repeat_config: Option<Value>,
    pub repeat_from: Option<String>,
    pub source_note_id: Option<String>,
    pub completed_at: Option<String>,
    pub archived_at: Option<String>,
    pub tags: Vec<String>,
    pub linked_note_ids: Vec<String>,
    pub linked_canvas_ids: Vec<String>,
    pub created_at: Option<String>,
    pub modified_at: Option<String>,
    /// Resolved status type within the task's own project; `None` when the
    /// status does not resolve (an unresolved status reads as open).
    pub status_type: Option<StatusType>,
}

impl TaskRecord {
    /// `isTaskCompleted`.
    pub fn is_done(&self) -> bool {
        self.status_type == Some(StatusType::Done)
    }

    pub fn is_repeating(&self) -> bool {
        self.repeat_config
            .as_ref()
            .is_some_and(|value| !value.is_null())
    }

    /// The row the view predicates read.
    pub fn view_task(&self) -> ViewTask {
        ViewTask {
            id: self.id.clone(),
            project_id: self.project_id.clone(),
            status_id: self.status_id.clone(),
            parent_id: self.parent_id.clone(),
            position: self.position,
            due: task_views::stored_date(self.due_date.as_deref()),
            start: task_views::stored_date(self.start_date.as_deref()),
            completed_at: task_views::stored_date(self.completed_at.as_deref()),
            archived_at: task_views::stored_date(self.archived_at.as_deref()),
            done: self.is_done(),
        }
    }

    /// The row the filters, sorts and groups read.
    pub fn filter_task(&self) -> FilterTask {
        FilterTask {
            id: self.id.clone(),
            title: self.title.clone(),
            description: self.description.clone(),
            project_id: self.project_id.clone(),
            status_id: self.status_id.clone().unwrap_or_default(),
            parent_id: self.parent_id.clone(),
            priority: Priority::from_wire(self.priority).unwrap_or(Priority::None),
            due_date: task_views::stored_date(self.due_date.as_deref()),
            due_time: self.due_time.clone(),
            created_at: self
                .created_at
                .as_deref()
                .and_then(LocalDateTime::parse)
                .unwrap_or(LocalDateTime::from_ms(0)),
            completed_at: task_views::stored_date(self.completed_at.as_deref()),
            archived_at: task_views::stored_date(self.archived_at.as_deref()),
            is_repeating: self.is_repeating(),
            tags: self.tags.clone(),
            source_note_id: self.source_note_id.clone(),
            linked_note_ids: self.linked_note_ids.clone(),
        }
    }
}

/// Every live task, in `position` then `id` order.
pub fn all(conn: &Connection) -> Result<Vec<TaskRecord>, StorageError> {
    let status_types = status_types(conn)?;
    let mut statement = conn
        .prepare(
            "SELECT s.item_id, s.payload
               FROM sync_items s
               JOIN tasks t ON t.id = s.item_id
              WHERE s.item_type = 'task'
                AND s.deleted_at IS NULL
                AND t.deleted_at IS NULL
                AND s.payload IS NOT NULL
              ORDER BY t.position, t.id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?;
    let mut tasks = Vec::new();
    for row in rows {
        let (id, payload) = row.map_err(failed)?;
        tasks.push(record(&id, &payload, &status_types)?);
    }
    Ok(tasks)
}

/// One live task, or `None`. Reads that one row and its own project's
/// statuses, not the whole vault.
pub fn get(conn: &Connection, task_id: &str) -> Result<Option<TaskRecord>, StorageError> {
    let row = conn
        .query_row(
            "SELECT s.payload
               FROM sync_items s
               JOIN tasks t ON t.id = s.item_id
              WHERE s.item_type = 'task'
                AND s.item_id = ?1
                AND s.deleted_at IS NULL
                AND t.deleted_at IS NULL
                AND s.payload IS NOT NULL",
            params![task_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(failed)?;
    let Some(payload) = row else {
        return Ok(None);
    };
    let project_id = serde_json::from_str::<Value>(&payload)
        .ok()
        .and_then(|value| {
            value
                .get("projectId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let mut types = HashMap::new();
    if let Some(project_id) = project_id {
        for status in projects::statuses(conn, &project_id)? {
            types.insert(
                (project_id.clone(), status.id.clone()),
                status.status_type(),
            );
        }
    }
    record(task_id, &payload, &types).map(Some)
}

/// `(project_id, status_id) -> type` for every live status.
fn status_types(conn: &Connection) -> Result<HashMap<(String, String), StatusType>, StorageError> {
    let mut map = HashMap::new();
    for project in projects::list(conn, true)? {
        for status in projects::statuses(conn, &project.id)? {
            map.insert(
                (project.id.clone(), status.id.clone()),
                status.status_type(),
            );
        }
    }
    Ok(map)
}

fn record(
    id: &str,
    payload: &str,
    status_types: &HashMap<(String, String), StatusType>,
) -> Result<TaskRecord, StorageError> {
    let value: Value = serde_json::from_str(payload).map_err(|error| StorageError::Failed {
        what: format!("task {id} payload will not read: {error}"),
    })?;
    let object = value.as_object().cloned().unwrap_or_default();
    let project_id = string(&object, "projectId").unwrap_or_default();
    let status_id = string(&object, "statusId");
    let status_type = status_id
        .as_ref()
        .and_then(|status| status_types.get(&(project_id.clone(), status.clone())))
        .copied();
    Ok(TaskRecord {
        id: id.to_owned(),
        title: string(&object, "title").unwrap_or_default(),
        description: string(&object, "description"),
        project_id,
        status_id,
        parent_id: string(&object, "parentId"),
        priority: object.get("priority").and_then(Value::as_i64).unwrap_or(0),
        position: object.get("position").and_then(Value::as_i64).unwrap_or(0),
        due_date: string(&object, "dueDate"),
        due_time: string(&object, "dueTime"),
        start_date: string(&object, "startDate"),
        repeat_config: object.get("repeatConfig").filter(|v| !v.is_null()).cloned(),
        repeat_from: string(&object, "repeatFrom"),
        source_note_id: string(&object, "sourceNoteId"),
        completed_at: string(&object, "completedAt"),
        archived_at: string(&object, "archivedAt"),
        tags: strings(&object, "tags"),
        linked_note_ids: strings(&object, "linkedNoteIds"),
        linked_canvas_ids: strings(&object, "linkedCanvasIds"),
        created_at: timestamp(&object, "createdAt"),
        modified_at: timestamp(&object, "modifiedAt"),
        status_type,
    })
}

fn string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn strings(object: &Map<String, Value>, key: &str) -> Vec<String> {
    object
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// §13.5: a timestamp may be a string or an epoch number; both read as text.
fn timestamp(object: &Map<String, Value>, key: &str) -> Option<String> {
    match object.get(key)? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => number
            .as_i64()
            .and_then(crate::storage::repositories::instants::to_iso8601),
        _ => None,
    }
}
