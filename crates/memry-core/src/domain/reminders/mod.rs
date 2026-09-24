//! Reminders (N804, chapter 13 §13.7.12; spec 004 TP024).
//!
//! One sync type, `reminder`, carries every target: a note, a journal day, a
//! highlight, a note date, or a task (`ReminderSyncPayloadSchema`,
//! `packages/contracts/src/sync-payloads.ts`). The writes are id-based and
//! target-agnostic — [`dismiss`], [`snooze`], [`update`], [`delete`] — as
//! desktop's `lib/reminders.ts` is; only creation names its target
//! ([`create`] for a note, [`create_for_task`] for a task). The reads live in
//! [`queries`].
//!
//! **`triggeredAt` is deliberately not written here**, and the chapter says
//! why: each device shows its own notification, so a synced "already fired"
//! would suppress it on a device that never displayed it. Dismiss and snooze
//! state *does* sync, and both are written.
//!
//! The status values are carried verbatim rather than mapped to an enum,
//! because §13.7.12 marks `status` a string and never enumerates it. A core
//! that closed the set would refuse a value desktop writes. The constants
//! below are the four values desktop's `ReminderStatusSchema` names.

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::crypto::sodium::random_bytes;
use crate::storage::repositories::{Change, instants, sync_items};
use crate::sync::outbox::{self, Durable};

use super::notes::{insert_local, iso, next_clock, object, stamp, tombstone_local};

mod queries;

pub use queries::*;

pub const ITEM_TYPE: &str = "reminder";

/// `targetType` of a reminder on a task.
pub const TARGET_TASK: &str = "task";

pub const STATUS_PENDING: &str = "pending";
/// Device-local on desktop: its scheduler writes it and its outbound payload
/// normalises it back to `pending`, so it should never arrive here. Named so a
/// read can recognise one from an older build.
pub const STATUS_TRIGGERED: &str = "triggered";
pub const STATUS_DISMISSED: &str = "dismissed";
pub const STATUS_SNOOZED: &str = "snoozed";

/// Desktop mints `rem_${nanoid()}` (`createReminder`).
const ID_PREFIX: &str = "rem_";
/// `nanoid()`'s default length.
const NANOID_LEN: usize = 21;
/// `nanoid`'s URL-safe alphabet: 64 symbols, so `byte & 63` is unbiased.
const NANOID_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/// `CreateReminderSchema` / `UpdateReminderSchema` caps, in UTF-16 code units
/// because that is what zod's `.max()` counts.
const MAX_TITLE_LEN: usize = 200;
const MAX_NOTE_LEN: usize = 1_000;

/// Creates a reminder against a note.
///
/// `remind_at` is the ISO instant the payload carries. An **instant**, unlike
/// a `dateMention`'s calendar day: a reminder fires at a moment, and the
/// moment is the same everywhere.
pub fn create(
    conn: &Connection,
    id: &str,
    note_id: &str,
    remind_at: &str,
    title: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    outbox::commit(conn, &outbox::Change::upsert(ITEM_TYPE, id), now_ms, |tx| {
        let at = iso(now_ms)?;
        let payload = object(json!({
            "targetType": "note",
            "targetId": note_id,
            "remindAt": remind_at,
            "title": title,
            "status": STATUS_PENDING,
            "clock": next_clock(&Default::default(), device_id)?,
            "createdAt": at,
            "modifiedAt": at,
        }));
        insert_local(tx, ITEM_TYPE, id, payload, now_ms)
    })
}

/// What a new task reminder carries (desktop `CreateReminderSchema`, the
/// `task` arm).
#[derive(Debug, Clone, Copy)]
pub struct NewTaskReminder<'a> {
    /// `None` mints desktop's `rem_<nanoid>`.
    pub id: Option<&'a str>,
    pub task_id: &'a str,
    /// An ISO instant strictly after `now_ms`.
    pub remind_at: &'a str,
    /// Empty is written as `null`, as desktop's `input.title || null` does.
    pub title: Option<&'a str>,
    /// Empty is written as `null`, as desktop's `input.note || null` does.
    pub note: Option<&'a str>,
}

