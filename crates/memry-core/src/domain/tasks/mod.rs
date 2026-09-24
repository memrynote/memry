//! Tasks: create, edit, assign, complete, and the inbound **field-level
//! merge** (T129, FR-057, FR-059, FR-060, chapter 06 §6.3, chapter 13 §13.7.3,
//! data-model §A.4).
//!
//! `task` is one of the two types that merge field by field (§6.8), and this
//! module is the write side of that. The merge rule itself is
//! [`crate::sync::field_merge`] and is **not** restated here: it is pinned byte
//! for byte by the `field-merge` vector class, and a second copy of the rule is
//! a second thing to get wrong. What lives here is everything around it.
//!
//! Three rules shape the local write path, and the third is the one unique to
//! a field-merged type.
//!
//! - **One transaction.** A merged payload without its outbox row is a local
//!   edit no peer ever sees (FR-030, data-model §A.2), so the payload merge and
//!   [`crate::sync::outbox::enqueue`] commit together through
//!   [`crate::sync::outbox::commit`].
//! - **One set of payload bytes.** A create serialises the object it built and
//!   stores *that*; an edit merges into the parsed copy and stores *that*
//!   (§13.2 rule 3). No projection row is ever an input (rule 4), and there is
//!   no `#[derive(Deserialize)]` payload struct here (#2183).
//! - **A local edit ticks the document clock *and* every changed field's
//!   clock.** §6.6 spells that pair out for the offline case and the online
//!   case differs only in which device id is ticked. An edit that ticked only
//!   the document clock would leave `clockTotal` unchanged on the field it
//!   actually changed, and §6.3's winner is chosen by that sum — so the edit
//!   would lose a tie to a peer that never touched the field.
//!
//! ## The inbound path, and what it deliberately does not do
//!
//! [`apply_remote`] is §6.3.1's document gate followed by §6.3's per-field
//! rule, and it lives in [`task_merge`] because `project` runs the identical
//! path. It **never enqueues**: §6.5.2's P3 says the merging device stores the
//! union clock and does not re-push, and a re-push there reintroduces the
//! §6.5.1 case-3c divergence.
//!
//! It also does not write `task_activity`. Desktop mints a `superseded` row per
//! conflict; nothing in chapter 06 makes that an obligation on this core, and
//! those rows sync to every device, so the conflicts are **returned** to the
//! caller and written nowhere.
//!
//! `_offline` never reaches a payload written here:
//! `notes::next_clock` and `task_merge::next_field_clocks` both
//! refuse the reserved device id, which is §6.6 made structural rather than
//! remembered.
//!
//! ## The desktop-parity write surface (spec 004 TP020)
//!
//! Desktop is the reference for what each user action writes. The submodules
//! hold it, each named for the part of the surface it owns:
//!
//! - [`create`]: create with every field, and duplicate.
//! - [`lifecycle`]: complete (including a repeating task's next occurrence,
//!   D3), uncomplete.
//! - [`structure`]: project, status and parent changes, reorder, delete with
//!   subtasks.
//! - [`fields`]: the remaining single-field setters.
//! - [`bulk`]: the subtask and multi-select bulk actions.
//! - [`batch`]: the one-transaction writer behind every multi-task write, and
//!   [`undo`].
//! - [`model`]: status types, status pickers, positions and id minting.

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::storage::repositories::Change;
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::sync::field_merge::TASK_SYNCABLE_FIELDS;
use crate::sync::outbox::{self, Durable};

use super::notes::{iso, next_clock, require_payload};
use super::task_merge;

pub mod batch;
pub mod bulk;
pub mod create;
pub mod fields;
pub mod lifecycle;
pub mod model;
pub mod structure;

pub use batch::{Prior, Removed, TaskWrite, undo, write_fields};
pub use bulk::*;
pub use create::{TaskDetails, create_detailed, duplicate};
pub use fields::*;
pub use lifecycle::{Completion, NextOccurrence, complete, uncomplete};
pub use model::{StatusKind, TASK_ID_LEN, new_task_id, status_kind};
pub use structure::{
    SubtaskDisposal, delete_with_subtasks, reorder, set_parent, set_project, set_status,
};

/// The `(type, _)` half of every key this module writes.
pub const ITEM_TYPE: &str = "task";

/// The ceiling on an item id. §13.6: an id is not always a UUID, so the only
/// claim made here is that it is a non-empty string a `(type, id)` key can
/// hold.
pub const MAX_ITEM_ID_LEN: usize = 128;

