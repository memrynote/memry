//! A note's header status follows the tasks written in its body (#3176).
//!
//! The status is stored, as any property is. A task write refreshes it through
//! [`refresh`]: the notes holding the changed task get the status their tasks
//! imply. A user's own pick is an ordinary property edit and stays until the
//! next task change writes over it, last writer wins, so every reader (a
//! folder view, a filter, the CLI, sync) just reads the stored value.
//!
//! The rule is the TypeScript `packages/shared/src/note-status.ts`: all to-do
//! is to-do, all done is done, anything else is in progress. It is a product
//! rule and changes no synced byte, so there is no vector; both sides test the
//! same cases, and a change to the rule changes both. A task id with no live
//! row, such as one a sync has not delivered yet, is skipped.

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::projects::StatusType;
use crate::domain::tasks::TaskWrite;
use crate::domain::{note_tasks, notes, properties, task_records};

/// Whether a property is the one that holds a note's header status. Case does
/// not matter: the property picker names a new one after its type, `Status`,
/// while the stock definition is `status`.
pub fn is_header_status_property(name: &str) -> bool {
    name.eq_ignore_ascii_case("status")
}

/// The type a status property must declare for the rule to apply.
const STATUS_TYPE_NAME: &str = "status";

/// Task fields whose change can move a note's status.
const STATUS_FIELDS: [&str; 3] = ["statusId", "completedAt", "projectId"];

/// Where one task sits. A done status is done. A status past the first default
/// one is in progress, whatever `completed_at` says: the status pickers change
/// the status alone and leave `completed_at` behind, so a done task moved back
/// to In Progress must read as in progress. On the first default status, or with
/// none, the task is done once it is completed (the CLI, agents, importers and
/// checkbox edits complete a task without moving its status), else to-do.
pub fn task_category(completed: bool, status_type: Option<StatusType>) -> StatusType {
    match status_type {
        Some(StatusType::Done) => StatusType::Done,
        Some(StatusType::InProgress) => StatusType::InProgress,
        Some(StatusType::Todo) | None if completed => StatusType::Done,
        Some(StatusType::Todo) | None => StatusType::Todo,
    }
}

/// The note's category from its tasks'; `None` for a note without tasks.
pub fn derive_category(categories: &[StatusType]) -> Option<StatusType> {
    if categories.is_empty() {
        None
    } else if categories.iter().all(|it| *it == StatusType::Todo) {
        Some(StatusType::Todo)
    } else if categories.iter().all(|it| *it == StatusType::Done) {
        Some(StatusType::Done)
    } else {
        Some(StatusType::InProgress)
    }
}

