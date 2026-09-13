//! `task` and `task_activity` (chapter 13 §13.7.3, §13.7.5, §13.12,
//! data-model §A.4).
//!
//! `task` is one of the two field-merged types, so it carries `fieldClocks`
//! (§13.9) and the projection carries a `field_clocks` column. The merge itself
//! is chapter 06's; what matters here is that the clocks survive the round trip
//! into a column and back out of the verbatim payload.
//!
//! Two fields are deliberately opaque. `repeatConfig` is
//! `z.unknown().nullable().optional()` and is the only object-valued field in
//! any field-merged list (§6.4.1), which is exactly why chapter 06 §6.4.2
//! mandates a canonical comparison: read through a typed struct it would
//! compare unequal to itself forever whenever two devices built it with
//! different key insertion orders. `oldValue` and `newValue` on
//! `task_activity` are JSON-encoded scalars, and are always `null` for
//! `description` because the body can be note-sized.
//!
//! `linkedCanvasIds` has no column, by design: §A.4 lists none, `canvas` is not
//! a subscribed type, and the ids survive in `sync_items.payload`. Desktop
//! loses them on every round trip and works around it with a presence guard
//! (§13.2.1); here the verbatim payload is the guard.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

use super::super::instants;
use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{
    ItemContext, clock_text, failed, field_clocks_text, instant, json, number_or_default, text,
    text_or_default,
};

/// §13.12: `TASK_ACTIVITY_RETENTION_DAYS`. An **age** rule, never a per-device
/// row count — with a row-count rule a device that pruned a row would keep
/// re-accepting it from a peer that had not pruned yet, and it would resurrect
/// on every pull.
pub const TASK_ACTIVITY_RETENTION_DAYS: i64 = 90;

const MS_PER_DAY: i64 = 86_400_000;

/// The 15 entries of `TASK_SYNCABLE_FIELDS` in order (§6.7), then the fields
/// outside the merge: `tags`, `linkedNoteIds`, `linkedCanvasIds`, `clock`,
/// `fieldClocks`, `createdAt`, `modifiedAt` (§13.7.3).
///
/// **Every entry is `opt_null`, and that is the same lesson
/// `tag_definition.icon` cost 146 corrupt rows to learn.** §13.3's forward
/// tolerance and data-model §A.4 both say a projector **substitutes** and
/// never refuses, so a field is `opt` only where a `null` has no substitute.
/// None of these has that problem: the four writers below all absorb
/// `Value::Null` — `text_or_default` and `number_or_default` fall back to the
/// column's declared default, `json` and `instant` write SQL NULL into a
/// nullable column. No committed vector carries a null in any of them, which
/// is exactly why only real data would have found it.
const TASK_FIELDS: &[Field] = &[
    Field::opt_null("title", Kind::Text),
    Field::opt_null("description", Kind::Text),
    Field::opt_null("projectId", Kind::Text),
    Field::opt_null("statusId", Kind::Text),
    Field::opt_null("parentId", Kind::Text),
    Field::opt_null("priority", Kind::Number),
    Field::opt_null("position", Kind::Number),
    Field::opt_null("dueDate", Kind::Text),
    Field::opt_null("dueTime", Kind::Text),
    Field::opt_null("startDate", Kind::Text),
    Field::opt_null("repeatConfig", Kind::Any),
    Field::opt_null("repeatFrom", Kind::Text),
    Field::opt_null("sourceNoteId", Kind::Text),
    Field::opt_null("completedAt", Kind::Text),
    Field::opt_null("archivedAt", Kind::Text),
    // §13.4: `undefined` keeps the local rows, an explicit `null` — like an
    // explicit `[]` — is a clear, and the column takes it.
    Field::opt_null("tags", Kind::TextArray),
    Field::opt_null("linkedNoteIds", Kind::TextArray),
    // No column at all, by design (see the module comment), so a null here
    // reaches nothing but the verbatim payload.
    Field::opt_null("linkedCanvasIds", Kind::TextArray),
    // `task_merge` already reads both as `None` when they are null (§6.7,
    // §6.10), so refusing the payload here contradicted the merge that was
    // about to consume it.
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("fieldClocks", Kind::ClockMap),
    Field::opt_null("createdAt", Kind::Text),
    Field::opt_null("modifiedAt", Kind::Text),
];

/// §13.7.5. Append-only and immutable, hence no `fieldClocks` and no
/// `modifiedAt`.
const TASK_ACTIVITY_FIELDS: &[Field] = &[
    Field::opt("taskId", Kind::Text),
    Field::opt("action", Kind::Text),
    Field::opt_null("field", Kind::Text),
    Field::opt_null("oldValue", Kind::Text),
    Field::opt_null("newValue", Kind::Text),
    Field::opt("actor", Kind::Text),
    Field::opt("deviceId", Kind::Text),
    Field::opt("clock", Kind::Clock),
    Field::opt("createdAt", Kind::Text),
];