/// What a new task carries.
///
/// The five fields FR-057's acceptance scenario names — title, due date,
/// priority, project and recurrence — plus tags. `repeat_config` is opaque:
/// §13.7.3 declares `repeatConfig` `z.unknown()`, and it is the only
/// object-valued field in any merged list (§6.4.1), which is why §6.4.2
/// mandates a canonical comparison for it.
#[derive(Debug, Clone, Copy)]
pub struct NewTask<'a> {
    pub id: &'a str,
    pub title: &'a str,
    /// The project the task is filed under. FR-060's assign half at create
    /// time; [`assign`] is the same write afterwards.
    pub project_id: &'a str,
    pub due_date: Option<&'a str>,
    pub due_time: Option<&'a str>,
    pub priority: i64,
    pub repeat_config: Option<&'a Value>,
    pub tags: &'a [String],
}

/// What [`apply_remote`] did with an inbound record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inbound {
    /// §6.3.1: no local clock, or the remote is `before`/`equal`. Applied
    /// wholesale, with the remote's field clocks stored verbatim.
    Applied,
    /// §6.3.1: the local clock dominates (`after`). The remote is skipped
    /// entirely and the caller still advances its cursor.
    Skipped,
    /// §6.3.1: concurrent. Merged field by field, the union clock stored, and
    /// **not re-pushed** (§6.5.2 P3).
    ///
    /// `conflicted_fields` is in field-list order (§6.5.3) and is empty
    /// whenever no field met §6.3 step 6 — a concurrent pair with unequal
    /// totals is resolved by the larger total and is deliberately **not** a
    /// conflict (§6.5.4).
    Merged { conflicted_fields: Vec<String> },
    /// §13.2 rule 5: stored, flagged, never silently skipped.
    Corrupt { reason: String },
}

/// Creates a task, its payload and its outbox row.
///
/// [`create_detailed`] with no details: the task starts in its project's
/// default status at the next free position.
pub fn create(
    conn: &Connection,
    task: &NewTask<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    create_detailed(conn, task, &TaskDetails::default(), device_id, now_ms)
}

/// Retitles a task.
pub fn set_title(
    conn: &Connection,
    task_id: &str,
    title: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    edit(
        conn,
        task_id,
        vec![("title", Change::set(title))],
        device_id,
        now_ms,
    )
}

/// Sets or clears the due date and time.
///
/// `None` is an **explicit `null`**, not an absent key: absent means "the
/// sender does not know this field" and every peer keeps its own value
/// (§13.4), so a cleared due date that dropped the key would still be due on
/// every other device.
pub fn set_due(
    conn: &Connection,
    task_id: &str,
    due_date: Option<&str>,
    due_time: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    edit(
        conn,
        task_id,
        vec![
            ("dueDate", Change::Set(nullable(due_date))),
            ("dueTime", Change::Set(nullable(due_time))),
        ],
        device_id,
        now_ms,
    )
}

/// Sets the priority.
pub fn set_priority(
    conn: &Connection,
    task_id: &str,
    priority: i64,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    edit(
        conn,
        task_id,
        vec![("priority", Change::set(priority))],
        device_id,
        now_ms,
    )
}

/// Files the task under a project (FR-060's assign half).
///
/// The project must already exist locally. Writing an id no project row
/// carries would push a dangling `projectId` to every device, and the picker
/// this call sits behind reads the same [`super::projects::list`].
pub fn assign(
    conn: &Connection,
    task_id: &str,
    project_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    if super::projects::get(conn, project_id)?.is_none() {
        return Err(StorageError::NotFound {
            what: format!("no project {project_id} to assign to"),
        });
    }
    edit(
        conn,
        task_id,
        vec![("projectId", Change::set(project_id))],
        device_id,
        now_ms,
    )
}

/// Completes the task, or reopens it with `None`.
///
/// `completedAt` is a wall-clock value on the wire and stays TEXT in the
/// projection (§A.6); reopening writes the explicit `null` of §13.4.
pub fn set_completed(
    conn: &Connection,
    task_id: &str,
    completed: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let at = completed.then(|| iso(now_ms)).transpose()?;
    edit(
        conn,
        task_id,
        vec![("completedAt", Change::Set(nullable(at.as_deref())))],
        device_id,
        now_ms,
    )
}

/// Archives the task, or unarchives it with `false`.
pub fn set_archived(
    conn: &Connection,
    task_id: &str,
    archived: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let at = archived.then(|| iso(now_ms)).transpose()?;
    edit(
        conn,
        task_id,
        vec![("archivedAt", Change::Set(nullable(at.as_deref())))],
        device_id,
        now_ms,
    )
}

