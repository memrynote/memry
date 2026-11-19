//! Projects: the read surface, the local writes, and the inbound field merge
//! (T129, spec 004 D2, chapter 13 §13.7.4, data-model §A.4).
//!
//! D2 of `specs/004-ios-tasks-parity` supersedes FR-060: the phone creates,
//! edits, archives, reorders and deletes projects, edits their statuses and
//! manages the project hub's links. Desktop is the reference for every one of
//! those, and each write says which desktop function it mirrors.
//!
//! ## One payload, three row sets
//!
//! A project travels as **one** record. Its status columns are the nested
//! `statuses` array (`StatusSyncSchema`) and its hub links are the nested
//! `links` array (`ProjectLinkSyncSchema`); neither is a sync type of its own.
//! So every status or link edit is a project edit: it rebuilds the whole array
//! from the **stored payload** (never from the projection, §13.2 rule 4),
//! keeps every key of an entry this build does not model, and lands through
//! `write::edit_project` — one transaction, one outbox row, the document clock
//! and `modifiedAt`'s field clock ticked — and writes nothing when the array
//! did not change.
//!
//! Neither array is one of `PROJECT_SYNCABLE_FIELDS` (§6.7), so an edit to one
//! ticks no field clock of its own. That is desktop's shape too: its field
//! merge covers the nine scalar fields and the arrays ride beside them: an
//! inbound record that carries an array replaces the local one, on a
//! concurrent merge too, and one that omits it keeps the local one (chapter 06
//! §6.7.2).
//!
//! ## Writes that touch other items
//!
//! Three project writes change rows that are not the project, and each of
//! those rows gets **its own** outbox row through its own type's write path:
//!
//! - deleting a project deletes its tasks or moves them to the Inbox, through
//!   [`crate::domain::tasks::delete`] / [`crate::domain::tasks::edit`];
//! - a markdown note's project membership is its `project` property (a list
//!   of project **names**), not a link row, so linking, unlinking, renaming
//!   and deleting rewrite that property on the note — see [`links`].
//!
//! Those are separate transactions, ordered so that a crash between two of
//! them leaves a state desktop already tolerates (the other items first, the
//! project last, the note names after the project they describe).
//!
//! ## The inbound path
//!
//! `project` is the second of the two field-merged types (§6.8), and
//! [`apply_remote`] is the same §6.3.1 gate plus §6.3 per-field rule a task
//! runs, written once in [`crate::domain::task_merge`]. **`modifiedAt` is one
//! of the nine** on this type and none of the fifteen on a task.
//!
//! ## Reads are over the projection, links over the payload
//!
//! `projects` and `project_statuses` are caches of a parse (§A.1). A row that
//! will not read is a hard error and never a silently missing project, for the
//! reason [`crate::domain::task_views`] gives at length. Links are read from
//! the verbatim payload instead, because `pinned` is a number on the wire
//! (`z.number()`) and the projected column only carries booleans.

mod contents;
mod links;
mod propagate;
mod status_list;
mod statuses;
mod write;

use rusqlite::{Connection, OptionalExtension, params};

use crate::api::errors::StorageError;
use crate::storage::repositories::instants;
use crate::storage::repositories::sync_items::InboundRecord;
use crate::sync::field_merge::PROJECT_SYNCABLE_FIELDS;

use super::notes::failed;
use super::task_merge;
use super::tasks::Inbound;

pub use contents::{
    LinkedEvent, LinkedFile, LinkedNote, ProjectContents, ProjectRef, contents, projects_for_item,
};
pub(crate) use links::keep_markdown_members;
pub use links::{LinkItemType, ProjectLink, link, links, set_link_pinned, unlink};
pub use propagate::{PropagationTargets, project_names, renamed, targets, without_name};
pub use status_list::{StatusInput, StatusType};
pub use statuses::{
    NewStatus, StatusPatch, create_status, delete_status, reorder_statuses, update_status,
};
pub use write::{
    DEFAULT_PROJECT_COLOR, INBOX_ID, NewProject, ProjectEdit, TaskDisposition, create, delete,
    ensure_inbox, reorder, seed_unclocked, set_archived, set_home_note, update,
};

