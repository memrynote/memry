//! A markdown note's `project` property, projected onto its projects' `links`
//! (desktop's `reconcileNoteLinks`,
//! `apps/desktop/src/main/projections/projectors/note-project-links-projector.ts`).
//!
//! The property is the source of truth for a markdown note's membership
//! ([`super::links`] says why). Desktop re-derives the note's link rows from
//! it on every note write; here the property writer of
//! [`crate::domain::properties`] calls [`sync_links_from_property`] inside the
//! transaction of each note property write, so the note and the project
//! payloads it changes commit together.
//!
//! There is no synced-link memo: desktop keeps one because its link rows and
//! the project payload it pushes are two copies, while here the payload's
//! `links` array is the only copy. A project whose `links` already agree with
//! the property is not written, so an unchanged membership queues nothing.

use std::collections::HashMap;

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::storage::repositories::Change;
use crate::sync::field_merge::PROJECT_SYNCABLE_FIELDS;
use crate::sync::outbox;

use super::super::notes::{failed, iso};
use super::super::tasks::edit_merged_in;
use super::ITEM_TYPE;
use super::links::{is_markdown_note, stored_links};
use super::write::mint_id;

/// Brings every project's `links` in line with `names`, the note's `project`
/// property as [`super::project_names`] reads it, and returns the projects it
/// wrote, each with its own outbox row. Runs inside the caller's transaction.
///
/// A name resolves case-insensitively to the oldest live project of that name,
/// archived ones included; a name that resolves to nothing links nothing. A
/// project gaining the note gets a `note` entry (position 0, unpinned); a
/// project losing it drops every entry for the note, whatever its item type (a
/// hub import may hold a markdown note as `file`). An entry that stays is left
/// as it is, so its `position` and `pinned` survive. A note that is not a live
/// markdown note changes nothing.
pub fn sync_links_from_property(
    tx: &Connection,
    note_id: &str,
    names: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    if !is_markdown_note(tx, note_id)? {
        return Ok(Vec::new());
    }
    let desired = resolve(tx, names)?;
    let mut candidates = desired.clone();
    for project_id in linked_projects(tx, note_id)? {
        if !candidates.contains(&project_id) {
            candidates.push(project_id);
        }
    }

    let mut written = Vec::new();
    for project_id in candidates {
        let mut entries = stored_links(tx, &project_id)?;
        let names_note =
            |entry: &Value| entry.get("itemId").and_then(Value::as_str) == Some(note_id);
        let linked = entries.iter().any(names_note);
        let wanted = desired.contains(&project_id);
        if wanted == linked {
            continue;
        }
        if wanted {
            entries.push(json!({
                "id": mint_id(),
                "projectId": project_id,
                "itemType": "note",
                "itemId": note_id,
                "position": 0,
                "pinned": 0,
                "createdAt": iso(now_ms)?,
            }));
        } else {
            entries.retain(|entry| !names_note(entry));
        }
        edit_merged_in(
            tx,
            ITEM_TYPE,
            &PROJECT_SYNCABLE_FIELDS,
            &project_id,
            vec![("links", Change::Set(Value::Array(entries)))],
            device_id,
            now_ms,
        )?;
        outbox::enqueue(tx, &outbox::Change::upsert(ITEM_TYPE, &project_id), now_ms)?;
        written.push(project_id);
    }
    Ok(written)
}

/// The project ids `names` resolve to, in name order, each once
/// (`resolveNamedProjects`: oldest first, so a later duplicate name loses).
fn resolve(conn: &Connection, names: &[String]) -> Result<Vec<String>, StorageError> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let mut statement = conn
        .prepare(
            "SELECT id, name FROM projects WHERE deleted_at IS NULL
              ORDER BY created_at, id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?;
    let mut by_name: HashMap<String, String> = HashMap::new();
    for row in rows {
        let (id, name) = row.map_err(failed)?;
        by_name.entry(name.to_lowercase()).or_insert(id);
    }
    let mut ids: Vec<String> = Vec::new();
    for name in names {
        if let Some(id) = by_name.get(&name.to_lowercase())
            && !ids.contains(id)
        {
            ids.push(id.clone());
        }
    }
    Ok(ids)
}

/// The live projects with a projected link to `note_id`, of any item type.
fn linked_projects(conn: &Connection, note_id: &str) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT DISTINCT l.project_id
               FROM project_links l
               JOIN projects p ON p.id = l.project_id
              WHERE l.item_id = ?1 AND l.deleted_at IS NULL AND p.deleted_at IS NULL
              ORDER BY l.project_id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![note_id], |row| row.get(0))
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}
