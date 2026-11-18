//! One multi-field task edit, as desktop's `updateTask`
//! (`packages/domain-tasks/src/commands.ts`) writes it: every field of
//! `TaskUpdateSchema` (`packages/contracts/src/tasks-api.ts`) in one
//! transaction with one outbox row for the task.
//!
//! The rules it carries over from desktop, in the order desktop applies them:
//!
//! - A cleared `dueTime` clears `durationMinutes` (a duration only means
//!   something on a timed task). A cleared `dueDate` leaves `dueTime` alone.
//! - A missing project refuses the edit (`errors:task.projectMissing`), and so
//!   does a parent `checkParent` rejects (`errors:task.invalidParent`). With
//!   `allow_nested` off (the `tasks.nestedSubtasks` setting), that includes a
//!   parent that is itself a subtask, and a task that has subtasks.
//! - A project change files the task under the target project's
//!   `getEquivalentStatus`, overriding any `statusId` in the patch. Only this
//!   task moves, as `updateTask` writes one row, and a `parentId` the patch
//!   leaves alone stays, even in another project (as `updateTask` does).
//! - Tags are trimmed, empty ones dropped and case variants folded, keeping
//!   the first spelling (`setTaskTags`); a repeated link id is kept once.
//! - A `statusId` that names no status is written as `null`; a done status
//!   stamps `completedAt` on an open task, any other status clears it on a
//!   completed one (`completedAtOnStatus`).
//! - A stamped `completedAt` rolls a repeating series (`rollRepeatingSeries`):
//!   the occurrence closes with `repeatConfig: null` and the next one is
//!   created from the task as it was before the edit.
//! - `fields` is a patch: names left out keep their values, `null` removes
//!   one, each entry stamped by chapter 06 §6.11.3.

use std::collections::HashSet;

use rusqlite::Connection;
use serde_json::{Map, Value, json};

use crate::api::errors::StorageError;
use crate::domain::calendar::{CivilDate, LocalDateTime};
use crate::domain::notes::{clock_in, iso};
use crate::domain::projects;
use crate::domain::tags::dedupe;
use crate::sync::clock::clock_total;
use crate::sync::versioned;

use super::batch::{Batch, TaskWrite};
use super::create::require_parent;
use super::lifecycle::{NextOccurrence, series_of, spawn_next};
use super::model::{
    ProjectStatuses, StatusKind, find_live, status_by_id, status_kind, subtask_ids,
};

/// A change to a nullable field.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum Patch<T> {
    /// The field is not in the patch.
    #[default]
    Keep,
    /// The patch sets the field to `null`.
    Clear,
    Set(T),
}

impl<T> Patch<T> {
    fn as_set(&self) -> Option<&T> {
        match self {
            Patch::Set(value) => Some(value),
            _ => None,
        }
    }
}

/// `TaskUpdateSchema` without its `id`. A field the schema does not let a
/// caller null (`title`, `priority`, `projectId`, the lists, `fields`) is an
/// `Option`, so a clear of it cannot be written down. `isRepeating` is not a
/// wire field and is derived from `repeatConfig`, so it has no place here.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TaskPatch {
    pub title: Option<String>,
    pub description: Patch<String>,
    pub priority: Option<i64>,
    pub project_id: Option<String>,
    pub status_id: Patch<String>,
    pub parent_id: Patch<String>,
    pub due_date: Patch<String>,
    pub due_time: Patch<String>,
    pub duration_minutes: Patch<i64>,
    pub start_date: Patch<String>,
    pub repeat_config: Patch<Value>,
    pub repeat_from: Patch<String>,
    pub tags: Option<Vec<String>>,
    pub linked_note_ids: Option<Vec<String>>,
    pub linked_canvas_ids: Option<Vec<String>>,
    pub fields: Option<Map<String, Value>>,
}

/// Why desktop's `updateTask` answers `{ success: false }` without writing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateRefusal {
    NotFound,
    ProjectMissing,
    InvalidParent,
}

