//! Project writes: create, edit, archive, reorder, home note, delete (D2).
//!
//! Each function names the desktop function it mirrors
//! (`packages/domain-tasks/src/commands.ts`, `apps/desktop/src/main/database/queries/projects.ts`).
//! Every project write is one [`crate::sync::outbox::commit`] with its outbox
//! row; a create seeds all nine field clocks from its first document tick
//! (§6.7) and an edit ticks the document clock and each changed field's clock
//! through [`crate::domain::tasks::edit_merged`].

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::crypto::sodium::random_bytes;
use crate::storage::repositories::Change;
use crate::storage::repositories::schema::Object;
use crate::sync::field_merge::{PROJECT_SYNCABLE_FIELDS, init_all_field_clocks};
use crate::sync::outbox::{self, Durable};

use super::super::notes::{self, failed, insert_local, iso, next_clock, object};
use super::super::{task_merge, tasks};
use super::status_list::{StatusInput, custom_statuses, default_statuses, reconcile};
use super::{ITEM_TYPE, equivalent_status, inbox, links, require_live};

/// `ProjectCreateSchema`'s colour default (`packages/contracts/src/tasks-api.ts:137`).
pub const DEFAULT_PROJECT_COLOR: &str = "#6366f1";
/// `ProjectCreateSchema` / `ProjectUpdateSchema` bounds.
pub const MAX_PROJECT_NAME_CHARS: usize = 100;
pub const MAX_PROJECT_DESCRIPTION_CHARS: usize = 500;

/// nanoid's `urlAlphabet`. 64 symbols, so a byte masked to six bits picks one
/// without bias.
const NANOID_ALPHABET: &[u8; 64] =
    b"useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
const NANOID_LEN: usize = 21;

/// What a new project carries (`ProjectCreateInput`).
#[derive(Debug, Clone, Copy)]
pub struct NewProject<'a> {
    /// `None` mints a nanoid, as desktop's `generateId` does.
    pub id: Option<&'a str>,
    pub name: &'a str,
    pub description: Option<&'a str>,
    /// `None` is [`DEFAULT_PROJECT_COLOR`].
    pub color: Option<&'a str>,
    pub icon: Option<&'a str>,
    /// `None` is desktop's default three; `Some` is a custom list of at least
    /// two.
    pub statuses: Option<&'a [StatusInput<'a>]>,
}

/// One edit to a project's metadata and statuses (`ProjectUpdateInput`).
///
/// `None` leaves a field alone. On the two nullable fields `Some(None)` is
/// §13.4's explicit clear.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProjectEdit<'a> {
    pub name: Option<&'a str>,
    pub description: Option<Option<&'a str>>,
    pub color: Option<&'a str>,
    pub icon: Option<Option<&'a str>>,
    /// Reconciled against the stored list (see `status_list::reconcile`).
    pub statuses: Option<&'a [StatusInput<'a>]>,
}

/// What happens to a deleted project's tasks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskDisposition {
    /// Each task moves to the Inbox, onto the equivalent status there.
    MoveToInbox,
    /// Each task is deleted — desktop's only behaviour.
    Delete,
}

