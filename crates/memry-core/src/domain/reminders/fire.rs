//! Firing a due reminder on this device (Step 21f, #3538): desktop's
//! `processDueReminders` and `createReminderInboxItem` (`lib/reminders.ts`).
//!
//! Desktop marks a fired reminder `status = 'triggered'`, a status it never
//! sends, and its reminder handler keeps a peer's `pending` copy from un-firing
//! it (`a4e8920c55`). Here the synced row is never touched. `reminder_fires`
//! (data migration 0040, device-local) records the fire instant each reminder
//! was shown for, and a reminder is due when no row matches its current
//! instant: `snoozedUntil` when snoozed, else `remindAt`. A pulled copy with
//! the same instant cannot refire it; a new `remindAt` or a snooze moves the
//! instant and fires it again, as desktop's reschedule and snooze do. Instants
//! are compared as epoch milliseconds, so the same moment written in another
//! offset (a peer in another timezone) is the same instant.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::{Map, Value, json};

use crate::api::errors::StorageError;
use crate::domain::inbox;
use crate::domain::notes::{insert_local, iso, next_clock, object};

use super::queries::{failed, fire_instant};
use super::{DueReminder, STATUS_PENDING, STATUS_SNOOZED, due_window};

/// Desktop's `inboxItemType.REMINDER`.
const INBOX_TYPE: &str = "reminder";

/// A reminder this device just fired.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fired {
    pub reminder_id: String,
    /// The inbox item filed for it, `inbox_rem_<nanoid>`.
    pub inbox_id: String,
    pub fired_for_ms: i64,
}

/// Every live `pending` or `snoozed` reminder whose fire instant is at or
/// before `now_ms` and that this device has not fired for that instant,
/// earliest first. Overdue ones are included: a reminder that came due while
/// the app was closed fires at the next open, once.
pub fn due(conn: &Connection, now_ms: i64) -> Result<Vec<DueReminder>, StorageError> {
    let fired = fired_instants(conn)?;
    Ok(due_window(conn, Some(now_ms))?
        .into_iter()
        .filter(|due| fired.get(&due.reminder.id) != Some(&due.fire_at_ms))
        .collect())
}

/// Records `due` as fired for its instant and files its inbox item, in one
/// transaction. `None` when it was already fired for that instant, so a second
/// call (a racing tick, a restart) files nothing.
///
/// The inbox item has no outbox row, as desktop's insert queues none.
pub fn fire(
    conn: &Connection,
    due: &DueReminder,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<Fired>, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let fired_for: Option<i64> = tx
        .query_row(
            "SELECT fired_for_ms FROM reminder_fires WHERE reminder_id = ?1",
            [&due.reminder.id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    if fired_for == Some(due.fire_at_ms) {
        return Ok(None);
    }
    tx.execute(
        "INSERT INTO reminder_fires (reminder_id, fired_for_ms, fired_at_ms) VALUES (?1, ?2, ?3)
         ON CONFLICT (reminder_id) DO UPDATE
         SET fired_for_ms = excluded.fired_for_ms, fired_at_ms = excluded.fired_at_ms",
        params![due.reminder.id, due.fire_at_ms, now_ms],
    )
    .map_err(failed)?;
    let inbox_id = format!("inbox_rem_{}", inbox::write::mint_id());
    let payload = inbox_payload(&tx, due, &inbox_id, device_id, now_ms)?;
    insert_local(&tx, inbox::ITEM_TYPE, &inbox_id, payload, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(Some(Fired {
        reminder_id: due.reminder.id.clone(),
        inbox_id,
        fired_for_ms: due.fire_at_ms,
    }))
}

/// Live `pending` and `snoozed` reminders not yet fired for their current
/// instant: desktop's `countPendingReminders`, which counts those statuses
/// after a fire has moved the reminder to `triggered`. The badge shows it.
pub fn pending_count(conn: &Connection) -> Result<u32, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT r.status, r.remind_at, r.snoozed_until, f.fired_for_ms
             FROM reminders r LEFT JOIN reminder_fires f ON f.reminder_id = r.id
             WHERE r.deleted_at IS NULL AND r.status IN (?1, ?2)",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![STATUS_PENDING, STATUS_SNOOZED], |row| {
            let status: String = row.get(0)?;
            let remind_at: String = row.get(1)?;
            let snoozed_until: Option<String> = row.get(2)?;
            let fired_for: Option<i64> = row.get(3)?;
            let instant = fire_instant(&status, &remind_at, snoozed_until.as_deref());
            Ok(fired_for.is_none() || instant != fired_for)
        })
        .map_err(failed)?;
    let mut count = 0u32;
    for unfired in rows {
        if unfired.map_err(failed)? {
            count = count.saturating_add(1);
        }
    }
    Ok(count)
}

