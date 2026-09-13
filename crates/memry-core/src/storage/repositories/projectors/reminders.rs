//! `reminder` (chapter 13 §13.7.12, data-model §A.4).
//!
//! `triggeredAt` is deliberately absent from the payload and from the row: each
//! device shows its own notification, so a synced value would suppress it on a
//! device that never displayed it. Scheduling bookkeeping lives in
//! `local_notifications`, which is device-local and never synced. **Dismiss and
//! snooze state does sync** and lives here.
//!
//! `remind_at`, `dismissed_at` and `snoozed_until` stay TEXT: they are
//! wall-clock values on the wire and converting them would invent a timezone
//! (§A.6).

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{ItemContext, clock_text, failed, instant, number, text, text_or_default};

const REMINDER_FIELDS: &[Field] = &[
    Field::opt("targetType", Kind::Text),
    Field::opt("targetId", Kind::Text),
    Field::opt("remindAt", Kind::Text),
    Field::opt_null("anchorId", Kind::Text),
    Field::opt_null("highlightText", Kind::Text),
    Field::opt_null("highlightStart", Kind::Number),
    Field::opt_null("highlightEnd", Kind::Number),
    Field::opt_null("title", Kind::Text),
    Field::opt_null("note", Kind::Text),
    Field::opt("status", Kind::Text),
    Field::opt_null("dismissedAt", Kind::Text),
    Field::opt_null("snoozedUntil", Kind::Text),
    Field::opt("clock", Kind::Clock),
    Field::opt("createdAt", Kind::Text),
    Field::opt("modifiedAt", Kind::Text),
];

pub fn read_reminder(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("reminder", parsed, REMINDER_FIELDS)
}

pub fn project_reminder(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO reminders (
             id, target_type, target_id, remind_at, anchor_id, highlight_text,
             highlight_start, highlight_end, title, note, status, dismissed_at,
             snoozed_until, created_at, modified_at, clock, synced_at, deleted_at
         ) VALUES (
             ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
             ?16, ?17, ?18
         )
         ON CONFLICT(id) DO UPDATE SET
             target_type = excluded.target_type,
             target_id = excluded.target_id,
             remind_at = excluded.remind_at,
             anchor_id = excluded.anchor_id,
             highlight_text = excluded.highlight_text,
             highlight_start = excluded.highlight_start,
             highlight_end = excluded.highlight_end,
             title = excluded.title,
             note = excluded.note,
             status = excluded.status,
             dismissed_at = excluded.dismissed_at,
             snoozed_until = excluded.snoozed_until,
             created_at = excluded.created_at,
             modified_at = excluded.modified_at,
             clock = excluded.clock,
             synced_at = excluded.synced_at,
             deleted_at = excluded.deleted_at",
        params![
            item.item_id,
            text_or_default(view, "targetType", ""),
            text_or_default(view, "targetId", ""),
            text_or_default(view, "remindAt", ""),
            text(view, "anchorId"),
            text(view, "highlightText"),
            number(view, "highlightStart"),
            number(view, "highlightEnd"),
            text(view, "title"),
            text(view, "note"),
            text_or_default(view, "status", "pending"),
            text(view, "dismissedAt"),
            text(view, "snoozedUntil"),
            instant(view, "createdAt"),
            instant(view, "modifiedAt"),
            clock_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}
