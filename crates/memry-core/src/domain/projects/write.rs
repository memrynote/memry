//! Project writes: create, edit, archive, reorder, home note (D2). Delete lives in
//! `delete.rs`.
//!
//! Each function names the desktop function it mirrors
//! (`packages/domain-tasks/src/commands.ts`, `apps/desktop/src/main/database/queries/projects.ts`).
//! Every project write is one [`crate::sync::outbox::commit`] with its outbox
//! row; a create seeds all nine field clocks from its first document tick
//! (§6.7) and an edit ticks the document clock and each changed field's clock
//! through [`crate::domain::tasks::edit_merged_in`]. An edit that changes no
//! field writes nothing and returns `None` (see [`edit_project`]).

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::crypto::sodium::random_bytes;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{Change, sync_items};
use crate::sync::field_merge::{PROJECT_SYNCABLE_FIELDS, init_all_field_clocks};
use crate::sync::outbox::{self, Durable};

use super::super::notes::{self, failed, insert_local, iso, next_clock, object};
use super::super::{task_merge, tasks};
use super::status_list::{StatusInput, custom_statuses, default_statuses, reconcile};
use super::{ITEM_TYPE, links, require_live};

/// `ProjectCreateSchema`'s colour default (`packages/contracts/src/tasks-api.ts:137`).
pub const DEFAULT_PROJECT_COLOR: &str = "#6366f1";
/// Desktop's seeded Inbox id, shared by every device.
pub const INBOX_ID: &str = "inbox";
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
    insert(conn, project, false, device_id, now_ms)
}

fn insert(
    conn: &Connection,
    project: &NewProject<'_>,
    is_inbox: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let id = match project.id {
        Some(id) => tasks::valid_item_id(id)?.to_owned(),
        None => mint_id(),
    };
    let mut payload = new_payload(project, &id, is_inbox, now_ms)?;
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &id),
        now_ms,
        |tx| {
            let (clock, field_clocks) = first_clocks(device_id)?;
            payload.insert("position".to_owned(), json!(next_position(tx)?));
            payload.insert("clock".to_owned(), clock);
            payload.insert("fieldClocks".to_owned(), field_clocks);
            insert_local(tx, ITEM_TYPE, &id, payload, now_ms)?;
            Ok(id.clone())
        },
    )
}

/// A new project's payload, validated, without its position and clocks.
fn new_payload(
    project: &NewProject<'_>,
    id: &str,
    is_inbox: bool,
    now_ms: i64,
) -> Result<Object, StorageError> {
    valid_name(project.name)?;
    if let Some(description) = project.description {
        valid_description(description)?;
    }
    let color = project.color.unwrap_or(DEFAULT_PROJECT_COLOR);
    valid_color(color)?;
    let at = iso(now_ms)?;
    let statuses = match project.statuses {
        Some(inputs) => custom_statuses(id, inputs, &at)?,
        None => default_statuses(id, &at),
    };
    let mut payload = object(json!({
        "name": project.name,
        "color": color,
        "isInbox": is_inbox,
        "statuses": statuses,
        "links": [],
        "createdAt": at,
        "modifiedAt": at,
    }));
    // Absent rather than `null` (§13.4): a create knows of nothing to clear.
    for (key, value) in [("description", project.description), ("icon", project.icon)] {
        if let Some(value) = value {
            payload.insert(key.to_owned(), json!(value));
        }
    }
    Ok(payload)
}

/// This device's first document clock and all nine field clocks seeded from it (§6.7).
fn first_clocks(device_id: &str) -> Result<(Value, Value), StorageError> {
    let clock = next_clock(&Object::new(), device_id)?;
    let field_clocks =
        init_all_field_clocks(&task_merge::as_clock(&clock)?, &PROJECT_SYNCABLE_FIELDS);
    Ok((clock, json!(field_clocks)))
}

/// The Inbox (desktop's `ensureDefaultTaskProject`,
/// `apps/desktop/src/main/database/defaults.ts:12`): id `inbox`, desktop's
/// name, colour and icon, the default three statuses. Written only when no
/// Inbox record exists, tombstones included, so a vault that never synced
/// (or a phone whose first sync has not reached it) still has somewhere to
/// file a task.
///
/// Written as desktop writes it: with **no clock and no outbox row**. A pull
/// that brings another device's Inbox replaces it outright (a local record
/// with no clock takes the remote wholesale, §6.3.1), so a vault joined
/// before its first pull never merges its seed's statuses and links into the
/// synced ones. A sync pass whose pull reached the feed head then gives a
/// seed no pull replaced its clock and queues it ([`seed_unclocked`]), as
/// desktop's `seedUnclocked` does, so every device still meets on the one id.
/// Returns whether it wrote one.
pub fn ensure_inbox(conn: &Connection, now_ms: i64) -> Result<bool, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1 OR is_inbox = 1)
                 OR EXISTS(SELECT 1 FROM sync_items WHERE item_type = ?2 AND item_id = ?1)",
            params![INBOX_ID, ITEM_TYPE],
            |row| row.get(0),
        )
        .map_err(failed)?;
    if exists {
        return Ok(false);
    }
    let inbox = NewProject {
        id: Some(INBOX_ID),
        name: "Inbox",
        description: Some("Quick capture for tasks"),
        color: None,
        icon: Some("📥"),
        statuses: None,
    };
    let mut payload = new_payload(&inbox, INBOX_ID, true, now_ms)?;
    payload.insert("position".to_owned(), json!(next_position(&tx)?));
    insert_local(&tx, ITEM_TYPE, INBOX_ID, payload, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(true)
}

