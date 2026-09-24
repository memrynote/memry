//! One projector per subscribed type (data-model §A.4, chapter 13 §13.7).
//!
//! Each projector is two halves, and the split is the whole design:
//!
//! - a **reader** ([`read`]) that copies the modelled keys out of a parsed copy
//!   of the payload, and
//! - a **writer** ([`project`]) that caches that read into the typed tables of
//!   migration `0002`.
//!
//! Neither half is ever the source of a push. §13.2 rule 4 — never re-serialise
//! a projection row as the payload — is structural here rather than a rule to
//! remember: a projector takes `&Object` and returns nothing a serialiser could
//! consume, and the push path in [`super::sync_items`] reads the verbatim
//! column.
//!
//! A projection column is a **cache of a parse** (§A.1). Dropping every table
//! `0002` creates and replaying every `sync_items` row through [`project`]
//! rebuilds all of it, which is what [`super::sync_items::rebuild_projections`]
//! does.
//!
//! ## `Field::opt` versus `Field::opt_null`, and the 146 rows it cost
//!
//! **Every optional field on every table below is `opt_null`, with one named
//! exception.** A `null` in a modelled field substitutes — `text_or_default`
//! falls back to the column default, `number_or_default` and `flag` likewise,
//! `json`, `instant` and `strings` to NULL or empty — so the item projects
//! and the verbatim payload keeps the sender's `null` either way. **Refusing
//! it instead is a projector overriding §13.3's forward tolerance and §A.4's
//! substitute-never-refuse rule with a guess about what producers write.**
//!
//! That guess has already been wrong once, on real data. `tag_definition.icon`
//! was declared optional-but-not-nullable; a producer wrote `icon: null`; the
//! first real pull against a live account recorded **146 rows corrupt**
//! (spec-defect 53). Fifty-two committed payload cases and eleven green vector
//! classes all missed it, because no committed vector carries an explicit
//! `null` in a field that is not already nullable — the bug is invisible until
//! a real producer writes one.
//!
//! The exception is `journal`'s `date`, and its reason is
//! written beside it: substituting there projects no row rather than a
//! defaulted one, so the entry would disappear with nothing recorded.
//! `folder_config.icon` stays `req_null` (§13.7.10) and the fields chapter 13
//! marks **required** — `tag_definition.name` and `color`,
//! `tag_category.name` and `sortOrder`, `property_definition.name` and `type`,
//! `settings.settings` and `fieldClocks` — stay required: presence is a
//! different axis from null tolerance, and widening one of those is a protocol
//! question rather than a projector's call.
//!
//! `custom_icon` is the one subscribed type with a reader and no table. §A.4
//! lists no projection for it and `0002` creates none: the icon bytes ride in
//! the payload (§13.7.11) and the device's icon directory is re-derived from
//! `sync_items.payload`, which is what keeps it self-healing. Its reader still
//! runs, so a malformed icon payload is recorded corrupt like any other.

pub mod filters;
pub mod notes;
pub mod projects;
pub mod reminders;
pub mod settings;
pub mod tasks;
pub mod taxonomy;
pub mod templates;

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::api::errors::StorageError;

use super::instants;
use super::payload;
use super::schema::{Object, ProjectionError};

/// The sync-item columns every projection row mirrors (§A.4).
#[derive(Debug, Clone, Copy)]
pub struct ItemContext<'a> {
    /// The `(type, id)` key's id half. Never a UUID for every type: a
    /// `tag_definition` id is a tag name and a `folder_config` id is a folder
    /// path (§13.6).
    pub item_id: &'a str,
    /// When this row was last applied, epoch milliseconds.
    pub synced_at: i64,
    /// The tombstone instant, or `None` for a live row.
    pub deleted_at: Option<i64>,
}

