//! Per-status commands (`tasks:status-create|update|delete|reorder`): desktop's
//! `createStatus`, `updateStatus`, `deleteStatus` and `reorderStatuses`
//! (`packages/domain-tasks/src/commands-projects.ts:273-330`) over the queries at
//! `apps/desktop/src/main/database/queries/projects.ts:248-385`. The list is
//! [`super::statuses`].
//!
//! A status is an entry of its project's nested `statuses` array, so each
//! command is a project edit, which is what desktop pushes too (`project`
//! update with `['statuses']`, `apps/desktop/src/main/tasks/sync-intents.ts:52-66`).
//! The array is read from the stored payload, changed, and written back through
//! `write::edit_project` with one outbox row; every key of an entry this build
//! does not model is kept (§13.2 rule 3). An unchanged array writes nothing
//! (desktop pushes those no-ops; see `edit_project` for why core must not),
//! and a stored `statuses` that is not an array is refused, never replaced.
//!
//! Desktop's rules, kept: a new status is never the default and goes after the
//! last position; an update sets the two flags without clearing them on the
//! project's other statuses; deleting a status leaves the tasks on it alone
//! (desktop's FK nulls only its local column and pushes nothing for the task,
//! and every reader resolves the stale id as "no status"); a reorder skips an
//! id it does not know.

use rusqlite::Connection;
use serde_json::{Map, Value, json};

use crate::api::errors::StorageError;
use crate::storage::repositories::Change;
use crate::sync::outbox::Durable;

use super::super::notes::{self, iso};
use super::status_list::valid_status_name;
use super::write::{edit_project_then, mint_id, valid_color};
use super::{ITEM_TYPE, Status, require_live, status_by_id};

/// `StatusCreateSchema`'s colour default (`packages/contracts/src/tasks-api.ts:214`).
pub const DEFAULT_STATUS_COLOR: &str = "#6b7280";

/// What a new status carries (`StatusCreateInput`).
#[derive(Debug, Clone, Copy)]
pub struct NewStatus<'a> {
    pub project_id: &'a str,
    pub name: &'a str,
    /// `None` is [`DEFAULT_STATUS_COLOR`].
    pub color: Option<&'a str>,
    pub is_done: bool,
}

/// One edit to a status (`StatusUpdateInput`); `None` leaves a field alone.
#[derive(Debug, Clone, Copy, Default)]
pub struct StatusPatch<'a> {
    pub name: Option<&'a str>,
    pub color: Option<&'a str>,
    pub position: Option<i64>,
    pub is_default: Option<bool>,
    pub is_done: Option<bool>,
}

