//! Projects: **read and assign only** (T129, FR-060, chapter 13 §13.7.4,
//! data-model §A.4).
//!
//! FR-060 gives the phone exactly two things — see the projects, and file a
//! task under one — and says the interface must **say so** rather than fail
//! silently for everything else. So there is no `create`, no `rename`, no
//! `delete` and no `archive` in this module, and their absence is the
//! enforcement: a shell cannot call a function that does not exist, and a
//! reviewer does not have to notice a missing guard.
//! [`write_unavailable`] is the sentence a shell shows when the user asks for
//! one of them.
//!
//! The assign half is a **task** write, not a project one: it sets
//! `projectId` on the task and touches no project row. It lives at
//! [`crate::domain::tasks::assign`].
//!
//! ## The inbound path
//!
//! `project` is the second of the two field-merged types (§6.8), over the nine
//! entries of `PROJECT_SYNCABLE_FIELDS`, and [`apply_remote`] is the same
//! §6.3.1 gate plus §6.3 per-field rule a task runs — written once, in
//! [`crate::domain::task_merge`], rather than twice. **`modifiedAt` is one of the nine**
//! on this type and none of the fifteen on a task, which is the one asymmetry
//! between them.
//!
//! Read-and-assign-only does **not** mean the merge is dead code here: a
//! project edited on desktop still arrives, and two desktops editing different
//! fields concurrently still have to converge on the phone (FR-059).
//!
//! ## Reads are over the projection
//!
//! `projects`, `project_statuses` and `project_links` are caches of a parse
//! (§A.1); the verbatim payload stays the source of record. A row that will
//! not read is a hard error and never a silently missing project, for the
//! reason [`crate::domain::task_views`] gives at length.

use rusqlite::{Connection, OptionalExtension, params};

use crate::api::errors::StorageError;
use crate::storage::repositories::sync_items::InboundRecord;
use crate::sync::field_merge::PROJECT_SYNCABLE_FIELDS;

use super::notes::failed;
use super::task_merge;
use super::tasks::Inbound;

/// The `(type, _)` half of every key this module reads.
pub const ITEM_TYPE: &str = "project";

/// One project, as the read surface reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub icon: Option<String>,
    pub position: i64,
    /// The Inbox is an ordinary project carrying this flag, not a view
    /// (`packages/db-schema/src/schema/projects.ts:12`, quoted by §A.4). It is
    /// the fallback target for a task with nowhere else to go.
    pub is_inbox: bool,
    pub archived_at: Option<String>,
    /// A **note** id, not a home page id (§13.11).
    pub home_note_id: Option<String>,
}

/// One entry of a project's nested `statuses` array (`StatusSyncSchema`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub id: String,
    pub name: String,
    pub color: String,
    pub position: i64,
    pub is_default: bool,
    /// What [`crate::domain::task_views`] resolves completion against.
    pub is_done: bool,
}

/// Every live project, archived ones included only when asked for.
///
/// Ordered by `position` with `id` as the tiebreak, so two devices holding
/// equal positions still list them the same way.
pub fn list(conn: &Connection, include_archived: bool) -> Result<Vec<Project>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id, name, description, color, icon, position, is_inbox, archived_at,
                    home_note_id
               FROM projects
              WHERE deleted_at IS NULL
                AND (?1 = 1 OR archived_at IS NULL)
              ORDER BY position, id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![i64::from(include_archived)], read_project)
        .map_err(failed)?;

    // Never a `filter_map`: a project this build cannot read is a hard error,
    // not a project the user does not have (FR-032's rule generalised).
    let mut projects = Vec::new();
    for row in rows {
        projects.push(row.map_err(failed)?);
    }
    Ok(projects)
}

/// One live project by id, archived or not.
pub fn get(conn: &Connection, project_id: &str) -> Result<Option<Project>, StorageError> {
    conn.query_row(
        "SELECT id, name, description, color, icon, position, is_inbox, archived_at,
                home_note_id
           FROM projects
          WHERE id = ?1 AND deleted_at IS NULL",
        params![project_id],
        read_project,
    )
    .optional()
    .map_err(failed)
}

/// The Inbox, or `None` when no project carries the flag.
///
/// `None` is a real state on a phone whose first sync has not reached the
/// project yet, and it is reported rather than substituted: inventing an
/// Inbox id would push a `projectId` no vault has.
pub fn inbox(conn: &Connection) -> Result<Option<Project>, StorageError> {
    conn.query_row(
        "SELECT id, name, description, color, icon, position, is_inbox, archived_at,
                home_note_id
           FROM projects
          WHERE is_inbox = 1 AND deleted_at IS NULL
          ORDER BY position, id
          LIMIT 1",
        params![],
        read_project,
    )
    .optional()
    .map_err(failed)
}

/// A project's status columns, in `position` order.
pub fn statuses(conn: &Connection, project_id: &str) -> Result<Vec<Status>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id, name, color, position, COALESCE(is_default, 0), COALESCE(is_done, 0)
               FROM project_statuses
              WHERE project_id = ?1 AND deleted_at IS NULL
              ORDER BY position, id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![project_id], |row| {
            Ok(Status {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                position: row.get(3)?,
                is_default: row.get::<_, i64>(4)? != 0,
                is_done: row.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(failed)?;

    let mut statuses = Vec::new();
    for row in rows {
        statuses.push(row.map_err(failed)?);
    }
    Ok(statuses)
}

/// Applies an inbound `project` record through §6.3.1 and §6.3.
pub fn apply_remote(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    task_merge::apply_remote_merged(conn, record, &PROJECT_SYNCABLE_FIELDS, now_ms)
}

/// FR-060's "say so rather than fail silently", as one sentence a shell can
/// show.
///
/// A function rather than a constant so the refused operation is named: "not
/// available" with no subject is the silent failure FR-060 is written against.
pub fn write_unavailable(operation: &str) -> StorageError {
    StorageError::Failed {
        what: format!(
            "cannot {operation} a project on this device: projects are read-only here, \
             and a task is filed under one with `tasks::assign` (FR-060)"
        ),
    }
}

fn read_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        color: row.get(3)?,
        icon: row.get(4)?,
        position: row.get(5)?,
        is_inbox: row.get::<_, i64>(6)? != 0,
        archived_at: row.get(7)?,
        home_note_id: row.get(8)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_refusal_names_the_operation_it_refused() {
        let message = write_unavailable("rename").to_string();
        assert!(message.contains("rename"), "{message}");
        assert!(message.contains("FR-060"), "{message}");
    }

    #[test]
    fn the_project_field_list_is_the_one_this_module_merges_over() {
        // Pinned here because `apply_remote` passes it positionally and a swap
        // with `TASK_SYNCABLE_FIELDS` would compile.
        assert_eq!(PROJECT_SYNCABLE_FIELDS.len(), 9);
        assert_eq!(PROJECT_SYNCABLE_FIELDS[0], "name");
        assert!(PROJECT_SYNCABLE_FIELDS.contains(&"modifiedAt"));
    }
}