impl UpdateRefusal {
    /// The `error` string desktop's envelope carries.
    pub fn error_key(self) -> &'static str {
        match self {
            UpdateRefusal::NotFound => "Task not found",
            UpdateRefusal::ProjectMissing => "errors:task.projectMissing",
            UpdateRefusal::InvalidParent => "errors:task.invalidParent",
        }
    }
}

/// What an accepted [`apply`] wrote.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TaskUpdate {
    /// The task's changed fields with their prior values, and the next
    /// occurrence in `created` when the edit completed a repeating task.
    /// [`super::undo`] reverts all of it.
    pub write: TaskWrite,
    /// The names of the task's fields that changed, in patch order.
    pub changed_fields: Vec<String>,
    pub next_occurrence: Option<NextOccurrence>,
}

/// `TASK_FIELD_LIMITS` and the string caps of `TaskUpdateSchema`.
const TITLE_MAX: usize = 500;
const DESCRIPTION_MAX: usize = 10_000;
const TAGS_MAX: usize = 20;
const TAG_MAX: usize = 50;
const FIELD_NAME_MAX: usize = 200;
const FIELD_TEXT_MAX: usize = 10_000;
const FIELD_LIST_MAX: usize = 500;
const FIELD_OBJECT_KEYS_MAX: usize = 50;
const FIELDS_PER_TASK_MAX: usize = 100;

