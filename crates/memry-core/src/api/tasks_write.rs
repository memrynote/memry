//! The task writes of [`Tasks`] (spec 004 TP028).
//!
//! Every write returns a [`TaskChange`] — what it changed and what the fields
//! were before — which the shell holds for its Undo toast and hands back to
//! [`Tasks::undo`]. Around each domain write, and after it commits, two
//! desktop behaviours ride along:
//!
//! - **Activity** (`task_activity`): one user row per change, desktop's
//!   encoding. Best effort: a task write that landed is not reported as failed
//!   because its audit row did not.
//! - **The note line** (FR-058): completing or reopening a task that came
//!   from a note flips its `{task:<id>}` line there; deleting one removes only
//!   its own line.

use std::collections::HashMap;

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::api::task_records::{RepeatRule, TaskChange, TaskCompletion};
use crate::api::tasks::Tasks;
use crate::domain::calendar::LocalDateTime;
use crate::domain::note_tasks;
use crate::domain::task_activity::{self, FieldChange};
use crate::domain::task_records;
use crate::domain::tasks::{self, NewTask, SubtaskDisposal, TaskDetails, TaskWrite};
use crate::storage::repositories::instants;

/// Everything a new task can carry.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NewTaskInput {
    pub title: String,
    pub project_id: String,
    pub status_id: Option<String>,
    pub parent_id: Option<String>,
    pub priority: i64,
    pub description: Option<String>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub start_date: Option<String>,
    pub repeat: Option<RepeatRule>,
    pub repeat_from: Option<String>,
    pub tags: Vec<String>,
    pub linked_note_ids: Vec<String>,
    pub linked_canvas_ids: Vec<String>,
    pub source_note_id: Option<String>,
    pub position: Option<i64>,
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

pub(crate) fn now_iso(now_ms: i64) -> String {
    instants::to_iso8601(now_ms).unwrap_or_default()
}

fn text(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::String)
}

/// The source note of every live task, read **before** a write that may
/// tombstone some of them.
pub(crate) fn source_notes(
    conn: &Connection,
) -> Result<HashMap<String, (String, String)>, StorageError> {
    // From the projection: three columns of the tasks that have a source
    // note, rather than every payload parsed.
    let mut statement = conn
        .prepare(
            "SELECT id, source_note_id, title FROM tasks
              WHERE deleted_at IS NULL AND source_note_id IS NOT NULL",
        )
        .map_err(sql_failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, String>(1)?, row.get::<_, String>(2)?),
            ))
        })
        .map_err(sql_failed)?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(sql_failed)
}