/// Creates a reminder against a task and returns its id.
///
/// The payload is the whole row desktop pushes (`toOutboundReminderPayload`):
/// every nullable column present, the highlight and anchor ones as explicit
/// `null`. `remindAt` is rewritten in `toISOString` form so that text order
/// is instant order, which desktop's `ORDER BY remind_at` relies on.
pub fn create_for_task(
    conn: &Connection,
    reminder: &NewTaskReminder<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    if reminder.task_id.is_empty() {
        return Err(invalid("a task reminder needs a task id".to_owned()));
    }
    let remind_at = future_instant(reminder.remind_at, now_ms)?;
    let title = non_empty(reminder.title, "title", MAX_TITLE_LEN)?;
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
                "targetType": TARGET_TASK,
                "targetId": reminder.task_id,
                "remindAt": remind_at,
                "anchorId": null,
                "highlightText": null,
                "highlightStart": null,
                "highlightEnd": null,
                "title": title,
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

/// An edit to a reminder (desktop `UpdateReminderSchema`).
///
/// Every field is `None` to leave the stored value alone. `title` and `note`
/// take `Some(None)` as §13.4's explicit clear.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReminderUpdate<'a> {
    /// A new ISO instant strictly after `now_ms`. Rescheduling makes the
    /// reminder `pending` again and clears `snoozedUntil`, as desktop's
    /// `updateReminder` does.
    pub remind_at: Option<&'a str>,
    pub title: Option<Option<&'a str>>,
    pub note: Option<Option<&'a str>>,
}

/// Edits a reminder's time, title or note and returns the merged payload.
pub fn update(
    conn: &Connection,
    id: &str,
    update: &ReminderUpdate<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    let mut changes = Vec::new();
    if let Some(remind_at) = update.remind_at {
        changes.push(("remindAt", Change::set(future_instant(remind_at, now_ms)?)));
        changes.push(("status", Change::set(STATUS_PENDING)));
        changes.push(("snoozedUntil", Change::Set(Value::Null)));
    }
    if let Some(title) = update.title {
        changes.push(("title", Change::Set(capped(title, "title", MAX_TITLE_LEN)?)));
    }
    if let Some(note) = update.note {
        changes.push(("note", Change::Set(capped(note, "note", MAX_NOTE_LEN)?)));
    }
    edit(conn, id, changes, device_id, now_ms)
}