/// Forgets this device's fire record of `reminder_id`, inside the caller's
/// transaction: the reminder was deleted.
pub(super) fn forget(tx: &Connection, reminder_id: &str) -> Result<(), StorageError> {
    tx.execute(
        "DELETE FROM reminder_fires WHERE reminder_id = ?1",
        [reminder_id],
    )
    .map_err(failed)?;
    Ok(())
}

fn fired_instants(conn: &Connection) -> Result<HashMap<String, i64>, StorageError> {
    let mut statement = conn
        .prepare("SELECT reminder_id, fired_for_ms FROM reminder_fires")
        .map_err(failed)?;
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// `createReminderInboxItem`: the title, content and `ReminderMetadata` desktop
/// files, with its falsy-to-absent rules (`|| undefined` drops `""` and `0`).
fn inbox_payload(
    tx: &Connection,
    due: &DueReminder,
    inbox_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Map<String, Value>, StorageError> {
    let reminder = &due.reminder;
    let (anchor_id, highlight_start, highlight_end): (Option<String>, Option<i64>, Option<i64>) =
        tx.query_row(
            "SELECT anchor_id, highlight_start, highlight_end FROM reminders WHERE id = ?1",
            [&reminder.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(failed)?;
    let project_id: Option<String> = if reminder.target_type == super::TARGET_TASK {
        tx.query_row(
            "SELECT project_id FROM tasks WHERE id = ?1",
            [&reminder.target_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?
        .flatten()
    } else {
        None
    };

    let truthy = |value: &Option<String>| value.clone().filter(|text| !text.is_empty());
    let title = truthy(&reminder.title)
        .or_else(|| truthy(&due.target_title))
        .unwrap_or_else(|| format!("Reminder: {}", reminder.target_type));
    let content = truthy(&reminder.highlight_text).or_else(|| truthy(&reminder.note));

    let mut metadata = Map::new();
    metadata.insert("reminderId".to_owned(), json!(reminder.id));
    metadata.insert("targetType".to_owned(), json!(reminder.target_type));
    metadata.insert("targetId".to_owned(), json!(reminder.target_id));
    metadata.insert("targetTitle".to_owned(), json!(due.target_title));
    metadata.insert("remindAt".to_owned(), json!(reminder.remind_at));
    let optional = [
        ("anchorId", anchor_id.map(Value::from)),
        (
            "highlightText",
            truthy(&reminder.highlight_text).map(Value::from),
        ),
        (
            "highlightStart",
            highlight_start.filter(|n| *n != 0).map(Value::from),
        ),
        (
            "highlightEnd",
            highlight_end.filter(|n| *n != 0).map(Value::from),
        ),
        ("reminderNote", truthy(&reminder.note).map(Value::from)),
        ("projectId", truthy(&project_id).map(Value::from)),
    ];
    for (key, value) in optional {
        if let Some(value) = value {
            metadata.insert(key.to_owned(), value);
        }
    }

    let at = iso(now_ms)?;
    Ok(object(json!({
        "id": inbox_id,
        "type": INBOX_TYPE,
        "title": title,
        "content": content,
        "createdAt": at,
        "modifiedAt": at,
        "filedAt": null,
        "filedTo": null,
        "filedAction": null,
        "snoozedUntil": null,
        "snoozeReason": null,
        "viewedAt": null,
        "processingStatus": "complete",
        "processingError": null,
        "metadata": metadata,
        "attachmentPath": null,
        "thumbnailPath": null,
        "transcription": null,
        "transcriptionStatus": null,
        "sourceUrl": null,
        "sourceTitle": null,
        "captureSource": null,
        "archivedAt": null,
        "clock": next_clock(&Map::new(), device_id)?,
        "localOnly": false,
    })))
}
