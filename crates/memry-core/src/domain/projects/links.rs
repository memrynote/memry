//! The project hub's links: the nested `links` array, and a markdown note's
//! `project` property (`apps/desktop/src/main/tasks/project-item-links.ts`,
//! `project-name-propagation.ts`, `notes/project-property.ts`).
//!
//! ## Two homes for one membership
//!
//! A calendar event, a file, or a note that is not markdown is linked by an
//! entry in the project's `links` array, and that is all.
//!
//! A **markdown note** is different, and getting it wrong loses the link on
//! desktop. Its membership lives in its own `project` property — a list of
//! project **names** — and desktop derives its link row from that property.
//! Desktop's project handler applies only `pinned`/`position` from a markdown
//! note's entry in an inbound `links` array, never membership, and its next
//! push of the project drops an entry it did not derive. So linking one here
//! writes both: the note's property (the membership desktop reads) and a
//! mirrored `links` entry (so this device's hub shows it before desktop
//! re-derives and re-pushes the row under its own id). Unlinking removes both.
//! Pinning is `links` only, which is what desktop applies.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::api::errors::StorageError;
use crate::storage::repositories::{Change, StoredPayload, sync_items};
use crate::sync::outbox::Durable;

use super::super::notes::{self, failed, iso};
use super::super::tasks::valid_item_id;
use super::write::{edit_project, mint_id};
use super::{ITEM_TYPE, require_live};

/// The note property desktop keeps a markdown note's project names in
/// (`PROJECT_PROPERTY_KEY`, `packages/contracts/src/property-types.ts:24`).
pub const PROJECT_PROPERTY_KEY: &str = "project";

/// The item kinds a link may point at (`ProjectLinkItemSchema`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkItemType {
    Note,
    CalendarEvent,
    File,
}

impl LinkItemType {
    /// Desktop's spelling (`'note' | 'calendar_event' | 'file'`).
    pub fn as_str(self) -> &'static str {
        match self {
            LinkItemType::Note => "note",
            LinkItemType::CalendarEvent => "calendar_event",
            LinkItemType::File => "file",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "note" => Some(LinkItemType::Note),
            "calendar_event" => Some(LinkItemType::CalendarEvent),
            "file" => Some(LinkItemType::File),
            _ => None,
        }
    }
}

/// One entry of the nested `links` array (`ProjectLinkSyncSchema`).
///
/// `item_type` stays a string: a newer build's kind still reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectLink {
    pub id: String,
    pub project_id: String,
    pub item_type: String,
    pub item_id: String,
    pub position: i64,
    /// Shown in the hub's overview rail. `1` on the wire; an absent key (a
    /// client older than the hub) reads as unpinned.
    pub pinned: bool,
    pub created_at: Option<String>,
}

/// A project's links, ordered by `position` then `createdAt`
/// (`getProjectLinks`). Entries without an id, item type or item id are
/// skipped, as the projector skips them.
pub fn links(conn: &Connection, project_id: &str) -> Result<Vec<ProjectLink>, StorageError> {
    require_live(conn, project_id)?;
    let mut links: Vec<ProjectLink> = stored_links(conn, project_id)?
        .iter()
        .filter_map(|entry| read_link(entry, project_id))
        .collect();
    links.sort_by(|a, b| {
        (a.position, &a.created_at, &a.id).cmp(&(b.position, &b.created_at, &b.id))
    });
    Ok(links)
}

/// Links an item to the project (`linkProjectItem`), returning the project
/// payload. Linking an item already linked adds no second entry.
pub fn link(
    conn: &Connection,
    project_id: &str,
    item_type: LinkItemType,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let project = require_live(conn, project_id)?;
    valid_item_id(item_id)?;
    let markdown = item_type == LinkItemType::Note && is_markdown_note(conn, item_id)?;
    if markdown {
        rewrite_note_names(conn, item_id, device_id, now_ms, |names| {
            with_name(names, &project.name)
        })?;
    }

    let mut entries = stored_links(conn, project_id)?;
    if !entries
        .iter()
        .any(|entry| names_item(entry, markdown, item_type, item_id))
    {
        entries.push(json!({
            "id": mint_id(),
            "projectId": project_id,
            "itemType": item_type.as_str(),
            "itemId": item_id,
            "position": 0,
            "pinned": 0,
            "createdAt": iso(now_ms)?,
        }));
    }
    edit_project(
        conn,
        project_id,
        vec![("links", Change::Set(Value::Array(entries)))],
        device_id,
        now_ms,
    )
}

/// Unlinks an item from the project (`unlinkProjectItem`), returning the
/// project payload.
pub fn unlink(
    conn: &Connection,
    project_id: &str,
    item_type: LinkItemType,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let project = require_live(conn, project_id)?;
    let markdown = item_type == LinkItemType::Note && is_markdown_note(conn, item_id)?;
    if markdown {
        rewrite_note_names(conn, item_id, device_id, now_ms, |names| {
            without_name(names, &project.name)
        })?;
    }

    let mut entries = stored_links(conn, project_id)?;
    entries.retain(|entry| !names_item(entry, markdown, item_type, item_id));
    edit_project(
        conn,
        project_id,
        vec![("links", Change::Set(Value::Array(entries)))],
        device_id,
        now_ms,
    )
}