/// Creates a project (`createProject`) and returns its id.
///
/// The position is the next after every live project's, archived ones
/// included (`getNextProjectPosition`). The statuses are desktop's default
/// three unless a custom list is given.
pub fn create(
    conn: &Connection,
    project: &NewProject<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let id = match project.id {
        Some(id) => tasks::valid_item_id(id)?.to_owned(),
        None => mint_id(),
    };
    valid_name(project.name)?;
    if let Some(description) = project.description {
        valid_description(description)?;
    }
    let color = project.color.unwrap_or(DEFAULT_PROJECT_COLOR);
    valid_color(color)?;
    let at = iso(now_ms)?;
    let statuses = match project.statuses {
        Some(inputs) => custom_statuses(&id, inputs, &at)?,
        None => default_statuses(&id, &at),
    };

    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &id),
        now_ms,
        |tx| {
            let clock = next_clock(&Object::new(), device_id)?;
            let field_clocks =
                init_all_field_clocks(&task_merge::as_clock(&clock)?, &PROJECT_SYNCABLE_FIELDS);
            let mut payload = object(json!({
                "name": project.name,
                "color": color,
                "position": next_position(tx)?,
                "isInbox": false,
                "statuses": statuses,
                "links": [],
                "clock": clock,
                "fieldClocks": field_clocks,
                "createdAt": at,
                "modifiedAt": at,
            }));
            // Absent rather than `null` (§13.4): a create knows of nothing to clear.
            for (key, value) in [("description", project.description), ("icon", project.icon)] {
                if let Some(value) = value {
                    payload.insert(key.to_owned(), json!(value));
                }
            }
            insert_local(tx, ITEM_TYPE, &id, payload, now_ms)?;
            Ok(id.clone())
        },
    )
}

