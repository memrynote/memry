//! Which project a task created from inside a note belongs to.
//!
//! Desktop's `resolveNoteTaskProjectId`
//! (`apps/desktop/src/renderer/src/lib/note-task-project.ts`, #2271): parent
//! task → `+project` token → the note's project → Settings > Tasks default →
//! inbox → first project. One order, shared by every note-side creation path
//! so they cannot drift apart.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::projects::Project;

/// Everything the chain reads. Every id is optional input; the caller loads
/// the note's projects with [`note_project_ids`] and the default from the
/// task settings.
#[derive(Debug, Clone, Copy)]
pub struct NoteTaskProjectInput<'a> {
    /// The parent task's project, for a subtask. Wins over everything else.
    pub parent_task_project_id: Option<&'a str>,
    /// The project a `+project` quick-add token on the line resolved to.
    pub quick_add_project_id: Option<&'a str>,
    /// Projects linked to the note, oldest link first.
    pub note_project_ids: &'a [String],
    /// Settings > Tasks "default project".
    pub settings_default_project_id: Option<&'a str>,
    /// The projects to choose among, in list order.
    pub projects: &'a [Project],
}

/// The project a note-created task is filed under.
///
/// The parent's and the token's ids are trusted as given, as desktop trusts
/// them: they name a row that exists, and an archived project is still a legal
/// home for a subtask of a task already living there. Every later step skips
/// archived and unknown projects. `None` only when there is no project at all,
/// which desktop treats as "do not create".
pub fn resolve_note_task_project(input: &NoteTaskProjectInput<'_>) -> Option<String> {
    // Desktop tests these for truthiness, so an empty id is no answer.
    let given = |id: Option<&str>| id.filter(|id| !id.is_empty()).map(str::to_owned);
    if let Some(id) = given(input.parent_task_project_id) {
        return Some(id);
    }
    if let Some(id) = given(input.quick_add_project_id) {
        return Some(id);
    }

    let live = |id: &str| {
        input
            .projects
            .iter()
            .find(|project| project.id == id && project.archived_at.is_none())
            .map(|project| project.id.clone())
    };

    // A note can link several projects; the first link is what every
    // single-select surface calls "the" note's project.
    if let Some(id) = input.note_project_ids.iter().find_map(|id| live(id)) {
        return Some(id);
    }
    if let Some(id) = input.settings_default_project_id.and_then(live) {
        return Some(id);
    }
    if let Some(inbox) = input
        .projects
        .iter()
        .find(|project| project.is_inbox && project.archived_at.is_none())
    {
        return Some(inbox.id.clone());
    }
    input.projects.first().map(|project| project.id.clone())
}

/// The live projects a note is linked to, oldest link first.
///
/// Desktop's `getProjectsForItem('note', id)`: ordered by the link's
/// `createdAt`, then its id. Links of a deleted project are not a project the
/// note has.
pub fn note_project_ids(conn: &Connection, note_id: &str) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT l.project_id
               FROM project_links l
               JOIN projects p ON p.id = l.project_id AND p.deleted_at IS NULL
              WHERE l.item_type = 'note' AND l.item_id = ?1 AND l.deleted_at IS NULL
              ORDER BY l.created_at, l.id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![note_id], |row| row.get::<_, String>(0))
        .map_err(failed)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(failed)
}