/// Pins or unpins a linked item (`setProjectLinkPinned`), matched by item id
/// alone as desktop matches it. Unpinning keeps the link.
///
/// An item with no link is an error rather than desktop's silent no-op write:
/// a write that changes nothing would still tick the clock and push.
pub fn set_link_pinned(
    conn: &Connection,
    project_id: &str,
    item_id: &str,
    pinned: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    require_live(conn, project_id)?;
    let mut entries = stored_links(conn, project_id)?;
    let mut found = false;
    for entry in entries.iter_mut().filter_map(Value::as_object_mut) {
        if entry.get("itemId").and_then(Value::as_str) == Some(item_id) {
            entry.insert("pinned".to_owned(), json!(i64::from(pinned)));
            found = true;
        }
    }
    if !found {
        return Err(StorageError::Failed {
            what: format!("project {project_id} has no link to {item_id}"),
        });
    }
    edit_project(
        conn,
        project_id,
        vec![("links", Change::Set(Value::Array(entries)))],
        device_id,
        now_ms,
    )
}

/// The markdown notes linked to a project (`listMarkdownNoteIdsForProject`),
/// deduplicated, in `links` order.
pub(super) fn markdown_note_ids(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<String>, StorageError> {
    let mut ids: Vec<String> = Vec::new();
    for entry in stored_links(conn, project_id)? {
        let Some(item_id) = entry.get("itemId").and_then(Value::as_str) else {
            continue;
        };
        if !ids.iter().any(|id| id == item_id) && is_markdown_note(conn, item_id)? {
            ids.push(item_id.to_owned());
        }
    }
    Ok(ids)
}

/// `propagateProjectRename`: every linked markdown note naming `old` (case
/// folded) names `new` instead.
pub(super) fn propagate_rename(
    conn: &Connection,
    project_id: &str,
    old: &str,
    new: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    for note_id in markdown_note_ids(conn, project_id)? {
        rewrite_linked_note(conn, &note_id, device_id, now_ms, |names| {
            names
                .into_iter()
                .map(|name| {
                    if name.to_lowercase() == old.to_lowercase() {
                        new.to_owned()
                    } else {
                        name
                    }
                })
                .collect()
        })?;
    }
    Ok(())
}

/// `propagateProjectDelete`: `name` leaves each note's `project` property.
pub(super) fn remove_name_from_notes(
    conn: &Connection,
    note_ids: &[String],
    name: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    for note_id in note_ids {
        rewrite_linked_note(conn, note_id, device_id, now_ms, |names| {
            without_name(names, name)
        })?;
    }
    Ok(())
}

/// [`rewrite_note_names`] for propagation, which skips a note it cannot
/// rewrite — deleted, or metadata only — as desktop's
/// `getEntityPropertiesRecord` returning nothing skips it.
fn rewrite_linked_note(
    conn: &Connection,
    note_id: &str,
    device_id: &str,
    now_ms: i64,
    rewrite: impl FnOnce(Vec<String>) -> Vec<String>,
) -> Result<(), StorageError> {
    let writable = sync_items::load(conn, notes::ITEM_TYPE, note_id)?
        .is_some_and(|row| row.deleted_at.is_none() && row.payload.is_some());
    if writable {
        rewrite_note_names(conn, note_id, device_id, now_ms, rewrite)?;
    }
    Ok(())
}

/// Rewrites one note's `project` names, keeping every other property. No write
/// when the list does not change.
fn rewrite_note_names(
    conn: &Connection,
    note_id: &str,
    device_id: &str,
    now_ms: i64,
    rewrite: impl FnOnce(Vec<String>) -> Vec<String>,
) -> Result<(), StorageError> {
    let stored = notes::require_payload(conn, notes::ITEM_TYPE, note_id)?;
    let mut properties = match stored.object().get("properties") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(properties)) => properties.clone(),
        Some(_) => {
            return Err(StorageError::Failed {
                what: format!("note {note_id} has properties that are not an object"),
            });
        }
    };
    let names = read_project_names(properties.get(PROJECT_PROPERTY_KEY));
    let next = rewrite(names.clone());
    if next == names {
        return Ok(());
    }
    properties.insert(PROJECT_PROPERTY_KEY.to_owned(), json!(next));
    notes::edit(
        conn,
        notes::ITEM_TYPE,
        note_id,
        vec![("properties", Change::Set(Value::Object(properties)))],
        device_id,
        now_ms,
    )?
    .acknowledge();
    Ok(())
}

/// Desktop's `readProjectNames`: a clean, case-insensitively unique name list
/// from every shape a hand-edited frontmatter produces — an array, a bare
/// string, a JSON array written as a string by an older build, or nothing.
fn read_project_names(raw: Option<&Value>) -> Vec<String> {
    let entries: Vec<Value> = match raw {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(entries)) => entries.clone(),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            match serde_json::from_str::<Value>(trimmed) {
                Ok(Value::Array(entries)) if trimmed.starts_with('[') => entries,
                _ => vec![Value::String(text.clone())],
            }
        }
        Some(_) => Vec::new(),
    };
    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        let Some(name) = entry
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        if !names
            .iter()
            .any(|seen| seen.to_lowercase() == name.to_lowercase())
        {
            names.push(name.to_owned());
        }
    }
    names
}

