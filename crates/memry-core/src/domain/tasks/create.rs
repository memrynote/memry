//! Creating tasks: a create with every field desktop's `createTask` takes, and
//! duplicate (`duplicateTask` / `duplicateSubtask`).
//!
//! A created payload carries only the keys the create knows a value for:
//! absent, not `null`, because a create has nothing to clear (§13.4). Every
//! field clock starts at this device's first tick (§6.7).

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::storage::repositories::schema::Object;
use crate::sync::field_merge::{TASK_SYNCABLE_FIELDS, init_all_field_clocks};
use crate::sync::outbox::{self, Durable};

use super::super::notes::{insert_local, iso, next_clock, object};
use super::super::task_merge;
use super::batch::{Batch, TaskWrite};
use super::model::{
    ProjectStatuses, StoredTask, load_live, new_task_id, next_position, subtask_ids,
};
use super::{ITEM_TYPE, NewTask, valid_item_id};

/// Everything a new task may carry beyond [`NewTask`], all optional.
///
/// `Default` is "not given": no description, the project's default status,
/// top level, the next free position.
#[derive(Debug, Clone, Copy, Default)]
pub struct TaskDetails<'a> {
    pub description: Option<&'a str>,
    /// `None` resolves to the project's default status
    /// (`getDefaultTodoStatus(project)?.id || statuses[0]?.id`). An id that
    /// is not one of the project's statuses resolves the same way.
    pub status_id: Option<&'a str>,
    /// The parent, which must be a live top-level task in the same project.
    pub parent_id: Option<&'a str>,
    pub start_date: Option<&'a str>,
    /// `"due"` or `"completion"`; desktop's `repeatFrom`.
    pub repeat_from: Option<&'a str>,
    pub linked_note_ids: &'a [String],
    pub linked_canvas_ids: &'a [String],
    pub source_note_id: Option<&'a str>,
    /// `None` is `getNextTaskPosition(projectId, parentId)`.
    pub position: Option<i64>,
}

/// Creates a task with every field desktop's `createTask` accepts, its
/// payload and its outbox row, in one transaction.
pub fn create_detailed(
    conn: &Connection,
    task: &NewTask<'_>,
    details: &TaskDetails<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, task.id),
        now_ms,
        |tx| {
            valid_item_id(task.id)?;
            if let Some(parent_id) = details.parent_id {
                require_parent(tx, task.id, parent_id, task.project_id)?;
            }
            let statuses = ProjectStatuses::load(tx, task.project_id)?;
            let status_id = details
                .status_id
                .and_then(|id| statuses.find(id))
                .or_else(|| statuses.initial())
                .map(|status| status.id.clone());
            let position = match details.position {
                Some(position) => position,
                None => next_position(tx, task.project_id, details.parent_id)?,
            };

            let mut fields = object(json!({
                "title": task.title,
                "projectId": task.project_id,
                "priority": task.priority,
                "position": position,
            }));
            let optional = [
                ("description", details.description),
                ("statusId", status_id.as_deref()),
                ("parentId", details.parent_id),
                ("dueDate", task.due_date),
                ("dueTime", task.due_time),
                ("startDate", details.start_date),
                ("repeatFrom", details.repeat_from),
                ("sourceNoteId", details.source_note_id),
            ];
            for (key, value) in optional {
                if let Some(value) = value {
                    fields.insert(key.to_owned(), json!(value));
                }
            }
            if let Some(repeat) = task.repeat_config {
                fields.insert("repeatConfig".to_owned(), repeat.clone());
            }
            if !task.tags.is_empty() {
                fields.insert(
                    "tags".to_owned(),
                    json!(super::super::tags::dedupe(task.tags.to_vec())),
                );
            }
            for (key, ids) in [
                ("linkedNoteIds", details.linked_note_ids),
                ("linkedCanvasIds", details.linked_canvas_ids),
            ] {
                if !ids.is_empty() {
                    fields.insert(key.to_owned(), json!(ids));
                }
            }
            insert_local(
                tx,
                ITEM_TYPE,
                task.id,
                seeded(fields, device_id, now_ms)?,
                now_ms,
            )
        },
    )
}