fn sql_failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Activity rows and note lines for a write that has committed.
pub(crate) fn after(
    conn: &Connection,
    write: &TaskWrite,
    before: &HashMap<String, (String, String)>,
    device_id: &str,
    now_ms: i64,
) {
    let current: HashMap<String, task_records::TaskRecord> = task_records::all(conn)
        .map(|all| {
            all.into_iter()
                .map(|task| (task.id.clone(), task))
                .collect()
        })
        .unwrap_or_default();
    let payload_value = |task_id: &str, field: &str| -> Value {
        crate::storage::repositories::sync_items::load(conn, tasks::ITEM_TYPE, task_id)
            .ok()
            .flatten()
            .and_then(|row| row.payload)
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|payload| payload.get(field).cloned())
            .unwrap_or(Value::Null)
    };

    for id in &write.created {
        if let Some(task) = current.get(id) {
            let _ = task_activity::record_created(conn, id, &task.title, device_id, now_ms);
        }
    }
    for prior in &write.changed {
        let news: Vec<(String, Value, Value)> = prior
            .fields
            .iter()
            .map(|(field, old)| {
                (
                    field.clone(),
                    old.clone(),
                    payload_value(&prior.task_id, field),
                )
            })
            .collect();
        let (moves, updates): (Vec<_>, Vec<_>) = news
            .iter()
            .partition(|(field, _, _)| field == "projectId" || field == "parentId");
        let as_changes = |rows: &[&(String, Value, Value)]| -> Vec<(String, Value, Value)> {
            rows.iter().map(|row| (*row).clone()).collect()
        };
        for (group, moved) in [(as_changes(&moves), true), (as_changes(&updates), false)] {
            let changes: Vec<FieldChange<'_>> = group
                .iter()
                .map(|(field, old, new)| FieldChange { field, old, new })
                .collect();
            if changes.is_empty() {
                continue;
            }
            let _ = if moved {
                task_activity::record_moved(conn, &prior.task_id, &changes, device_id, now_ms)
            } else {
                task_activity::record_updated(conn, &prior.task_id, &changes, device_id, now_ms)
            };
        }
        // FR-058: a completion flip reaches the task's line in its note.
        if let Some((_, _, new)) = news.iter().find(|(field, _, _)| field == "completedAt")
            && let Some(note) = current
                .get(&prior.task_id)
                .and_then(|task| task.source_note_id.clone())
        {
            let _ = note_tasks::set_task_checked(
                conn,
                &note,
                &prior.task_id,
                !new.is_null(),
                device_id,
                now_ms,
            );
        }
    }
    for id in &write.deleted {
        let known = before.get(id);
        let _ = task_activity::record_deleted(
            conn,
            id,
            known.map(|(_, title)| title.as_str()),
            device_id,
            now_ms,
        );
        if let Some((note, _)) = known {
            let _ = note_tasks::remove_task_lines(conn, note, id, device_id, now_ms);
        }
    }
}

impl Tasks {
    /// Runs one write with the before/after bookkeeping around it.
    fn write(
        &self,
        work: impl FnOnce(&Connection, &str, i64) -> Result<TaskWrite, StorageError> + Send + 'static,
    ) -> Result<TaskChange, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let now = now_ms();
            let before = source_notes(conn)?;
            let write = work(conn, &device_id, now)?;
            after(conn, &write, &before, &device_id, now);
            Ok(write.into())
        })
    }

    fn fields(
        &self,
        id: String,
        fields: Vec<(&'static str, Value)>,
    ) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| {
            let changes = fields
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect();
            tasks::write_fields(conn, &id, changes, device, now)
        })
    }
}