fn with_name(mut names: Vec<String>, name: &str) -> Vec<String> {
    if !names
        .iter()
        .any(|seen| seen.to_lowercase() == name.to_lowercase())
    {
        names.push(name.to_owned());
    }
    names
}

fn without_name(names: Vec<String>, name: &str) -> Vec<String> {
    names
        .into_iter()
        .filter(|seen| seen.to_lowercase() != name.to_lowercase())
        .collect()
}

/// Whether an entry is the link to this item. A markdown note's entry is
/// matched by item id alone, because desktop may hold it under `file` (a
/// legacy import) as well as `note`.
fn names_item(entry: &Value, markdown: bool, item_type: LinkItemType, item_id: &str) -> bool {
    entry.get("itemId").and_then(Value::as_str) == Some(item_id)
        && (markdown || entry.get("itemType").and_then(Value::as_str) == Some(item_type.as_str()))
}

/// The stored `links` array; absent, `null` and a non-array all read empty.
fn stored_links(conn: &Connection, project_id: &str) -> Result<Vec<Value>, StorageError> {
    let Some(raw) = sync_items::load(conn, ITEM_TYPE, project_id)?.and_then(|row| row.payload)
    else {
        return Ok(Vec::new());
    };
    let stored = StoredPayload::parse(&raw).map_err(|error| StorageError::Failed {
        what: format!("project {project_id} payload will not parse: {error}"),
    })?;
    Ok(match stored.object().get("links") {
        Some(Value::Array(entries)) => entries.clone(),
        _ => Vec::new(),
    })
}

fn read_link(entry: &Value, project_id: &str) -> Option<ProjectLink> {
    let entry = entry.as_object()?;
    let text = |key: &str| entry.get(key).and_then(Value::as_str).map(str::to_owned);
    let number = |key: &str| {
        entry
            .get(key)
            .and_then(|value| value.as_i64().or_else(|| value.as_f64().map(|n| n as i64)))
    };
    Some(ProjectLink {
        id: text("id")?,
        project_id: text("projectId").unwrap_or_else(|| project_id.to_owned()),
        item_type: text("itemType")?,
        item_id: text("itemId")?,
        position: number("position").unwrap_or(0),
        pinned: match entry.get("pinned") {
            Some(Value::Bool(pinned)) => *pinned,
            _ => number("pinned").is_some_and(|pinned| pinned != 0),
        },
        created_at: text("createdAt"),
    })
}

/// A live note whose `file_type` is markdown — desktop's `isMarkdownNote`,
/// keyed off the row and never the caller's `item_type`.
fn is_markdown_note(conn: &Connection, note_id: &str) -> Result<bool, StorageError> {
    let file_type: Option<String> = conn
        .query_row(
            "SELECT file_type FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            params![note_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(file_type.as_deref() == Some("markdown"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_names_read_every_shape_desktop_tolerates() {
        assert_eq!(read_project_names(None), Vec::<String>::new());
        assert_eq!(read_project_names(Some(&json!(""))), Vec::<String>::new());
        assert_eq!(read_project_names(Some(&json!("Alpha"))), vec!["Alpha"]);
        assert_eq!(
            read_project_names(Some(&json!("[\"Alpha\",\"Beta\"]"))),
            vec!["Alpha", "Beta"]
        );
        assert_eq!(
            read_project_names(Some(&json!([" Alpha ", "alpha", null, "", "Beta"]))),
            vec!["Alpha", "Beta"]
        );
    }

    #[test]
    fn a_name_is_added_once_and_removed_case_insensitively() {
        let names = with_name(vec!["Alpha".to_owned()], "alpha");
        assert_eq!(names, vec!["Alpha"]);
        let names = with_name(names, "Beta");
        assert_eq!(names, vec!["Alpha", "Beta"]);
        assert_eq!(without_name(names, "ALPHA"), vec!["Beta"]);
    }

    #[test]
    fn a_link_type_round_trips_desktops_spelling() {
        for kind in [
            LinkItemType::Note,
            LinkItemType::CalendarEvent,
            LinkItemType::File,
        ] {
            assert_eq!(LinkItemType::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(LinkItemType::parse("canvas"), None);
    }

    #[test]
    fn a_pinned_number_and_a_missing_pin_both_read() {
        let pinned = read_link(
            &json!({"id": "l1", "itemType": "note", "itemId": "n1", "position": 2, "pinned": 1}),
            "p1",
        )
        .map(|link| (link.pinned, link.position, link.project_id));
        assert_eq!(pinned, Some((true, 2, "p1".to_owned())));
        let legacy = read_link(
            &json!({"id": "l2", "itemType": "file", "itemId": "f1"}),
            "p1",
        );
        assert_eq!(legacy.map(|link| link.pinned), Some(false));
    }
}