/// The fields a duplicate copies (`duplicateTask`); `completedAt`,
/// `archivedAt` and `sourceNoteId` are deliberately not among them.
const DUPLICATED_FIELDS: [&str; 13] = [
    "projectId",
    "statusId",
    "parentId",
    "description",
    "priority",
    "dueDate",
    "dueTime",
    "startDate",
    "repeatConfig",
    "repeatFrom",
    "tags",
    "linkedNoteIds",
    "linkedCanvasIds",
];

/// Duplicates a task, and its subtasks when `include_subtasks`, in one
/// transaction.
///
/// Desktop's naming: the copy is titled `Copy of <title>` at `position + 1`
/// (`duplicateTask`); each copied subtask keeps its title and position under
/// the copy (`duplicateSubtask`). `created[0]` is the copy, the rest are its
/// subtasks in position order.
pub fn duplicate(
    conn: &Connection,
    task_id: &str,
    include_subtasks: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<TaskWrite, StorageError> {
    let mut batch = Batch::open(conn, device_id, now_ms)?;
    let original = load_live(batch.conn(), task_id)?;
    let copy_id = new_task_id();
    let title = format!("Copy of {}", original.str("title").unwrap_or_default());
    let mut fields = copied(&original, &DUPLICATED_FIELDS);
    fields.insert("title".to_owned(), json!(title));
    fields.insert("position".to_owned(), json!(original.position() + 1));
    batch.create(&copy_id, seeded(fields, device_id, now_ms)?)?;

    if include_subtasks {
        for subtask_id in subtask_ids(batch.conn(), task_id)? {
            let subtask = load_live(batch.conn(), &subtask_id)?;
            let mut fields = copied(&subtask, &DUPLICATED_FIELDS);
            fields.insert("title".to_owned(), subtask.value("title"));
            fields.insert("parentId".to_owned(), json!(copy_id));
            fields.insert("position".to_owned(), json!(subtask.position()));
            batch.create(&new_task_id(), seeded(fields, device_id, now_ms)?)?;
        }
    }
    batch.commit()
}

/// The non-null values of `keys` on `task`, verbatim.
pub(super) fn copied(task: &StoredTask, keys: &[&str]) -> Object {
    let mut fields = Object::new();
    for key in keys {
        if let Some(value) = task.object.get(*key).filter(|value| !value.is_null()) {
            fields.insert((*key).to_owned(), value.clone());
        }
    }
    fields
}

/// `fields` plus what every created task carries: the first document clock,
/// all fifteen field clocks seeded from it (§6.7), and the timestamps.
pub(super) fn seeded(
    mut fields: Object,
    device_id: &str,
    now_ms: i64,
) -> Result<Object, StorageError> {
    let at = iso(now_ms)?;
    let clock = next_clock(&Object::new(), device_id)?;
    let field_clocks = init_all_field_clocks(&task_merge::as_clock(&clock)?, &TASK_SYNCABLE_FIELDS);
    fields.insert("clock".to_owned(), clock);
    fields.insert("fieldClocks".to_owned(), json!(field_clocks));
    fields.insert("createdAt".to_owned(), Value::String(at.clone()));
    fields.insert("modifiedAt".to_owned(), Value::String(at));
    Ok(fields)
}

/// `validateSubtaskRelationship`: a task cannot be its own parent, the parent
/// must be a live top-level task (one level deep), and both are in one
/// project.
pub(super) fn require_parent(
    conn: &Connection,
    task_id: &str,
    parent_id: &str,
    project_id: &str,
) -> Result<StoredTask, StorageError> {
    let refuse = |why: &str| StorageError::Invalid {
        what: format!("task {task_id} cannot be a subtask of {parent_id}: {why}"),
    };
    if parent_id == task_id {
        return Err(refuse("a task cannot be its own parent"));
    }
    let parent = load_live(conn, parent_id)?;
    if parent.parent_id().is_some() {
        return Err(refuse("subtasks cannot have subtasks"));
    }
    if parent.project_id() != project_id {
        return Err(refuse("a subtask belongs to its parent's project"));
    }
    Ok(parent)
}