/// Reads a payload copy through the type's field table.
///
/// An unknown type is [`ProjectionError::UnknownType`] rather than a silent
/// skip: chapter 05 §5.3.1 requires an undeclared type to be recorded corrupt.
pub fn read(item_type: &str, parsed: &Object) -> Result<Object, ProjectionError> {
    match item_type {
        "note" => notes::read_note(parsed),
        "journal" => notes::read_journal(parsed),
        "folder_config" => taxonomy::read_folder_config(parsed),
        "custom_icon" => taxonomy::read_custom_icon(parsed),
        "tag_definition" => taxonomy::read_tag_definition(parsed),
        "tag_category" => taxonomy::read_tag_category(parsed),
        "property_definition" => taxonomy::read_property_definition(parsed),
        "template" => templates::read_template(parsed),
        "task" => tasks::read_task(parsed),
        "project" => projects::read_project(parsed),
        "task_activity" => tasks::read_task_activity(parsed),
        "reminder" => reminders::read_reminder(parsed),
        "settings" => settings::read_settings(parsed),
        "filter" => filters::read_filter(parsed),
        other => Err(ProjectionError::UnknownType {
            item_type: other.to_owned(),
        }),
    }
}

/// Caches a read view into the typed tables.
pub fn project(
    conn: &Connection,
    item_type: &str,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    match item_type {
        "note" => notes::project_note(conn, item, view),
        "journal" => notes::project_journal(conn, item, view),
        "folder_config" => taxonomy::project_folder_config(conn, item, view),
        // No table by design; see the module comment.
        "custom_icon" => Ok(()),
        "tag_definition" => taxonomy::project_tag_definition(conn, item, view),
        "tag_category" => taxonomy::project_tag_category(conn, item, view),
        "property_definition" => taxonomy::project_property_definition(conn, item, view),
        "template" => templates::project_template(conn, item, view),
        "task" => tasks::project_task(conn, item, view),
        "project" => projects::project_project(conn, item, view),
        "task_activity" => tasks::project_task_activity(conn, item, view),
        "reminder" => reminders::project_reminder(conn, item, view),
        "settings" => settings::project_settings(conn, item, view),
        "filter" => filters::project_filter(conn, item, view),
        // Unreachable: `read` refused the type before the caller got here.
        other => Err(StorageError::Failed {
            what: format!("no projector for item type `{other}`"),
        }),
    }
}

/// Marks one item's projection rows deleted, **without reading a payload**.
///
/// [`project`]'s sibling on the delete path, dispatching over the same table of
/// types for the same reason it does. What it may *not* do is read a payload: a
/// tombstone never reaches a parser (§13.7.2, §6.9.2), so there is no [`Object`]
/// to project, and for a delete of an item this device never pulled there is no
/// payload at all (§5.12). All that leaves is the `deleted_at` column §A.4 gives
/// every projection table, written straight in.
///
/// **Total over `item_type`, deliberately.** Unlike [`project`] — which refuses
/// an unknown type because [`read`] already accepted one — an unknown or
/// unsubscribed type here has no projection table, so there is nothing to mark;
/// the record tier still carries the tombstone either way. Erroring would abort
/// the page over a type this build simply does not model, which is the one
/// outcome §5.12 rules out for a delete.
///
/// Two types have no row to mark, for two different reasons. `custom_icon` has
/// no table by design (see the module comment). `settings_field_clocks` has no
/// `deleted_at` column: it is §A.4's one side table, keyed by dotted path, and
/// the instant belongs to the single `settings` item rather than to a path
/// inside it — so a `settings` delete marks every row of `settings` and leaves
/// the per-path clocks alone.
pub fn delete(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    deleted_at: i64,
) -> Result<(), StorageError> {
    for (table, key) in delete_targets(item_type) {
        match key {
            Some(column) => conn.execute(
                &format!("UPDATE {table} SET deleted_at = ?2 WHERE {column} = ?1"),
                params![item_id, deleted_at],
            ),
            // The one item whose projection is many rows under a fixed id.
            None => conn.execute(
                &format!("UPDATE {table} SET deleted_at = ?1"),
                params![deleted_at],
            ),
        }
        .map_err(failed)?;
    }
    Ok(())
}