#[uniffi::export]
impl Tasks {
    /// Creates a task; `created[0]` of the answer is its id.
    pub fn create(&self, input: NewTaskInput) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| {
            let id = tasks::new_task_id();
            let repeat = input
                .repeat
                .as_ref()
                .map(|rule| rule.to_wire(None, &now_iso(now)));
            let task = NewTask {
                id: &id,
                title: &input.title,
                project_id: &input.project_id,
                due_date: input.due_date.as_deref(),
                due_time: input.due_time.as_deref(),
                priority: input.priority,
                repeat_config: repeat.as_ref(),
                tags: &input.tags,
            };
            let details = TaskDetails {
                description: input.description.as_deref(),
                status_id: input.status_id.as_deref(),
                parent_id: input.parent_id.as_deref(),
                start_date: input.start_date.as_deref(),
                repeat_from: input.repeat_from.as_deref(),
                linked_note_ids: &input.linked_note_ids,
                linked_canvas_ids: &input.linked_canvas_ids,
                source_note_id: input.source_note_id.as_deref(),
                position: input.position,
            };
            tasks::create_detailed(conn, &task, &details, device, now)?.acknowledge();
            Ok(TaskWrite {
                created: vec![id],
                ..TaskWrite::default()
            })
        })
    }

    pub fn set_title(&self, id: String, title: String) -> Result<TaskChange, StorageError> {
        self.fields(id, vec![("title", json!(title))])
    }

    pub fn set_description(
        &self,
        id: String,
        description: Option<String>,
    ) -> Result<TaskChange, StorageError> {
        self.fields(id, vec![("description", text(description))])
    }

    /// 0 none .. 4 urgent.
    pub fn set_priority(&self, id: String, priority: i64) -> Result<TaskChange, StorageError> {
        self.fields(id, vec![("priority", json!(priority))])
    }

    /// Sets or clears the due date and time (`nil` is an explicit clear).
    pub fn set_due(
        &self,
        id: String,
        date: Option<String>,
        time: Option<String>,
    ) -> Result<TaskChange, StorageError> {
        let time = if date.is_none() { None } else { time };
        self.fields(id, vec![("dueDate", text(date)), ("dueTime", text(time))])
    }

    pub fn set_start_date(
        &self,
        id: String,
        date: Option<String>,
    ) -> Result<TaskChange, StorageError> {
        self.fields(id, vec![("startDate", text(date))])
    }

    /// Sets or stops the repeat. A new rule is laid over the stored config so
    /// keys this build does not model survive (D7).
    pub fn set_repeat(
        &self,
        id: String,
        rule: Option<RepeatRule>,
        repeat_from: Option<String>,
    ) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| {
            let previous = task_records::get(conn, &id)?.and_then(|task| task.repeat_config);
            let config = rule.as_ref().map_or(Value::Null, |rule| {
                rule.to_wire(previous.as_ref(), &now_iso(now))
            });
            let from = if config.is_null() {
                Value::Null
            } else {
                text(repeat_from)
            };
            tasks::write_fields(
                conn,
                &id,
                vec![("repeatConfig".into(), config), ("repeatFrom".into(), from)],
                device,
                now,
            )
        })
    }

    pub fn set_tags(&self, id: String, tags: Vec<String>) -> Result<TaskChange, StorageError> {
        self.fields(id, vec![("tags", json!(tags))])
    }

    pub fn set_linked_note_ids(
        &self,
        id: String,
        ids: Vec<String>,
    ) -> Result<TaskChange, StorageError> {
        self.fields(id, vec![("linkedNoteIds", json!(ids))])
    }

    pub fn set_linked_canvas_ids(
        &self,
        id: String,
        ids: Vec<String>,
    ) -> Result<TaskChange, StorageError> {
        self.fields(id, vec![("linkedCanvasIds", json!(ids))])
    }

    /// A status of the task's project; a done status stamps `completedAt`.
    pub fn set_status(&self, id: String, status_id: String) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| tasks::set_status(conn, &id, &status_id, device, now))
    }

    /// Moves the task (and its subtasks) to a project, resolving the
    /// equivalent status there.
    pub fn set_project(&self, id: String, project_id: String) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| tasks::set_project(conn, &id, &project_id, device, now))
    }

    /// Makes the task a subtask of `parent_id`, or top level with `nil`.
    pub fn set_parent(
        &self,
        id: String,
        parent_id: Option<String>,
    ) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| {
            let before = task_records::get(conn, &id)?.and_then(|task| task.parent_id);
            tasks::set_parent(conn, &id, parent_id.as_deref(), device, now)?.acknowledge();
            let mut write = TaskWrite::default();
            if before != parent_id {
                write.changed.push(tasks::Prior {
                    task_id: id.clone(),
                    fields: vec![("parentId".into(), text(before))],
                });
            }
            Ok(write)
        })
    }

    /// Completes a task (and its open subtasks); a repeating one rolls to its
    /// next occurrence. `local_now` is the shell's wall clock.
    pub fn complete(&self, id: String, local_now: String) -> Result<TaskCompletion, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let local = LocalDateTime::parse(&local_now).ok_or_else(|| StorageError::Invalid {
                what: format!("`{local_now}` is not a local instant"),
            })?;
            let now = now_ms();
            let before = source_notes(conn)?;
            let completion = tasks::complete(conn, &id, local, &device_id, now)?;
            after(conn, &completion.write, &before, &device_id, now);
            Ok(completion.into())
        })
    }

    pub fn uncomplete(&self, id: String) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| tasks::uncomplete(conn, &id, device, now))
    }

    pub fn duplicate(&self, id: String, with_subtasks: bool) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| tasks::duplicate(conn, &id, with_subtasks, device, now))
    }

    pub fn reorder(
        &self,
        ids: Vec<String>,
        positions: Vec<i64>,
    ) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| tasks::reorder(conn, &ids, &positions, device, now))
    }

    /// Deletes a task; its subtasks go with it, or are promoted to top level.
    pub fn delete(&self, id: String, promote_subtasks: bool) -> Result<TaskChange, StorageError> {
        let disposal = if promote_subtasks {
            SubtaskDisposal::Promote
        } else {
            SubtaskDisposal::Delete
        };
        self.write(move |conn, device, now| {
            tasks::delete_with_subtasks(conn, &id, disposal, device, now)
        })
    }

    /// Reverts a change this surface returned. A new write: it syncs.
    pub fn undo(&self, change: TaskChange) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| tasks::undo(conn, &change.write(), device, now))
    }

    pub fn complete_all_subtasks(&self, parent_id: String) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| {
            tasks::complete_all_subtasks(conn, &parent_id, device, now)
        })
    }

    pub fn incomplete_all_subtasks(&self, parent_id: String) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| {
            tasks::mark_all_subtasks_incomplete(conn, &parent_id, device, now)
        })
    }

    pub fn set_due_for_all_subtasks(
        &self,
        parent_id: String,
        date: Option<String>,
        include_completed: bool,
    ) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| {
            tasks::set_due_date_for_all_subtasks(
                conn,
                &parent_id,
                date.as_deref(),
                include_completed,
                device,
                now,
            )
        })
    }

    pub fn set_priority_for_all_subtasks(
        &self,
        parent_id: String,
        priority: i64,
        include_completed: bool,
    ) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| {
            tasks::set_priority_for_all_subtasks(
                conn,
                &parent_id,
                priority,
                include_completed,
                device,
                now,
            )
        })
    }

    pub fn delete_all_subtasks(&self, parent_id: String) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| {
            tasks::delete_all_subtasks(conn, &parent_id, device, now)
        })
    }

    pub fn bulk_complete(&self, ids: Vec<String>) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| tasks::bulk_complete(conn, &ids, device, now))
    }

    pub fn bulk_uncomplete(&self, ids: Vec<String>) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| tasks::bulk_uncomplete(conn, &ids, device, now))
    }

    pub fn bulk_delete(&self, ids: Vec<String>) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| tasks::bulk_delete(conn, &ids, device, now))
    }

    pub fn bulk_move(
        &self,
        ids: Vec<String>,
        project_id: String,
    ) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| tasks::bulk_move(conn, &ids, &project_id, device, now))
    }

    pub fn bulk_set_status(
        &self,
        ids: Vec<String>,
        status_id: String,
    ) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| {
            tasks::bulk_set_status(conn, &ids, &status_id, device, now)
        })
    }

    pub fn bulk_set_priority(
        &self,
        ids: Vec<String>,
        priority: i64,
    ) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| {
            tasks::bulk_set_priority(conn, &ids, priority, device, now)
        })
    }

    pub fn bulk_set_due(
        &self,
        ids: Vec<String>,
        date: Option<String>,
        time: Option<String>,
    ) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| {
            tasks::bulk_set_due(conn, &ids, date.as_deref(), time.as_deref(), device, now)
        })
    }

    pub fn bulk_archive(&self, ids: Vec<String>) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| tasks::bulk_archive(conn, &ids, device, now))
    }

    pub fn bulk_unarchive(&self, ids: Vec<String>) -> Result<TaskChange, StorageError> {
        self.write(move |conn, device, now| tasks::bulk_unarchive(conn, &ids, device, now))
    }
}
