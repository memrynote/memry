//! The project hub's resolved contents and an item's projects: desktop's
//! `getProjectContents` and `getProjectsForItem`
//! (`apps/desktop/src/main/database/queries/projects.ts:720,869`).
//!
//! A link whose target is gone (a deleted note or event, or one this device
//! never received) resolves to nothing and is dropped, as desktop's inner join
//! drops it, so every entry is renderable. The links are read from the
//! verbatim payload ([`super::links`]) because `pinned` is a number on the
//! wire and the projected column only carries booleans; the targets are read
//! from the `notes`, `note_files` and `calendar_events` projections.

use rusqlite::{Connection, OptionalExtension, params};

use crate::api::errors::StorageError;
use crate::storage::repositories::instants;

use super::super::notes::failed;
use super::{get, links};

/// A markdown note linked to a project (`ProjectLinkedNote`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedNote {
    pub id: String,
    pub title: String,
    pub emoji: Option<String>,
    /// ISO 8601; `None` when the note carries no readable `modifiedAt`.
    pub modified_at: Option<String>,
    pub pinned: bool,
}

/// A note that is not markdown, linked to a project (`ProjectLinkedFile`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedFile {
    pub id: String,
    pub title: String,
    pub file_type: String,
    pub mime_type: Option<String>,
    /// From the device-local `note_files` row; `None` where the vault tier
    /// has not read the file (every phone).
    pub file_size: Option<i64>,
    pub modified_at: Option<String>,
}

/// A calendar event linked to a project (`ProjectLinkedEvent`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedEvent {
    pub id: String,
    pub title: String,
    pub start_at: String,
    pub end_at: Option<String>,
    pub is_all_day: bool,
}

/// Everything a project links to (`ProjectContents`). Desktop's `counts` are
/// the three lengths.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectContents {
    pub notes: Vec<LinkedNote>,
    pub files: Vec<LinkedFile>,
    pub events: Vec<LinkedEvent>,
}

/// A project an item belongs to (`ProjectRef`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRef {
    pub id: String,
    pub name: String,
    pub color: String,
    pub icon: Option<String>,
}

/// Resolves a project's links (`getProjectContents`).
///
/// A `note` or `file` link resolves against the note row and lands by the
/// row's `file_type`, never the link's `item_type`: markdown is a note,
/// anything else a file. Notes and files are ordered by link position then
/// title, events by start. An unknown or deleted project has no contents, as
/// desktop's queries return none for it.
pub fn contents(conn: &Connection, project_id: &str) -> Result<ProjectContents, StorageError> {
    if get(conn, project_id)?.is_none() {
        return Ok(ProjectContents::default());
    }
    let mut note_rows: Vec<(i64, bool, NoteRow)> = Vec::new();
    let mut events = Vec::new();
    for link in links(conn, project_id)? {
        match link.item_type.as_str() {
            "note" | "file" => {
                if let Some(row) = note_row(conn, &link.item_id)? {
                    note_rows.push((link.position, link.pinned, row));
                }
            }
            "calendar_event" => events.extend(event(conn, &link.item_id)?),
            _ => {}
        }
    }
    // Stable sorts: equal keys keep the links' order.
    note_rows.sort_by(|a, b| (a.0, &a.2.title).cmp(&(b.0, &b.2.title)));
    events.sort_by(|a: &LinkedEvent, b| a.start_at.cmp(&b.start_at));

    let mut contents = ProjectContents {
        events,
        ..ProjectContents::default()
    };
    for (_, pinned, row) in note_rows {
        if row.file_type == "markdown" {
            contents.notes.push(LinkedNote {
                id: row.id,
                title: row.title,
                emoji: row.emoji,
                modified_at: row.modified_at,
                pinned,
            });
        } else {
            contents.files.push(LinkedFile {
                id: row.id,
                title: row.title,
                file_type: row.file_type,
                mime_type: row.mime_type,
                file_size: row.file_size,
                modified_at: row.modified_at,
            });
        }
    }
    Ok(contents)
}

/// The live projects an item is linked to (`getProjectsForItem`), oldest link
/// first with the link id as the tiebreak: a caller showing one project
/// treats the first as the item's, so the order must not move. The item type
/// matches exactly, as desktop matches it.
pub fn projects_for_item(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Vec<ProjectRef>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT p.id, p.name, p.color, p.icon
               FROM project_links l
               JOIN projects p ON p.id = l.project_id AND p.deleted_at IS NULL
              WHERE l.item_type = ?1 AND l.item_id = ?2 AND l.deleted_at IS NULL
              ORDER BY l.created_at, l.id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![item_type, item_id], |row| {
            Ok(ProjectRef {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                icon: row.get(3)?,
            })
        })
        .map_err(failed)?;
    let mut projects = Vec::new();
    for row in rows {
        projects.push(row.map_err(failed)?);
    }
    Ok(projects)
}

struct NoteRow {
    id: String,
    title: String,
    emoji: Option<String>,
    file_type: String,
    mime_type: Option<String>,
    file_size: Option<i64>,
    modified_at: Option<String>,
}

fn note_row(conn: &Connection, note_id: &str) -> Result<Option<NoteRow>, StorageError> {
    conn.prepare_cached(
        "SELECT n.id, n.title, n.emoji, n.file_type, n.mime_type, f.file_size, n.modified_at
           FROM notes n
           LEFT JOIN note_files f ON f.note_id = n.id
          WHERE n.id = ?1 AND n.deleted_at IS NULL",
    )
    .map_err(failed)?
    .query_row(params![note_id], |row| {
        Ok(NoteRow {
            id: row.get(0)?,
            title: row.get(1)?,
            emoji: row.get(2)?,
            file_type: row.get(3)?,
            mime_type: row.get(4)?,
            file_size: row.get(5)?,
            modified_at: row.get::<_, Option<i64>>(6)?.and_then(instants::to_iso8601),
        })
    })
    .optional()
    .map_err(failed)
}

fn event(conn: &Connection, event_id: &str) -> Result<Option<LinkedEvent>, StorageError> {
    conn.prepare_cached(
        "SELECT id, title, start_at, end_at, is_all_day
           FROM calendar_events
          WHERE id = ?1 AND deleted_at IS NULL",
    )
    .map_err(failed)?
    .query_row(params![event_id], |row| {
        Ok(LinkedEvent {
            id: row.get(0)?,
            title: row.get(1)?,
            start_at: row.get(2)?,
            end_at: row.get(3)?,
            is_all_day: row.get::<_, i64>(4)? != 0,
        })
    })
    .optional()
    .map_err(failed)
}
