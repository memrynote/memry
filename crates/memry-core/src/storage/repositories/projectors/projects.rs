//! `project`, plus the `project_statuses` and `project_links` rows its two
//! nested arrays feed (chapter 13 §13.7.4, data-model §A.4).
//!
//! The second field-merged type, over the 9 entries of
//! `PROJECT_SYNCABLE_FIELDS` (§6.7). Read and assign only in this feature
//! (FR-060), but projected fully so the read surface is complete.
//!
//! The two nested arrays are read as **opaque arrays**, not as nested field
//! tables. A status or a link written by a newer build carries its unknown keys
//! into the row set unchanged, which is §13.2 applied one level down: nothing
//! here is ever serialised back to the wire, so the arrays only ever need to be
//! walkable, never re-declarable.

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::api::errors::StorageError;

use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{
    ItemContext, clock_text, failed, field_clocks_text, flag, instant, number_or_default, text,
    text_or_default,
};

const PROJECT_FIELDS: &[Field] = &[
    Field::opt("name", Kind::Text),
    Field::opt_null("description", Kind::Text),
    Field::opt("color", Kind::Text),
    Field::opt_null("icon", Kind::Text),
    Field::opt("position", Kind::Number),
    Field::opt("isInbox", Kind::Bool),
    Field::opt_null("archivedAt", Kind::Text),
    Field::opt_null("homeNoteId", Kind::Text),
    Field::opt("statuses", Kind::Array),
    Field::opt("links", Kind::Array),
    Field::opt("clock", Kind::Clock),
    Field::opt("fieldClocks", Kind::ClockMap),
    Field::opt("createdAt", Kind::Text),
    Field::opt("modifiedAt", Kind::Text),
];

pub fn read_project(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("project", parsed, PROJECT_FIELDS)
}

pub fn project_project(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO projects (
             id, name, description, color, icon, position, is_inbox, archived_at,
             home_note_id, created_at, modified_at, clock, field_clocks,
             synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             color = excluded.color,
             icon = excluded.icon,
             position = excluded.position,
             is_inbox = excluded.is_inbox,
             archived_at = excluded.archived_at,
             home_note_id = excluded.home_note_id,
             created_at = excluded.created_at,
             modified_at = excluded.modified_at,
             clock = excluded.clock,
             field_clocks = excluded.field_clocks,
             synced_at = excluded.synced_at,
             deleted_at = excluded.deleted_at",
        params![
            item.item_id,
            text_or_default(view, "name", ""),
            text(view, "description"),
            text_or_default(view, "color", ""),
            text(view, "icon"),
            number_or_default(view, "position", 0),
            flag(view, "isInbox").unwrap_or(0),
            // A wall-clock value on the wire, kept as TEXT (§A.6).
            text(view, "archivedAt"),
            // A note id, not a home page id (§13.11).
            text(view, "homeNoteId"),
            instant(view, "createdAt"),
            instant(view, "modifiedAt"),
            clock_text(view),
            field_clocks_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;

    project_statuses(conn, item, view)?;
    project_links(conn, item, view)
}

/// The nested `statuses` array (`StatusSyncSchema`).
///
/// Replaced wholesale: the array is the whole truth for this project, so a
/// status the payload dropped has no row rather than an orphan.
fn project_statuses(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    let Some(statuses) = view.get("statuses").and_then(Value::as_array) else {
        return Ok(());
    };

    conn.execute(
        "DELETE FROM project_statuses WHERE project_id = ?1",
        params![item.item_id],
    )
    .map_err(failed)?;

    for (position, status) in statuses.iter().enumerate() {
        let Some(status) = status.as_object() else {
            continue;
        };
        let Some(id) = text(status, "id") else {
            // No id, no primary key. The whole status is still in the verbatim
            // payload, so nothing is lost by leaving it unprojected.
            continue;
        };
        conn.execute(
            "INSERT INTO project_statuses (
                 id, project_id, name, color, position, is_default, is_done,
                 created_at, clock, synced_at, deleted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
                 project_id = excluded.project_id,
                 name = excluded.name,
                 color = excluded.color,
                 position = excluded.position,
                 is_default = excluded.is_default,
                 is_done = excluded.is_done,
                 created_at = excluded.created_at,
                 clock = excluded.clock,
                 synced_at = excluded.synced_at,
                 deleted_at = excluded.deleted_at",
            params![
                id,
                item.item_id,
                text_or_default(status, "name", ""),
                text_or_default(status, "color", ""),
                number_or_default(status, "position", position as i64),
                flag(status, "isDefault"),
                flag(status, "isDone"),
                instant(status, "createdAt"),
                clock_text(view),
                item.synced_at,
                item.deleted_at,
            ],
        )
        .map_err(failed)?;
    }
    Ok(())
}

/// The nested `links` array (`ProjectLinkSyncSchema`).
fn project_links(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    let Some(links) = view.get("links").and_then(Value::as_array) else {
        return Ok(());
    };

    conn.execute(
        "DELETE FROM project_links WHERE project_id = ?1",
        params![item.item_id],
    )
    .map_err(failed)?;

    for (position, link) in links.iter().enumerate() {
        let Some(link) = link.as_object() else {
            continue;
        };
        let Some(id) = text(link, "id") else {
            continue;
        };
        conn.execute(
            "INSERT INTO project_links (
                 id, project_id, item_type, item_id, position, pinned, created_at,
                 clock, synced_at, deleted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                 project_id = excluded.project_id,
                 item_type = excluded.item_type,
                 item_id = excluded.item_id,
                 position = excluded.position,
                 pinned = excluded.pinned,
                 created_at = excluded.created_at,
                 clock = excluded.clock,
                 synced_at = excluded.synced_at,
                 deleted_at = excluded.deleted_at",
            params![
                id,
                text(link, "projectId").unwrap_or_else(|| item.item_id.to_owned()),
                text_or_default(link, "itemType", ""),
                text_or_default(link, "itemId", ""),
                number_or_default(link, "position", position as i64),
                flag(link, "pinned"),
                instant(link, "createdAt"),
                clock_text(view),
                item.synced_at,
                item.deleted_at,
            ],
        )
        .map_err(failed)?;
    }
    Ok(())
}