/// The value to show: the category's `default` option in the vault's
/// definition, else its first; the stock names when the definition carries no
/// categories (`DEFAULT_STATUS_CATEGORIES`).
pub fn header_value(categories: &[StatusType], definition_options: Option<&str>) -> Option<String> {
    let category = derive_category(categories)?;
    let parsed: Option<Value> = definition_options.and_then(|text| serde_json::from_str(text).ok());
    let options = parsed
        .as_ref()
        .and_then(|value| value.get("categories"))
        .and_then(|all| all.get(category.as_str()))
        .and_then(|it| it.get("options"))
        .and_then(Value::as_array);
    let Some(options) = options else {
        return Some(stock_value(category).to_owned());
    };
    let chosen = options
        .iter()
        .find(|option| option.get("default").and_then(Value::as_bool) == Some(true))
        .or_else(|| options.first());
    chosen
        .and_then(|option| option.get("value"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn stock_value(category: StatusType) -> &'static str {
    match category {
        StatusType::Todo => "Not started",
        StatusType::InProgress => "In Progress",
        StatusType::Done => "Done",
    }
}

/// Writes the status the tasks in `note_id` imply into its status property.
///
/// Nothing is written when the note has no such property, the property is not
/// declared as a status, no task of the note has a row, or the stored value is
/// already the derived one. `also_task` counts a task the body has not caught up
/// with yet.
pub fn sync_note(
    conn: &Connection,
    note_id: &str,
    also_task: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let values = properties::values(conn, notes::ITEM_TYPE, note_id)?;
    let Some(name) = values
        .keys()
        .find(|name| is_header_status_property(name))
        .cloned()
    else {
        return Ok(());
    };
    let definitions = properties::definitions(conn)?;
    let Some(definition) = definitions.iter().find(|it| it.name == name) else {
        return Ok(());
    };
    if definition.type_name != STATUS_TYPE_NAME {
        return Ok(());
    }

    let lines = note_tasks::read_task_lines(conn, note_id)
        .map_err(|error| StorageError::Failed {
            what: format!("note {note_id} body will not read: {error}"),
        })?
        .unwrap_or_default();
    let mut seen = HashSet::new();
    let mut categories = Vec::new();
    let ids = lines
        .iter()
        .map(|line| line.task_id.as_str())
        .chain(std::iter::once(also_task));
    for task_id in ids {
        if !seen.insert(task_id.to_owned()) {
            continue;
        }
        if let Some(task) = task_records::get(conn, task_id)? {
            categories.push(task_category(task.completed_at.is_some(), task.status_type));
        }
    }

    let Some(value) = header_value(&categories, definition.options.as_deref()) else {
        return Ok(());
    };
    if values.get(&name) == Some(&Value::String(value.clone())) {
        return Ok(());
    }
    properties::set(
        conn,
        notes::ITEM_TYPE,
        note_id,
        &name,
        Value::String(value),
        device_id,
        now_ms,
    )
    .map_err(|error| StorageError::Failed {
        what: format!("header status of {note_id}: {error}"),
    })?;
    Ok(())
}

/// After a task write has committed: the notes holding a task it created,
/// deleted or moved to another status refresh their header status.
///
/// `before` is every live task's source note read before the write, which is
/// the only place a deleted task's note is still named. Best effort, like the
/// activity rows beside it: a task write that landed is not reported as failed
/// because a status property did not follow.
pub fn refresh(
    conn: &Connection,
    write: &TaskWrite,
    current: &HashMap<String, task_records::TaskRecord>,
    before: &HashMap<String, (String, String)>,
    device_id: &str,
    now_ms: i64,
) {
    let mut reached: Vec<(String, String)> = Vec::new();
    let mut reach = |task_id: &str, note_id: &str| {
        let pair = (note_id.to_owned(), task_id.to_owned());
        if !reached.contains(&pair) {
            reached.push(pair);
        }
    };
    let holding = |task: &task_records::TaskRecord| -> Vec<String> {
        task.source_note_id
            .iter()
            .chain(task.linked_note_ids.iter())
            .cloned()
            .collect()
    };
    for id in &write.created {
        for note in current.get(id).map(holding).unwrap_or_default() {
            reach(id, &note);
        }
    }
    for prior in &write.changed {
        if !prior
            .fields
            .iter()
            .any(|(field, _)| STATUS_FIELDS.contains(&field.as_str()))
        {
            continue;
        }
        for note in current.get(&prior.task_id).map(holding).unwrap_or_default() {
            reach(&prior.task_id, &note);
        }
    }
    for id in &write.deleted {
        if let Some((note, _)) = before.get(id) {
            reach(id, note);
        }
    }
    for (note, task) in reached {
        let _ = sync_note(conn, &note, &task, device_id, now_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use StatusType::{Done, InProgress, Todo};

    const CUSTOM: &str = r#"{"categories":{
        "todo":{"label":"To-do","options":[{"value":"Queued","color":"stone"}]},
        "in_progress":{"label":"In progress","options":[
            {"value":"Doing","color":"amber"},{"value":"Review","color":"sky","default":true}]},
        "done":{"label":"Complete","options":[{"value":"Shipped","color":"emerald"}]}}}"#;

    #[test]
    fn a_task_reads_as_the_status_it_is_on() {
        assert_eq!(task_category(false, Some(Todo)), Todo);
        assert_eq!(task_category(false, Some(Done)), Done);
        assert_eq!(task_category(false, Some(InProgress)), InProgress);
    }

    #[test]
    fn a_done_task_moved_back_to_in_progress_reads_as_in_progress() {
        assert_eq!(task_category(true, Some(InProgress)), InProgress);
    }

    #[test]
    fn a_task_completed_without_moving_its_status_reads_as_done() {
        assert_eq!(task_category(true, Some(Todo)), Done);
        assert_eq!(task_category(true, None), Done);
        assert_eq!(task_category(false, None), Todo);
    }

    #[test]
    fn the_status_property_matches_in_any_case_and_only_by_whole_name() {
        assert!(is_header_status_property("status"));
        assert!(is_header_status_property("Status"));
        assert!(!is_header_status_property("Project status"));
    }

    #[test]
    fn the_note_follows_all_todo_all_done_otherwise_in_progress() {
        assert_eq!(derive_category(&[]), None);
        assert_eq!(derive_category(&[Todo, Todo]), Some(Todo));
        assert_eq!(derive_category(&[Done, Done]), Some(Done));
        assert_eq!(derive_category(&[Todo, InProgress]), Some(InProgress));
        assert_eq!(derive_category(&[Todo, Done]), Some(InProgress));
        assert_eq!(derive_category(&[InProgress, Done]), Some(InProgress));
    }

    #[test]
    fn the_value_is_the_stock_name_without_a_definition() {
        assert_eq!(header_value(&[Todo], None).as_deref(), Some("Not started"));
        assert_eq!(
            header_value(&[Done], Some("not json")).as_deref(),
            Some("Done")
        );
        assert_eq!(header_value(&[], None), None);
    }

    #[test]
    fn the_value_is_the_vaults_default_option_else_the_first() {
        assert_eq!(
            header_value(&[Todo], Some(CUSTOM)).as_deref(),
            Some("Queued")
        );
        assert_eq!(
            header_value(&[Todo, Done], Some(CUSTOM)).as_deref(),
            Some("Review")
        );
        assert_eq!(
            header_value(&[Done], Some(CUSTOM)).as_deref(),
            Some("Shipped")
        );
    }

    #[test]
    fn a_category_without_options_has_no_value() {
        let empty = r#"{"categories":{"done":{"options":[]}}}"#;
        assert_eq!(header_value(&[Done], Some(empty)), None);
    }
}
