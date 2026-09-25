//! Journal reminders (spec 005-journal JP024, decision D8).
//!
//! A journal reminder targets a **date**: `targetType: 'journal'` and
//! `targetId` = `YYYY-MM-DD`, never the journal record id
//! (`hooks/use-journal-reminders.ts`). It carries no title and an optional
//! note. Creating one never creates the journal day: the reminder is its own
//! sync item and the day may never be written.
//!
//! Edit, snooze, dismiss and delete are the id-based writes in the parent
//! module; the due window in [`super::queries`] already resolves a journal
//! target to its date.

use rusqlite::Connection;
use serde_json::json;

use crate::api::errors::StorageError;
use crate::domain::journal::valid_date;
use crate::sync::outbox::{self, Durable};

use super::queries::{Reminder, for_target};
use super::{
    ITEM_TYPE, MAX_NOTE_LEN, ReminderUpdate, STATUS_PENDING, future_instant, invalid, new_id,
    non_empty, update,
};
use crate::domain::notes::{insert_local, iso, next_clock, object};

/// `targetType` of a reminder on a journal day.
pub const TARGET_JOURNAL: &str = "journal";

/// What a new journal reminder carries (desktop `CreateReminderSchema`, the
/// `journal` arm, as `useJournalReminders` fills it: no title).
#[derive(Debug, Clone, Copy)]
pub struct NewJournalReminder<'a> {
    /// `None` mints desktop's `rem_<nanoid>`.
    pub id: Option<&'a str>,
    /// The day, `YYYY-MM-DD`. Written as `targetId`.
    pub date: &'a str,
    /// An ISO instant strictly after `now_ms`.
    pub remind_at: &'a str,
    /// Empty is written as `null`, as desktop's `input.note || null` does.
    pub note: Option<&'a str>,
}

/// Creates a reminder on a journal day and returns its id.
///
/// The payload has the same shape as [`super::create_for_task`]'s: every
/// nullable column present, `title` and the highlight and anchor columns
/// explicit `null`, `remindAt` in `toISOString` form.
pub fn create_for_journal(
    conn: &Connection,
    reminder: &NewJournalReminder<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let date = valid_date(reminder.date)?;
    let remind_at = future_instant(reminder.remind_at, now_ms)?;
    let note = non_empty(reminder.note, "note", MAX_NOTE_LEN)?;
    let id = match reminder.id {
        Some("") => return Err(invalid("a reminder id cannot be empty".to_owned())),
        Some(id) => id.to_owned(),
        None => new_id(),
    };

    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &id),
        now_ms,
        |tx| {
            let at = iso(now_ms)?;
            let payload = object(json!({
                "targetType": TARGET_JOURNAL,
                "targetId": date,
                "remindAt": remind_at,
                "anchorId": null,
                "highlightText": null,
                "highlightStart": null,
                "highlightEnd": null,
                "title": null,
                "note": note,
                "status": STATUS_PENDING,
                "dismissedAt": null,
                "snoozedUntil": null,
                "clock": next_clock(&Default::default(), device_id)?,
                "createdAt": at,
                "modifiedAt": at,
            }));
            insert_local(tx, ITEM_TYPE, &id, payload, now_ms)?;
            Ok(id.clone())
        },
    )
}

/// Sets the day's reminder and returns the id written, after it committed.
///
/// Desktop's `useSetOrReplaceReminder`: when the day has an active reminder,
/// the next one (earliest `remindAt` among `pending` and `snoozed`) is moved
/// to `remind_at` and its note is written through, `null` when `note` is
/// `None`, so a replaced note does not linger. Otherwise a new reminder is
/// created.
pub fn set_or_replace_for_journal(
    conn: &Connection,
    date: &str,
    remind_at: &str,
    note: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let date = valid_date(date)?;
    let next = for_target(conn, TARGET_JOURNAL, date, true)?
        .into_iter()
        .next();
    match next {
        Some(active) => {
            let change = ReminderUpdate {
                remind_at: Some(remind_at),
                title: None,
                note: Some(note),
            };
            update(conn, &active.id, &change, device_id, now_ms)?.acknowledge();
            Ok(active.id)
        }
        None => {
            let reminder = NewJournalReminder {
                id: None,
                date,
                remind_at,
                note,
            };
            Ok(create_for_journal(conn, &reminder, device_id, now_ms)?.acknowledge())
        }
    }
}

/// A day's live reminders of every status, earliest `remindAt` first
/// (desktop `useJournalReminders().reminders`). [`Reminder::is_active`]
/// marks the `pending` and `snoozed` ones; the first active one is the one
/// [`set_or_replace_for_journal`] moves.
pub fn for_journal(conn: &Connection, date: &str) -> Result<Vec<Reminder>, StorageError> {
    for_target(conn, TARGET_JOURNAL, valid_date(date)?, false)
}