pub fn read_task(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("task", parsed, TASK_FIELDS)
}

pub fn read_task_activity(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("task_activity", parsed, TASK_ACTIVITY_FIELDS)
}

/// §13.12: whether an inbound `task_activity` row is past the retention
/// horizon.
///
/// The comparison is **lexicographic over ISO-8601 UTC strings**, which is
/// chronological because `createdAt` and the cutoff share a shape. Every device
/// computes the same cutoff and refuses the same rows, which is why pruning
/// locally does not start a re-pull loop. A refused row is **expired, not
/// corrupt**: the cursor still advances past it.
pub fn is_beyond_retention(created_at: Option<&str>, now_ms: i64) -> bool {
    let Some(created_at) = created_at else {
        // No `createdAt` means no age, and an age rule cannot refuse what it
        // cannot date.
        return false;
    };
    let Some(cutoff) = instants::to_iso8601(now_ms - TASK_ACTIVITY_RETENTION_DAYS * MS_PER_DAY)
    else {
        return false;
    };
    created_at < cutoff.as_str()
}

pub fn project_task(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO tasks (
             id, title, description, project_id, status_id, parent_id, priority,
             position, due_date, due_time, start_date, repeat_config, repeat_from,
             source_note_id, completed_at, archived_at, tags, linked_note_ids,
             created_at, modified_at, clock, field_clocks, synced_at, deleted_at
         ) VALUES (
             ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
             ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24
         )
         ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             description = excluded.description,
             project_id = excluded.project_id,
             status_id = excluded.status_id,
             parent_id = excluded.parent_id,
             priority = excluded.priority,
             position = excluded.position,
             due_date = excluded.due_date,
             due_time = excluded.due_time,
             start_date = excluded.start_date,
             repeat_config = excluded.repeat_config,
             repeat_from = excluded.repeat_from,
             source_note_id = excluded.source_note_id,
             completed_at = excluded.completed_at,
             archived_at = excluded.archived_at,
             tags = excluded.tags,
             linked_note_ids = excluded.linked_note_ids,
             created_at = excluded.created_at,
             modified_at = excluded.modified_at,
             clock = excluded.clock,
             field_clocks = excluded.field_clocks,
             synced_at = excluded.synced_at,
             deleted_at = excluded.deleted_at",
        params![
            item.item_id,
            text_or_default(view, "title", ""),
            text(view, "description"),
            text_or_default(view, "projectId", ""),
            text(view, "statusId"),
            text(view, "parentId"),
            number_or_default(view, "priority", 0),
            number_or_default(view, "position", 0),
            // §A.6: date-only and wall-clock values stay TEXT exactly as the
            // payload carries them. Converting them would invent a timezone
            // and break "today" across a date boundary.
            text(view, "dueDate"),
            text(view, "dueTime"),
            text(view, "startDate"),
            json(view, "repeatConfig"),
            text(view, "repeatFrom"),
            text(view, "sourceNoteId"),
            text(view, "completedAt"),
            text(view, "archivedAt"),
            json(view, "tags"),
            json(view, "linkedNoteIds"),
            instant(view, "createdAt"),
            instant(view, "modifiedAt"),
            clock_text(view),
            field_clocks_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}

pub fn project_task_activity(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO task_activity (
             id, task_id, action, field, old_value, new_value, actor, device_id,
             created_at, clock, synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
             task_id = excluded.task_id,
             action = excluded.action,
             field = excluded.field,
             old_value = excluded.old_value,
             new_value = excluded.new_value,
             actor = excluded.actor,
             device_id = excluded.device_id,
             created_at = excluded.created_at,
             clock = excluded.clock,
             synced_at = excluded.synced_at,
             deleted_at = excluded.deleted_at",
        params![
            item.item_id,
            text_or_default(view, "taskId", ""),
            text_or_default(view, "action", ""),
            text(view, "field"),
            text(view, "oldValue"),
            text(view, "newValue"),
            text(view, "actor"),
            text(view, "deviceId"),
            instant(view, "createdAt"),
            clock_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_760_000_000_000;

    #[test]
    fn retention_is_an_age_rule_over_iso_strings() {
        let fresh = instants::to_iso8601(NOW - 10 * MS_PER_DAY).unwrap();
        let stale = instants::to_iso8601(NOW - 100 * MS_PER_DAY).unwrap();

        assert!(!is_beyond_retention(Some(&fresh), NOW));
        assert!(is_beyond_retention(Some(&stale), NOW));
        // Every device computes the same cutoff from the same row, which is
        // what keeps a pruned row from resurrecting on the next pull.
        assert!(is_beyond_retention(Some(&stale), NOW + MS_PER_DAY));
        assert!(!is_beyond_retention(None, NOW));
    }
}
