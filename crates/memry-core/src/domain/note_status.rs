//! A note's header status, derived from the tasks written in its body (#3176).
//!
//! The note's own `status` property stays in the payload untouched: builds from
//! before this rule read it, and sync carries it. [`metadata`](super::note_meta)
//! swaps it for [`derive`] when the note has tasks, so the shell shows what the
//! tasks imply and cannot edit it.
//!
//! The rule is the TypeScript `packages/shared/src/note-status.ts`: all to-do
//! is to-do, all done is done, anything else is in progress. It is a read-time
//! product rule and changes no synced byte, so there is no vector; both sides
//! test the same cases, and a change to the rule changes both. A task id with
//! no live row, such as one a sync has not delivered yet, is skipped.

use std::collections::HashSet;

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::projects::StatusType;
use crate::domain::{note_tasks, task_records};

/// The property that holds a note's header status.
pub const HEADER_STATUS_PROPERTY: &str = "status";

/// The type a status property must declare for the rule to apply.
const STATUS_TYPE_NAME: &str = "status";

/// Where one task sits. A completed task is done whatever its status says; an
/// open one is to-do without a status row and otherwise as its status resolves.
pub fn task_category(completed: bool, status_type: Option<StatusType>) -> StatusType {
    if completed || status_type == Some(StatusType::Done) {
        StatusType::Done
    } else {
        status_type.unwrap_or(StatusType::Todo)
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

/// The derived header status of `note_id`, or `None` when the stored one
/// stands: the note has no task rows, or `status` is not declared as a status
/// property.
pub fn derive(
    conn: &Connection,
    note_id: &str,
    status_definition: Option<(&str, Option<&str>)>,
) -> Result<Option<String>, StorageError> {
    let Some((type_name, options)) = status_definition else {
        return Ok(None);
    };
    if type_name != STATUS_TYPE_NAME {
        return Ok(None);
    }
    let lines = note_tasks::read_task_lines(conn, note_id)
        .map_err(|error| StorageError::Failed {
            what: format!("note {note_id} body will not read: {error}"),
        })?
        .unwrap_or_default();

    let mut seen = HashSet::new();
    let mut categories = Vec::new();
    for line in lines {
        if !seen.insert(line.task_id.clone()) {
            continue;
        }
        if let Some(task) = task_records::get(conn, &line.task_id)? {
            categories.push(task_category(task.completed_at.is_some(), task.status_type));
        }
    }
    Ok(header_value(&categories, options))
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
    fn a_completed_task_is_done_whatever_its_status() {
        assert_eq!(task_category(true, Some(Todo)), Done);
        assert_eq!(task_category(false, Some(Done)), Done);
    }

    #[test]
    fn an_open_task_without_a_status_is_todo() {
        assert_eq!(task_category(false, None), Todo);
        assert_eq!(task_category(false, Some(InProgress)), InProgress);
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