/// The `(type, _)` half of every key this module reads and writes.
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

/// One entry of a project's nested `statuses` array (`StatusSyncSchema`),
/// with desktop's `Status` fields (`packages/domain-tasks/src/types.ts:87`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub color: String,
    pub position: i64,
    pub is_default: bool,
    /// What [`crate::domain::task_views`] resolves completion against.
    pub is_done: bool,
    /// ISO 8601. `None` when the entry carries no readable `createdAt` (a
    /// payload from a client that never wrote one).
    pub created_at: Option<String>,
}

impl Status {
    /// The type desktop's UI shows for this status.
    ///
    /// The wire carries no type (`StatusSyncSchema` has none), so it is derived
    /// exactly as `dbStatusToUiStatus` does
    /// (`apps/desktop/src/renderer/src/features/tasks/use-task-queries.ts:58`):
    /// `isDone` is done; otherwise `isDefault` is todo at position 0 and in
    /// progress anywhere else; everything else is in progress.
    pub fn status_type(&self) -> StatusType {
        if self.is_done {
            StatusType::Done
        } else if self.is_default && self.position == 0 {
            StatusType::Todo
        } else {
            StatusType::InProgress
        }
    }
}

/// Task counts for one project, as desktop's `getProjectsWithStats` reports
/// them (`apps/desktop/src/main/database/queries/projects.ts:133`).
///
/// Archived tasks are out; subtasks count like any task; "completed" is a
/// `completedAt`, not a done status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSummary {
    pub project_id: String,
    pub task_count: i64,
    pub completed_count: i64,
    /// Open tasks whose `dueDate` is before `today`.
    pub overdue_count: i64,
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
/// [`ensure_inbox`] seeds one when a vault opens, so `None` means a newer
/// build or a remote record removed it; it is reported rather than
/// substituted.
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
            "SELECT id, project_id, name, color, position, COALESCE(is_default, 0),
                    COALESCE(is_done, 0), created_at
               FROM project_statuses
              WHERE project_id = ?1 AND deleted_at IS NULL
              ORDER BY position, id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![project_id], read_status)
        .map_err(failed)?;

    let mut statuses = Vec::new();
    for row in rows {
        statuses.push(row.map_err(failed)?);
    }
    Ok(statuses)
}

/// The status in `target_project_id` a task moved there from `source_status_id`
/// lands on, as desktop's `getEquivalentStatus` resolves it
/// (`apps/desktop/src/main/database/queries/projects.ts:314`).
///
/// No source (or one that no longer resolves) is the target's default. A done
/// source prefers the target's done status, a default source the target's
/// default; anything else takes the first status that is neither, and the
/// default is the final fallback. `None` when the target has no status that
/// qualifies — the caller then leaves `statusId` alone, as desktop does.
pub fn equivalent_status(
    conn: &Connection,
    target_project_id: &str,
    source_status_id: Option<&str>,
) -> Result<Option<Status>, StorageError> {
    let target = statuses(conn, target_project_id)?;
    let default = target.iter().find(|status| status.is_default).cloned();
    let source = match source_status_id {
        Some(id) => status_by_id(conn, id)?,
        None => None,
    };
    let Some(source) = source else {
        return Ok(default);
    };
    if source.is_done
        && let Some(done) = target.iter().find(|status| status.is_done)
    {
        return Ok(Some(done.clone()));
    }
    if source.is_default && default.is_some() {
        return Ok(default);
    }
    if let Some(in_progress) = target
        .iter()
        .find(|status| !status.is_default && !status.is_done)
    {
        return Ok(Some(in_progress.clone()));
    }
    Ok(default)
}