/// Edits name, description, colour, icon and statuses in one write
/// (`updateProject` + `reconcileProjectStatuses`), returning the payload.
///
/// A rename then rewrites the `project` property of every linked markdown note
/// (`propagateProjectRename`), after the project write, each note with its own
/// outbox row.
pub fn update(
    conn: &Connection,
    project_id: &str,
    edit: &ProjectEdit<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let before = require_live(conn, project_id)?;
    let mut changes: Vec<(&'static str, Change)> = Vec::new();
    if let Some(name) = edit.name {
        valid_name(name)?;
        changes.push(("name", Change::set(name)));
    }
    if let Some(description) = edit.description {
        if let Some(description) = description {
            valid_description(description)?;
        }
        changes.push(("description", Change::Set(nullable(description))));
    }
    if let Some(color) = edit.color {
        valid_color(color)?;
        changes.push(("color", Change::set(color)));
    }
    if let Some(icon) = edit.icon {
        changes.push(("icon", Change::Set(nullable(icon))));
    }
    if let Some(inputs) = edit.statuses {
        let stored = notes::require_payload(conn, ITEM_TYPE, project_id)?;
        let next = reconcile(
            project_id,
            stored.object().get("statuses"),
            inputs,
            &iso(now_ms)?,
        )?;
        changes.push(("statuses", Change::Set(Value::Array(next))));
    }

    let written = edit_project(conn, project_id, changes, device_id, now_ms)?;
    if let Some(name) = edit.name.filter(|name| *name != before.name) {
        links::propagate_rename(conn, project_id, &before.name, name, device_id, now_ms)?;
    }
    Ok(written)
}

/// Archives the project, or unarchives it with `false` (`archiveProject`,
/// `unarchiveProject`). The Inbox cannot be archived.
pub fn set_archived(
    conn: &Connection,
    project_id: &str,
    archived: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let project = require_live(conn, project_id)?;
    if archived && project.is_inbox {
        return Err(StorageError::Invalid {
            what: "cannot archive the inbox project".to_owned(),
        });
    }
    // Archiving an archived project keeps its first `archivedAt`.
    if archived == project.archived_at.is_some() {
        return edit_project(conn, project_id, Vec::new(), device_id, now_ms);
    }
    let at = archived.then(|| iso(now_ms)).transpose()?;
    edit_project(
        conn,
        project_id,
        vec![("archivedAt", Change::Set(nullable(at.as_deref())))],
        device_id,
        now_ms,
    )
}

/// Writes each project's new position (`reorderProjects`): one write and one
/// outbox row per project, as desktop publishes one update per project.
///
/// Every id is checked before the first write, so an unknown id changes
/// nothing.
pub fn reorder(
    conn: &Connection,
    positions: &[(&str, i64)],
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<Durable<String>>, StorageError> {
    for (project_id, _) in positions {
        require_live(conn, project_id)?;
    }
    positions
        .iter()
        .map(|(project_id, position)| {
            edit_project(
                conn,
                project_id,
                vec![("position", Change::set(*position))],
                device_id,
                now_ms,
            )
        })
        .collect()
}

/// Sets or clears (`None`) the project's home note (`setProjectHomeNote`).
pub fn set_home_note(
    conn: &Connection,
    project_id: &str,
    note_id: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    require_live(conn, project_id)?;
    edit_project(
        conn,
        project_id,
        vec![("homeNoteId", Change::Set(nullable(note_id)))],
        device_id,
        now_ms,
    )
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

/// One local edit to one project, over `PROJECT_SYNCABLE_FIELDS`.
pub(super) fn edit_project(
    conn: &Connection,
    project_id: &str,
    changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    // A field already holding the value is not a change: writing it would
    // tick its field clock and let an unchanged value beat a concurrent edit
    // made on another device (a phone rename re-sending the old description
    // would win over desktop's new one). Only `modifiedAt` then moves.
    let stored = notes::require_payload(conn, ITEM_TYPE, project_id)?;
    let changes: Vec<(&'static str, Change)> = changes
        .into_iter()
        .filter(|(key, change)| match change {
            Change::Set(value) => stored.object().get(*key).unwrap_or(&Value::Null) != value,
            Change::Remove => stored.object().contains_key(*key),
        })
        .collect();
    tasks::edit_merged(
        conn,
        ITEM_TYPE,
        &PROJECT_SYNCABLE_FIELDS,
        project_id,
        changes,
        device_id,
        now_ms,
    )
}

/// A fresh nanoid: 21 symbols of `[A-Za-z0-9_-]`, desktop's id shape.
pub(super) fn mint_id() -> String {
    random_bytes(NANOID_LEN)
        .into_iter()
        .map(|byte| char::from(NANOID_ALPHABET[usize::from(byte & 63)]))
        .collect()
}

/// `#rrggbb`, the only colour shape `ProjectCreateSchema` accepts.
pub(super) fn valid_color(color: &str) -> Result<(), StorageError> {
    let bytes = color.as_bytes();
    if bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit) {
        Ok(())
    } else {
        Err(StorageError::Invalid {
            what: format!("`{color}` is not a #rrggbb colour"),
        })
    }
}

fn valid_name(name: &str) -> Result<(), StorageError> {
    if name.trim().is_empty() || name.chars().count() > MAX_PROJECT_NAME_CHARS {
        return Err(StorageError::Invalid {
            what: format!("a project name must be 1 to {MAX_PROJECT_NAME_CHARS} characters"),
        });
    }
    Ok(())
}

fn valid_description(description: &str) -> Result<(), StorageError> {
    if description.chars().count() > MAX_PROJECT_DESCRIPTION_CHARS {
        return Err(StorageError::Invalid {
            what: format!(
                "a project description must be at most {MAX_PROJECT_DESCRIPTION_CHARS} characters"
            ),
        });
    }
    Ok(())
}

fn next_position(conn: &Connection) -> Result<i64, StorageError> {
    conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM projects WHERE deleted_at IS NULL",
        params![],
        |row| row.get(0),
    )
    .map_err(failed)
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

/// `Some` is the value, `None` is §13.4's explicit clear.
fn nullable(value: Option<&str>) -> Value {
    value.map_or(Value::Null, |value| Value::String(value.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minted_id_has_desktops_nanoid_shape() {
        let id = mint_id();
        assert_eq!(id.len(), NANOID_LEN);
        assert!(
            id.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'),
            "{id}"
        );
        assert_ne!(id, mint_id());
    }

    #[test]
    fn only_a_six_digit_hex_colour_is_accepted() {
        assert!(valid_color("#6366f1").is_ok());
        assert!(valid_color("#F59E0B").is_ok());
        assert!(valid_color("#888").is_err());
        assert!(valid_color("6366f1").is_err());
        assert!(valid_color("#6366fg").is_err());
    }
}