/// Desktop's `seedUnclocked` for projects (`project-handler.ts:402`): each
/// project record this device wrote with no clock and no pull touched (only
/// [`ensure_inbox`] writes one) gets this device's first clock and all nine
/// field clocks, and is queued as a `create`. Run by the sync pass after a
/// pull that reached the feed head ([`crate::sync::engine::PassSeed`]), so an
/// Inbox another device pushed first has already replaced the seed.
/// A seed first sync's refs pass found on the server too waits `metadata-only`
/// for the server's body, so it is never seeded, even when that fetch failed.
/// Idempotent: a seeded record has a clock. Returns the seeded ids.
pub fn seed_unclocked(
    conn: &Connection,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let ids: Vec<String> = {
        let mut statement = tx
            .prepare(
                "SELECT item_id FROM sync_items
                  WHERE item_type = ?1 AND clock IS NULL AND signer_device_id IS NULL
                    AND server_cursor IS NULL AND deleted_at IS NULL AND payload IS NOT NULL
                    AND corrupt_at IS NULL AND payload_state <> 'metadata-only'
                  ORDER BY rowid",
            )
            .map_err(failed)?;
        statement
            .query_map([ITEM_TYPE], |row| row.get(0))
            .map_err(failed)?
            .collect::<Result<_, _>>()
            .map_err(failed)?
    };
    for id in &ids {
        let (clock, field_clocks) = first_clocks(device_id)?;
        sync_items::apply_local_edit_in(
            &tx,
            ITEM_TYPE,
            id,
            &[
                ("clock", Change::Set(clock)),
                ("fieldClocks", Change::Set(field_clocks)),
            ],
            now_ms,
        )?;
        outbox::enqueue(&tx, &outbox::Change::create(ITEM_TYPE, id), now_ms)?;
    }
    tx.commit().map_err(failed)?;
    Ok(ids)
}

/// Edits name, description, colour, icon and statuses in one write
/// (`updateProject` + `reconcileProjectStatuses`), returning the payload, or
/// `None` when every field already held its value.
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
) -> Result<Option<Durable<String>>, StorageError> {
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
/// `unarchiveProject`). The Inbox cannot be archived. `None` when the project
/// is already in that state.
pub fn set_archived(
    conn: &Connection,
    project_id: &str,
    archived: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<Durable<String>>, StorageError> {
    let project = require_live(conn, project_id)?;
    if archived && project.is_inbox {
        return Err(StorageError::Invalid {
            what: "cannot archive the inbox project".to_owned(),
        });
    }
    // Archiving an archived project keeps its first `archivedAt`.
    if archived == project.archived_at.is_some() {
        return Ok(None);
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
/// nothing. A project already at its position is not written, and is absent
/// from the result.
pub fn reorder(
    conn: &Connection,
    positions: &[(&str, i64)],
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<Durable<String>>, StorageError> {
    for (project_id, _) in positions {
        require_live(conn, project_id)?;
    }
    let mut written = Vec::new();
    for (project_id, position) in positions {
        written.extend(edit_project(
            conn,
            project_id,
            vec![("position", Change::set(*position))],
            device_id,
            now_ms,
        )?);
    }
    Ok(written)
}

/// Sets or clears (`None`) the project's home note (`setProjectHomeNote`).
pub fn set_home_note(
    conn: &Connection,
    project_id: &str,
    note_id: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<Durable<String>>, StorageError> {
    require_live(conn, project_id)?;
    edit_project(
        conn,
        project_id,
        vec![("homeNoteId", Change::Set(nullable(note_id)))],
        device_id,
        now_ms,
    )
}

/// One local edit to one project, over `PROJECT_SYNCABLE_FIELDS`, returning
/// the payload.
///
/// A field already holding the value is not a change: writing it would tick
/// its field clock and let an unchanged value beat a concurrent edit made on
/// another device (a phone rename re-sending the old description would win
/// over desktop's new one). When nothing is left the write is skipped whole,
/// with `None`: no `modifiedAt`, no document clock tick, no outbox row. A
/// ticked document clock alone would make a concurrent edit from another
/// device merge instead of apply, and the merge keeps this device's
/// `statuses` and `links` arrays, which have no field clock (RCA-STATUSNOOP).
/// Desktop writes these no-ops; skipping one is invisible on the wire.
pub(super) fn edit_project(
    conn: &Connection,
    project_id: &str,
    changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<Durable<String>>, StorageError> {
    edit_project_then(
        conn,
        project_id,
        changes,
        device_id,
        now_ms,
        |_, payload| Ok(payload),
    )
}

/// [`edit_project`] with `then` run on the new payload inside the write's
/// transaction, after the projection caught up.
pub(super) fn edit_project_then<T>(
    conn: &Connection,
    project_id: &str,
    changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
    then: impl FnOnce(&Connection, String) -> Result<T, StorageError>,
) -> Result<Option<Durable<T>>, StorageError> {
    let stored = notes::require_payload(conn, ITEM_TYPE, project_id)?;
    let changes: Vec<(&'static str, Change)> = changes
        .into_iter()
        .filter(|(key, change)| match change {
            Change::Set(value) => stored.object().get(*key).unwrap_or(&Value::Null) != value,
            Change::Remove => stored.object().contains_key(*key),
        })
        .collect();
    if changes.is_empty() {
        return Ok(None);
    }
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, project_id),
        now_ms,
        |tx| {
            let payload = tasks::edit_merged_in(
                tx,
                ITEM_TYPE,
                &PROJECT_SYNCABLE_FIELDS,
                project_id,
                changes,
                device_id,
                now_ms,
            )?;
            then(tx, payload)
        },
    )
    .map(Some)
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