/// Task counts for every live project (archived ones only when asked for), in
/// [`list`] order. `today` is the local calendar date, `YYYY-MM-DD`.
pub fn summaries(
    conn: &Connection,
    include_archived: bool,
    today: &str,
) -> Result<Vec<ProjectSummary>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT p.id,
                    COUNT(t.id),
                    COALESCE(SUM(CASE WHEN t.completed_at IS NOT NULL THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN t.due_date < ?2 AND t.completed_at IS NULL
                                      THEN 1 ELSE 0 END), 0)
               FROM projects p
               LEFT JOIN tasks t
                      ON t.project_id = p.id
                     AND t.deleted_at IS NULL
                     AND t.archived_at IS NULL
              WHERE p.deleted_at IS NULL
                AND (?1 = 1 OR p.archived_at IS NULL)
              GROUP BY p.id
              ORDER BY p.position, p.id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![i64::from(include_archived), today], |row| {
            Ok(ProjectSummary {
                project_id: row.get(0)?,
                task_count: row.get(1)?,
                completed_count: row.get(2)?,
                overdue_count: row.get(3)?,
            })
        })
        .map_err(failed)?;

    let mut summaries = Vec::new();
    for row in rows {
        summaries.push(row.map_err(failed)?);
    }
    Ok(summaries)
}

/// The two nested arrays a project carries beside its field list. They tick
/// no field clock; an inbound record takes the remote's when it has one
/// (chapter 06 §6.7.2).
const NESTED_ARRAYS: [&str; 2] = ["statuses", "links"];

/// Applies an inbound `project` record through §6.3.1 and §6.3, with the
/// nested arrays by §6.7.2.
pub fn apply_remote(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    task_merge::apply_remote_merged(
        conn,
        record,
        &PROJECT_SYNCABLE_FIELDS,
        &NESTED_ARRAYS,
        task_merge::Carry::Remote,
        now_ms,
    )
}

/// One live status by id, in any live project.
fn status_by_id(conn: &Connection, status_id: &str) -> Result<Option<Status>, StorageError> {
    conn.query_row(
        "SELECT s.id, s.project_id, s.name, s.color, s.position, COALESCE(s.is_default, 0),
                COALESCE(s.is_done, 0), s.created_at
           FROM project_statuses s
           JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
          WHERE s.id = ?1 AND s.deleted_at IS NULL",
        params![status_id],
        read_status,
    )
    .optional()
    .map_err(failed)
}

/// A `project_statuses` row selected as `id, project_id, name, color,
/// position, is_default, is_done, created_at`.
pub(crate) fn read_status(row: &rusqlite::Row<'_>) -> rusqlite::Result<Status> {
    Ok(Status {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        color: row.get(3)?,
        position: row.get(4)?,
        is_default: row.get::<_, i64>(5)? != 0,
        is_done: row.get::<_, i64>(6)? != 0,
        created_at: row.get::<_, Option<i64>>(7)?.and_then(instants::to_iso8601),
    })
}

/// A live project a write is about to change, or the error that says why not.
fn require_live(conn: &Connection, project_id: &str) -> Result<Project, StorageError> {
    get(conn, project_id)?.ok_or_else(|| StorageError::NotFound {
        what: format!("no project {project_id}"),
    })
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

    fn status(position: i64, is_default: bool, is_done: bool) -> Status {
        Status {
            id: "s".to_owned(),
            project_id: "p".to_owned(),
            name: "S".to_owned(),
            color: "#6b7280".to_owned(),
            position,
            is_default,
            is_done,
            created_at: None,
        }
    }

    #[test]
    fn the_status_type_is_derived_exactly_as_desktop_derives_it() {
        assert_eq!(status(0, true, false).status_type(), StatusType::Todo);
        // A default that is not first reads as in progress on desktop.
        assert_eq!(status(1, true, false).status_type(), StatusType::InProgress);
        assert_eq!(
            status(0, false, false).status_type(),
            StatusType::InProgress
        );
        assert_eq!(status(2, false, true).status_type(), StatusType::Done);
        assert_eq!(status(0, true, true).status_type(), StatusType::Done);
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