/// Replaces the task's tags, deduped case-insensitively.
///
/// **`tags` is not in `TASK_SYNCABLE_FIELDS`** (§6.7), so no field clock ticks
/// for it and it is not merged at all: on a concurrent apply the local list
/// survives, and on the wholesale-apply branch the remote's does. That is the
/// rule as written, and it is why [`super::tags`] excludes `task` from
/// `TAGGABLE_TYPES` rather than treating it like a note.
pub fn set_tags(
    conn: &Connection,
    task_id: &str,
    tags: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    edit(
        conn,
        task_id,
        vec![("tags", Change::set(super::tags::dedupe(tags.to_vec())))],
        device_id,
        now_ms,
    )
}

/// Tombstones the task.
pub fn delete(
    conn: &Connection,
    task_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<()>, StorageError> {
    outbox::commit(
        conn,
        &outbox::Change::delete(ITEM_TYPE, task_id),
        now_ms,
        |tx| super::notes::tombstone_local(tx, ITEM_TYPE, task_id, device_id, now_ms),
    )
}

/// One local edit to one task: stamp it, tick its field clocks, merge it,
/// queue it, commit once.
pub fn edit(
    conn: &Connection,
    task_id: &str,
    changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    edit_merged(
        conn,
        ITEM_TYPE,
        &TASK_SYNCABLE_FIELDS,
        task_id,
        changes,
        device_id,
        now_ms,
    )
}

/// Applies an inbound `task` record through §6.3.1 and §6.3.
pub fn apply_remote(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    task_merge::apply_remote_merged(conn, record, &TASK_SYNCABLE_FIELDS, now_ms)
}

/// [`edit`] for either field-merged type (§6.8). `project` reaches it through
/// nothing today — FR-060 gives the phone no project write — and it is written
/// once so that the two types cannot drift apart if one ever does.
pub(crate) fn edit_merged(
    conn: &Connection,
    item_type: &str,
    fields: &[&str],
    item_id: &str,
    changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    outbox::commit(
        conn,
        &outbox::Change::upsert(item_type, item_id),
        now_ms,
        |tx| edit_merged_in(tx, item_type, fields, item_id, changes, device_id, now_ms),
    )
}

/// [`edit_merged`] inside a transaction the caller holds, without the outbox
/// row: the caller queues it in the same transaction.
pub(crate) fn edit_merged_in(
    tx: &Connection,
    item_type: &str,
    fields: &[&str],
    item_id: &str,
    mut changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let stored = require_payload(tx, item_type, item_id)?;
    // Pushed before the field clocks are computed, because `modifiedAt` **is**
    // one of `PROJECT_SYNCABLE_FIELDS` (§6.7) even though it is none of
    // `TASK_SYNCABLE_FIELDS`, and its clock must tick on the type that merges
    // it.
    changes.push(("modifiedAt", Change::set(iso(now_ms)?)));
    let touched: Vec<&str> = changes.iter().map(|(key, _)| *key).collect();
    let clock = next_clock(stored.object(), device_id)?;
    let field_clocks = task_merge::next_field_clocks(stored.object(), fields, &touched, device_id)?;
    changes.push(("clock", Change::Set(clock)));
    changes.push(("fieldClocks", Change::Set(field_clocks)));
    sync_items::apply_local_edit_in(tx, item_type, item_id, &changes, now_ms)
}

/// `Some` is the value, `None` is §13.4's explicit clear.
pub(crate) fn nullable(value: Option<&str>) -> Value {
    value.map_or(Value::Null, |value| Value::String(value.to_owned()))
}

/// §13.6: an item id is not always a UUID, so the only claim is that it is a
/// non-empty string short enough to key a row by.
pub(crate) fn valid_item_id(id: &str) -> Result<&str, StorageError> {
    if id.is_empty() || id.len() > MAX_ITEM_ID_LEN {
        return Err(StorageError::Invalid {
            what: format!("`{id}` is not an item id: non-empty, at most {MAX_ITEM_ID_LEN} bytes"),
        });
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_cleared_value_is_an_explicit_null_and_never_an_absent_key() {
        assert_eq!(nullable(None), Value::Null);
        assert_eq!(nullable(Some("2026-04-20")), json!("2026-04-20"));
    }

    #[test]
    fn an_item_id_is_only_required_to_be_a_usable_key() {
        assert!(valid_item_id("7f1c3e2a-0000-4000-8000-000000000001").is_ok());
        assert!(valid_item_id("").is_err());
        assert!(valid_item_id(&"a".repeat(MAX_ITEM_ID_LEN + 1)).is_err());
    }
}