/// Adds a status after the project's last one (`createStatus`) and returns it.
pub fn create_status(
    conn: &Connection,
    status: &NewStatus<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<Status>, StorageError> {
    require_live(conn, status.project_id)?;
    valid_status_name(status.name)?;
    let color = status.color.unwrap_or(DEFAULT_STATUS_COLOR);
    valid_color(color)?;
    let id = mint_id();
    let at = iso(now_ms)?;
    write(
        conn,
        status.project_id,
        device_id,
        now_ms,
        |entries| {
            // `getNextStatusPosition`: one past the highest, 0 for none.
            let position = entries
                .iter()
                .filter_map(|entry| entry.get("position").and_then(as_position))
                .max()
                .map_or(0, |max| max + 1);
            entries.push(json!({
                "id": id,
                "projectId": status.project_id,
                "name": status.name,
                "color": color,
                "position": position,
                "isDefault": false,
                "isDone": status.is_done,
                "createdAt": at,
            }));
            Ok(())
        },
        |tx| read_back(tx, &id),
    )?
    .ok_or_else(|| StorageError::Failed {
        what: format!("status {id} was not added to project {}", status.project_id),
    })
}

/// Edits one status (`updateStatus`) and returns it, or `None` when every
/// field already held its value. An id no live project holds is `NotFound`,
/// desktop's `Status not found`.
pub fn update_status(
    conn: &Connection,
    status_id: &str,
    patch: &StatusPatch<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<Durable<Status>>, StorageError> {
    let status = status_by_id(conn, status_id)?.ok_or_else(|| not_found(status_id))?;
    if let Some(name) = patch.name {
        valid_status_name(name)?;
    }
    if let Some(color) = patch.color {
        valid_color(color)?;
    }
    write(
        conn,
        &status.project_id,
        device_id,
        now_ms,
        |entries| {
            let entry = entries
                .iter_mut()
                .filter_map(Value::as_object_mut)
                .find(|entry| entry_id(entry) == Some(status_id))
                .ok_or_else(|| not_found(status_id))?;
            for (key, value) in [
                ("name", patch.name.map(|name| json!(name))),
                ("color", patch.color.map(|color| json!(color))),
                ("position", patch.position.map(|position| json!(position))),
                ("isDefault", patch.is_default.map(|flag| json!(flag))),
                ("isDone", patch.is_done.map(|flag| json!(flag))),
            ] {
                if let Some(value) = value {
                    entry.insert(key.to_owned(), value);
                }
            }
            Ok(())
        },
        |tx| read_back(tx, status_id),
    )
}

/// Removes one status (`deleteStatus`) and returns the id of the project it
/// left. An id no live project holds deletes nothing and is `None`, as
/// desktop's delete of a missing row succeeds with no event.
pub fn delete_status(
    conn: &Connection,
    status_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<Durable<String>>, StorageError> {
    let Some(status) = status_by_id(conn, status_id)? else {
        return Ok(None);
    };
    let project_id = status.project_id;
    write(
        conn,
        &project_id,
        device_id,
        now_ms,
        |entries| {
            entries.retain(|entry| entry.as_object().and_then(entry_id) != Some(status_id));
            Ok(())
        },
        |_| Ok(project_id.clone()),
    )
}

/// Sets `positions[i]` on `status_ids[i]` (`reorderStatuses`): one write per
/// project the ids belong to, in the order each project is first named, each
/// returning its moved statuses in input order. Ids no live project holds are
/// skipped; a repeated id takes its last position; a project whose positions
/// already hold is not written and is absent from the result.
///
/// Desktop runs every update in one transaction. Here each project is its own
/// commit (one outbox row per project), so a crash between two leaves each
/// project whole: reordered or untouched.
pub fn reorder_statuses(
    conn: &Connection,
    status_ids: &[&str],
    positions: &[i64],
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<Durable<Vec<Status>>>, StorageError> {
    if status_ids.len() != positions.len() {
        return Err(StorageError::Invalid {
            what: "statusIds and positions arrays must have the same length".to_owned(),
        });
    }
    let mut by_project: Vec<(String, Vec<(&str, i64)>)> = Vec::new();
    for (status_id, position) in status_ids.iter().zip(positions) {
        let Some(status) = status_by_id(conn, status_id)? else {
            continue;
        };
        let moves = match by_project
            .iter_mut()
            .find(|(project_id, _)| *project_id == status.project_id)
        {
            Some((_, moves)) => moves,
            None => {
                by_project.push((status.project_id, Vec::new()));
                &mut by_project.last_mut().expect("just pushed").1
            }
        };
        moves.push((status_id, *position));
    }

    let mut written = Vec::new();
    for (project_id, moves) in &by_project {
        written.extend(write(
            conn,
            project_id,
            device_id,
            now_ms,
            |entries| {
                for (status_id, position) in moves {
                    let entry = entries
                        .iter_mut()
                        .filter_map(Value::as_object_mut)
                        .find(|entry| entry_id(entry) == Some(*status_id));
                    if let Some(entry) = entry {
                        entry.insert("position".to_owned(), json!(position));
                    }
                }
                Ok(())
            },
            |tx| {
                moves
                    .iter()
                    .map(|(status_id, _)| read_back(tx, status_id))
                    .collect()
            },
        )?);
    }
    Ok(written)
}

/// One project edit of the `statuses` array: read from the stored payload,
/// changed by `edit`, and written through `edit_project_then`, which skips an
/// unchanged array (`None`); `read` runs in the write's transaction after the
/// projection caught up.
fn write<T>(
    conn: &Connection,
    project_id: &str,
    device_id: &str,
    now_ms: i64,
    edit: impl FnOnce(&mut Vec<Value>) -> Result<(), StorageError>,
    read: impl FnOnce(&Connection) -> Result<T, StorageError>,
) -> Result<Option<Durable<T>>, StorageError> {
    let stored = notes::require_payload(conn, ITEM_TYPE, project_id)?;
    let mut entries = match stored.object().get("statuses") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(entries)) => entries.clone(),
        // A newer build's shape: writing a list over it would destroy it.
        Some(_) => {
            return Err(StorageError::Invalid {
                what: format!("project {project_id} has a `statuses` value that is not a list"),
            });
        }
    };
    edit(&mut entries)?;
    edit_project_then(
        conn,
        project_id,
        vec![("statuses", Change::Set(Value::Array(entries)))],
        device_id,
        now_ms,
        |tx, _| read(tx),
    )
}

fn read_back(tx: &Connection, status_id: &str) -> Result<Status, StorageError> {
    status_by_id(tx, status_id)?.ok_or_else(|| StorageError::Failed {
        what: format!("status {status_id} did not project after its write"),
    })
}

fn entry_id(entry: &Map<String, Value>) -> Option<&str> {
    entry.get("id").and_then(Value::as_str)
}

/// A wire position: an integer, or a number desktop wrote as a float.
fn as_position(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_f64().map(|n| n as i64))
}

fn not_found(status_id: &str) -> StorageError {
    StorageError::NotFound {
        what: format!("no status {status_id}"),
    }
}