/// The tables one item type's delete touches, and the column each is keyed by.
///
/// `None` means every row of the table belongs to the item. The child tables
/// are keyed by their owner — `note_tags` by `note_id`, `project_statuses` and
/// `project_links` by `project_id` — because §A.4 gives a child the same three
/// common columns as its parent and a deleted note whose tag rows stayed live
/// is a note that is half out of the tag views.
///
/// `project_links` is keyed by `project_id` and **not** by its `(item_type,
/// item_id)` pair: those name the *linked* item, so keying on them would
/// tombstone a live project's link because the note at the far end was deleted.
fn delete_targets(item_type: &str) -> &'static [(&'static str, Option<&'static str>)] {
    match item_type {
        "note" => &[("notes", Some("id")), ("note_tags", Some("note_id"))],
        "journal" => &[
            ("journal_entries", Some("id")),
            ("note_tags", Some("note_id")),
        ],
        "folder_config" => &[("folders", Some("path"))],
        "custom_icon" => &[],
        "tag_definition" => &[("tag_definitions", Some("name"))],
        "tag_category" => &[("tag_categories", Some("id"))],
        "property_definition" => &[("property_definitions", Some("name"))],
        "template" => &[("templates", Some("id"))],
        "task" => &[("tasks", Some("id"))],
        "project" => &[
            ("projects", Some("id")),
            ("project_statuses", Some("project_id")),
            ("project_links", Some("project_id")),
        ],
        "task_activity" => &[("task_activity", Some("id"))],
        "reminder" => &[("reminders", Some("id"))],
        "settings" => &[("settings", None)],
        "filter" => &[("saved_filters", Some("id"))],
        _ => &[],
    }
}

/// Wraps a `rusqlite` failure, which is always a bug or a disk problem rather
/// than a protocol question.
pub(crate) fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// A modelled string field, or `None` for absent and for an explicit `null`.
///
/// A projection column cannot spell the difference between the two, and does
/// not need to: §13.4's distinction is resolved by the merge on the write path,
/// against the verbatim payload, before anything reaches a column.
pub(crate) fn text(view: &Object, key: &str) -> Option<String> {
    view.get(key)?.as_str().map(str::to_owned)
}

/// A `NOT NULL TEXT` column's value, falling back to the column's declared
/// default.
///
/// §13.3: almost every payload field is optional on purpose, so a missing
/// `title` is a note with no title rather than a corrupt row. The payload is
/// stored verbatim either way, so a later build that models the field rebuilds
/// the column from it.
pub(crate) fn text_or_default(view: &Object, key: &str, default: &str) -> String {
    text(view, key).unwrap_or_else(|| default.to_owned())
}

/// A modelled number field as an integer, truncating a fractional value the way
/// every consumer of these columns does.
pub(crate) fn number(view: &Object, key: &str) -> Option<i64> {
    let value = view.get(key)?;
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|float| float.trunc() as i64))
}

/// A `NOT NULL INTEGER` column's value, falling back to the column's default.
pub(crate) fn number_or_default(view: &Object, key: &str, default: i64) -> i64 {
    number(view, key).unwrap_or(default)
}

/// A boolean as SQLite's 0/1.
pub(crate) fn flag(view: &Object, key: &str) -> Option<i64> {
    view.get(key)?.as_bool().map(i64::from)
}

/// A modelled sub-object or array, stored as the JSON text §A.4 declares.
pub(crate) fn json(view: &Object, key: &str) -> Option<String> {
    match view.get(key)? {
        Value::Null => None,
        other => Some(payload::json_text(other)),
    }
}

/// An instant column (§A.6): epoch milliseconds, from either shape the payload
/// may carry.
///
/// An unparseable string leaves the column NULL. That costs a sort key and
/// nothing else, because the wire value is read from the verbatim payload and
/// never from here.
pub(crate) fn instant(view: &Object, key: &str) -> Option<i64> {
    match view.get(key)? {
        Value::String(text) => instants::to_epoch_ms(text),
        Value::Number(number) => number.as_i64(),
        _ => None,
    }
}

/// The elements of a modelled string array, in order.
pub(crate) fn strings(view: &Object, key: &str) -> Vec<String> {
    view.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// The `clock` column: the payload's clock as JSON text, or NULL.
pub(crate) fn clock_text(view: &Object) -> Option<String> {
    json(view, "clock")
}

/// The `field_clocks` column, on the two field-merged types only (§13.9).
pub(crate) fn field_clocks_text(view: &Object) -> Option<String> {
    json(view, "fieldClocks")
}