/// Deletes a reminder: a tombstone with its `delete` outbox row, which is
/// what desktop's `deleteReminder` sends.
pub fn delete(
    conn: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<()>, StorageError> {
    outbox::commit(conn, &outbox::Change::delete(ITEM_TYPE, id), now_ms, |tx| {
        require_live(tx, id)?;
        tombstone_local(tx, ITEM_TYPE, id, device_id, now_ms)
    })
}

/// Dismisses a reminder.
///
/// A status change and a `dismissedAt`, never a delete: a dismissal has to
/// reach the other devices, and a row that vanished has nothing left to send.
pub fn dismiss(
    conn: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    edit(
        conn,
        id,
        vec![
            ("status", Change::set(STATUS_DISMISSED)),
            ("dismissedAt", Change::set(iso(now_ms)?.as_str())),
        ],
        device_id,
        now_ms,
    )
}

/// Snoozes a reminder until `until`.
pub fn snooze(
    conn: &Connection,
    id: &str,
    until: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    edit(
        conn,
        id,
        vec![
            ("status", Change::set(STATUS_SNOOZED)),
            ("snoozedUntil", Change::set(until)),
        ],
        device_id,
        now_ms,
    )
}

/// Stamp, merge and queue one edit. A tombstoned reminder is refused: an edit
/// would resurrect nothing and push an upsert for a row every peer deleted.
fn edit(
    conn: &Connection,
    id: &str,
    changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    outbox::commit(conn, &outbox::Change::upsert(ITEM_TYPE, id), now_ms, |tx| {
        require_live(tx, id)?;
        let mut merged = stamp(tx, ITEM_TYPE, id, device_id, now_ms)?;
        merged.extend(changes);
        sync_items::apply_local_edit_in(tx, ITEM_TYPE, id, &merged, now_ms)
    })
}

fn require_live(tx: &Connection, id: &str) -> Result<(), StorageError> {
    match sync_items::load(tx, ITEM_TYPE, id)? {
        Some(row) if row.deleted_at.is_none() => Ok(()),
        Some(_) => Err(invalid(format!("reminder {id} is deleted"))),
        None => Err(invalid(format!("no reminder {id}"))),
    }
}

/// Parses `text` as an instant after `now_ms` and returns it in `toISOString`
/// form. Desktop refuses a reminder time that is not in the future
/// (`system:error.reminderTimeMustBeFuture`).
fn future_instant(text: &str, now_ms: i64) -> Result<String, StorageError> {
    let Some(at_ms) = instants::to_epoch_ms(text) else {
        return Err(invalid(format!("`{text}` is not an ISO instant")));
    };
    if at_ms <= now_ms {
        return Err(invalid(format!(
            "reminder time must be in the future: `{text}`"
        )));
    }
    iso(at_ms)
}

/// `Some("")` and `None` both write `null`, as desktop's `value || null`.
fn non_empty(value: Option<&str>, what: &str, max: usize) -> Result<Value, StorageError> {
    capped(value.filter(|value| !value.is_empty()), what, max)
}

fn capped(value: Option<&str>, what: &str, max: usize) -> Result<Value, StorageError> {
    match value {
        None => Ok(Value::Null),
        Some(value) if value.encode_utf16().count() > max => Err(invalid(format!(
            "a reminder {what} is at most {max} characters"
        ))),
        Some(value) => Ok(Value::String(value.to_owned())),
    }
}

/// `rem_` + 21 symbols of nanoid's alphabet, from libsodium's CSPRNG.
fn new_id() -> String {
    let mut id = String::with_capacity(ID_PREFIX.len() + NANOID_LEN);
    id.push_str(ID_PREFIX);
    id.extend(
        random_bytes(NANOID_LEN)
            .into_iter()
            .map(|byte| char::from(NANOID_ALPHABET[usize::from(byte & 63)])),
    );
    id
}

fn invalid(what: String) -> StorageError {
    StorageError::Failed { what }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minted_id_is_desktops_rem_prefixed_nanoid() {
        let id = new_id();
        let tail = id.strip_prefix(ID_PREFIX).unwrap_or_default();
        assert_eq!(tail.len(), NANOID_LEN);
        assert!(
            tail.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        );
        assert_ne!(new_id(), id);
    }

    #[test]
    fn an_empty_title_is_null_on_create_and_the_cap_counts_utf16_units() {
        assert_eq!(non_empty(Some(""), "title", 3).ok(), Some(Value::Null));
        assert_eq!(non_empty(None, "title", 3).ok(), Some(Value::Null));
        assert_eq!(non_empty(Some("abc"), "title", 3).ok(), Some(json!("abc")));
        // One astral-plane character is two UTF-16 units.
        assert!(capped(Some("ab\u{1F600}"), "title", 3).is_err());
    }

    #[test]
    fn a_reminder_time_is_normalised_and_must_be_in_the_future() {
        let now = instants::to_epoch_ms("2026-09-24T00:00:00Z").unwrap_or_default();
        assert_eq!(
            future_instant("2026-09-24T03:00:00+02:00", now).ok(),
            Some("2026-09-24T01:00:00.000Z".to_owned())
        );
        assert!(future_instant("2026-09-24T00:00:00.000Z", now).is_err());
        assert!(future_instant("tomorrow", now).is_err());
    }
}