impl TaskPatch {
    /// The checks `TaskUpdateSchema` makes before desktop's handler runs.
    /// Lengths count UTF-16 code units, as zod's `.max()` does.
    pub fn validate(&self) -> Result<(), StorageError> {
        let invalid = |what: &str| {
            Err(StorageError::Invalid {
                what: what.to_owned(),
            })
        };
        if let Some(title) = &self.title
            && !(1..=TITLE_MAX).contains(&units(title))
        {
            return invalid("title must be 1 to 500 characters");
        }
        if self
            .description
            .as_set()
            .is_some_and(|text| units(text) > DESCRIPTION_MAX)
        {
            return invalid("description must be at most 10000 characters");
        }
        if self.priority.is_some_and(|p| !(0..=4).contains(&p)) {
            return invalid("priority must be 0 to 4");
        }
        for (name, date) in [("dueDate", &self.due_date), ("startDate", &self.start_date)] {
            if date
                .as_set()
                .is_some_and(|key| CivilDate::parse_key(key).is_none())
            {
                return invalid(&format!(
                    "{name} must be a real calendar date in YYYY-MM-DD form"
                ));
            }
        }
        if self.due_time.as_set().is_some_and(|time| !is_hh_mm(time)) {
            return invalid("dueTime must be HH:MM");
        }
        if self.duration_minutes.as_set().is_some_and(|m| *m <= 0) {
            return invalid("durationMinutes must be positive");
        }
        if self
            .repeat_config
            .as_set()
            .is_some_and(|config| !repeat_config_fits(config))
        {
            return invalid("repeatConfig does not match RepeatConfigSchema");
        }
        if self
            .repeat_from
            .as_set()
            .is_some_and(|from| from != "due" && from != "completion")
        {
            return invalid("repeatFrom must be due or completion");
        }
        if let Some(tags) = &self.tags
            && (tags.len() > TAGS_MAX || tags.iter().any(|tag| units(tag) > TAG_MAX))
        {
            return invalid("at most 20 tags of at most 50 characters");
        }
        if let Some(fields) = &self.fields {
            if fields.len() > FIELDS_PER_TASK_MAX {
                return invalid("at most 100 fields");
            }
            for (name, value) in fields {
                if name.is_empty() || units(name) > FIELD_NAME_MAX || !field_value_fits(value) {
                    return invalid(&format!("field `{name}` cannot hold that value"));
                }
            }
        }
        Ok(())
    }
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `RepeatConfigSchema` on the keys it names. A key it does not name is a
/// newer build's and is kept verbatim (D7), so the object is not stripped.
fn repeat_config_fits(config: &Value) -> bool {
    let Some(object) = config.as_object() else {
        return false;
    };
    let int_in = |key: &str, min: i64, max: i64| {
        object
            .get(key)
            .is_none_or(|value| value.as_i64().is_some_and(|n| (min..=max).contains(&n)))
    };
    let one_of = |key: &str, allowed: &[&str]| {
        object
            .get(key)
            .is_none_or(|value| value.as_str().is_some_and(|text| allowed.contains(&text)))
    };
    object.contains_key("frequency")
        && one_of("frequency", &["daily", "weekly", "monthly", "yearly"])
        && int_in("interval", 1, i64::MAX)
        && object.get("daysOfWeek").is_none_or(|days| {
            days.as_array().is_some_and(|days| {
                days.iter()
                    .all(|day| day.as_i64().is_some_and(|n| (0..=6).contains(&n)))
            })
        })
        && one_of("monthlyType", &["dayOfMonth", "weekPattern"])
        && int_in("dayOfMonth", 1, 31)
        && int_in("weekOfMonth", 1, 5)
        && int_in("dayOfWeekForMonth", 0, 6)
        && object.contains_key("endType")
        && one_of("endType", &["never", "date", "count"])
        && object
            .get("endDate")
            .is_none_or(|date| date.is_null() || date.is_string())
        && int_in("endCount", 1, i64::MAX)
        && int_in("completedCount", 0, i64::MAX)
        && object.get("createdAt").is_some_and(Value::is_string)
}

/// `/^\d{2}:\d{2}$/`.
fn is_hh_mm(time: &str) -> bool {
    let bytes = time.as_bytes();
    bytes.len() == 5 && bytes[2] == b':' && [0, 1, 3, 4].iter().all(|i| bytes[*i].is_ascii_digit())
}

/// `TaskFieldValueSchema`, recursively. `serde_json` refuses input nested
/// deeper than 128 levels, so the recursion is bounded by the parser.
fn field_value_fits(value: &Value) -> bool {
    match value {
        Value::String(text) => units(text) <= FIELD_TEXT_MAX,
        Value::Array(items) => items.len() <= FIELD_LIST_MAX && items.iter().all(field_value_fits),
        Value::Object(map) => {
            map.len() <= FIELD_OBJECT_KEYS_MAX
                && map
                    .iter()
                    .all(|(key, value)| units(key) <= FIELD_NAME_MAX && field_value_fits(value))
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => true,
    }
}

/// `ids` with each repeat dropped, in first-seen order.
fn once(ids: &[String]) -> Value {
    let mut seen = HashSet::new();
    json!(
        ids.iter()
            .filter(|id| seen.insert(id.as_str()))
            .collect::<Vec<_>>()
    )
}

fn nullable<T: Into<Value> + Clone>(patch: &Patch<T>) -> Option<Value> {
    match patch {
        Patch::Keep => None,
        Patch::Clear => Some(Value::Null),
        Patch::Set(value) => Some(value.clone().into()),
    }
}

/// Applies `patch` to task `task_id` in one transaction. `local_now` is the
/// device's wall clock, which a repeating series rolled here anchors on.
/// `allow_nested` is the `tasks.nestedSubtasks` setting `checkParent` reads.
pub fn apply(
    conn: &Connection,
    task_id: &str,
    patch: &TaskPatch,
    local_now: LocalDateTime,
    allow_nested: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<Result<TaskUpdate, UpdateRefusal>, StorageError> {
    patch.validate()?;
    let mut batch = Batch::open(conn, device_id, now_ms)?;
    let Some(before) = find_live(batch.conn(), task_id)? else {
        return Ok(Err(UpdateRefusal::NotFound));
    };
    if let Some(project_id) = &patch.project_id
        && projects::get(batch.conn(), project_id)?.is_none()
    {
        return Ok(Err(UpdateRefusal::ProjectMissing));
    }
    if let Patch::Set(parent_id) = &patch.parent_id {
        let project_id = patch.project_id.as_deref().unwrap_or(before.project_id());
        let too_deep = match require_parent(batch.conn(), task_id, parent_id, project_id) {
            Ok(parent) => {
                !allow_nested
                    && (parent.parent_id().is_some()
                        || !subtask_ids(batch.conn(), task_id)?.is_empty())
            }
            Err(StorageError::Invalid { .. } | StorageError::NotFound { .. }) => true,
            Err(other) => return Err(other),
        };
        if too_deep {
            return Ok(Err(UpdateRefusal::InvalidParent));
        }
    }

    let mut changes: Vec<(&'static str, Value)> = Vec::new();
    let mut push = |key: &'static str, value: Option<Value>| {
        if let Some(value) = value {
            changes.push((key, value));
        }
    };
    push("title", patch.title.clone().map(Value::from));
    push("description", nullable(&patch.description));
    push("priority", patch.priority.map(Value::from));
    push("projectId", patch.project_id.clone().map(Value::from));
    push("parentId", nullable(&patch.parent_id));
    push("dueDate", nullable(&patch.due_date));
    push("dueTime", nullable(&patch.due_time));
    let duration = match patch.due_time {
        Patch::Clear => Some(Value::Null),
        _ => nullable(&patch.duration_minutes),
    };
    push("durationMinutes", duration);
    push("startDate", nullable(&patch.start_date));
    push("repeatConfig", nullable(&patch.repeat_config));
    push("repeatFrom", nullable(&patch.repeat_from));

    let mut status_id = nullable(&patch.status_id);
    if let Some(project_id) = patch.project_id.as_deref()
        && project_id != before.project_id()
    {
        let source = match before.status_id() {
            Some(id) => status_by_id(batch.conn(), id)?,
            None => None,
        };
        let target = ProjectStatuses::load(batch.conn(), project_id)?;
        if let Some(status) = target.equivalent_to(source.as_ref()) {
            status_id = Some(json!(status.id));
        }
    }
    let mut rolls = false;
    if let Some(value) = status_id {
        let status = match value.as_str() {
            Some(id) => status_by_id(batch.conn(), id)?,
            None => None,
        };
        let resolved = status.as_ref().map_or(Value::Null, |s| json!(s.id));
        push("statusId", Some(resolved));
        match status.map(|s| status_kind(&s)) {
            Some(StatusKind::Done) if !before.is_completed() => {
                push("completedAt", Some(json!(iso(now_ms)?)));
                rolls = true;
            }
            Some(StatusKind::Todo | StatusKind::InProgress) if before.is_completed() => {
                push("completedAt", Some(Value::Null));
            }
            _ => {}
        }
    }
    let series = if rolls { series_of(&before) } else { None };
    if series.is_some() {
        push("repeatConfig", Some(Value::Null));
    }

    push(
        "tags",
        patch.tags.as_ref().map(|tags| {
            json!(dedupe(
                tags.iter()
                    .map(|tag| tag.trim())
                    .filter(|tag| !tag.is_empty())
                    .map(str::to_owned)
            ))
        }),
    );
    push("linkedNoteIds", patch.linked_note_ids.as_deref().map(once));
    push(
        "linkedCanvasIds",
        patch.linked_canvas_ids.as_deref().map(once),
    );
    if let Some(fields) = &patch.fields {
        let total = u64::try_from(clock_total(&clock_in(&before.object)?)).unwrap_or(0);
        push(
            "fields",
            Some(versioned::stamp_map(
                before.object.get("fields"),
                fields,
                total,
            )),
        );
    }

    // A key written twice (a roll closing a `repeatConfig` the patch also
    // set) keeps its last value.
    let mut deduped: Vec<(&'static str, Value)> = Vec::new();
    for (key, value) in changes {
        deduped.retain(|(seen, _)| *seen != key);
        deduped.push((key, value));
    }
    batch.edit(task_id, deduped)?;

    let next_occurrence = match &series {
        Some(series) => {
            let statuses = ProjectStatuses::load(batch.conn(), before.project_id())?;
            spawn_next(&mut batch, &before, &statuses, series, local_now)?
        }
        None => None,
    };
    let write = batch.commit()?;
    let changed_fields = write
        .changed
        .iter()
        .filter(|prior| prior.task_id == task_id)
        .flat_map(|prior| prior.fields.iter().map(|(field, _)| field.clone()))
        .collect();
    Ok(Ok(TaskUpdate {
        write,
        changed_fields,
        next_occurrence,
    }))
}
