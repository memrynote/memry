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

use crate::api::errors::StorageError;
use crate::domain::journal::valid_date;
use crate::sync::outbox::Durable;

use super::queries::{Reminder, for_target};
use super::{NewReminder, NewTarget, ReminderUpdate, create_reminder, update};

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

/// Creates a reminder on a journal day and returns its id
/// ([`super::create_reminder`]).
pub fn create_for_journal(
    conn: &Connection,
    reminder: &NewJournalReminder<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let reminder = NewReminder {
        id: reminder.id,
        target: NewTarget::Journal(reminder.date),
        remind_at: reminder.remind_at,
        title: None,
        note: reminder.note,
    };
    create_reminder(conn, &reminder, device_id, now_ms)
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
