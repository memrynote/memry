//! Firing a due reminder on this device (Step 21f, #3538): desktop's
//! `processDueReminders` and `createReminderInboxItem` (`lib/reminders.ts`).
//!
//! Desktop marks a fired reminder `status = 'triggered'`, a status it never
//! sends, and its reminder handler keeps a peer's `pending` copy from un-firing
//! it (`a4e8920c55`). Here the synced row is never touched. `reminder_fires`
//! (data migration 0042, device-local) records every fire instant each
//! reminder was shown for, and a reminder is due when its current instant
//! (`snoozedUntil` when snoozed, else `remindAt`) is not among them. A pulled
//! copy with an instant already shown cannot refire it, even one that turns a
//! snooze back into `pending` at its old `remindAt`; a new `remindAt` or a
//! snooze is a new instant and fires it again, as desktop's reschedule and
//! snooze do. Instants are compared as epoch milliseconds, so the same moment
//! written in another offset (a peer in another timezone) is the same instant.
//!
//! The inbox item of a firing is shared by every device (Kaan, 20 Nov, option
//! c): its id is [`inbox_id`], its content depends only on synced data and the
//! fire instant, and it is created through the outbox like any capture. Every
//! core device that fires the same instant writes the same item, so the fleet
//! converges on one. Desktop files `inbox_rem_<nanoid>` per device instead.
//!
//! Every device's create is the same version too: it is clocked
//! `{FIRE_ACTOR: 1}`, not by the device that fired. Any later edit or delete
//! ticks on top of it and dominates it under the plain vector clock rules
//! (chapter 06 §6.1), wherever and however late another device's create
//! arrives, and the server refuses a second create as a replay (§5.7).

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::{Map, Value, json};

use crate::api::errors::StorageError;
use crate::domain::inbox;
use crate::domain::notes::{insert_local, iso, object};
use crate::storage::nested_tx;
use crate::storage::repositories::sync_items;
use crate::sync::outbox;

use super::queries::{due_unless, failed, fire_instant};
use super::{DueReminder, STATUS_PENDING, STATUS_SNOOZED};

/// Desktop's `inboxItemType.REMINDER`.
const INBOX_TYPE: &str = "reminder";

/// The clock actor of every firing's create, the same on every device. Not a
/// device id: those are UUIDs, which never contain `r` or `m`.
pub const FIRE_ACTOR: &str = "reminder-fire";

/// A reminder this device just fired.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fired {
    pub reminder_id: String,
    /// Its inbox item, [`inbox_id`].
    pub inbox_id: String,
    pub fired_for_ms: i64,
}

/// Every live `pending` or `snoozed` reminder whose fire instant is at or
/// before `now_ms` and that this device has not fired for that instant,
/// earliest first. Overdue ones are included: a reminder that came due while
/// the app was closed fires at the next open, once.
pub fn due(conn: &Connection, now_ms: i64) -> Result<Vec<DueReminder>, StorageError> {
    let fired = fired_instants(conn)?;
    due_unless(conn, Some(now_ms), |id, at| {
        fired.contains(&(id.to_owned(), at))
    })
}

/// The inbox item of `reminder_id` fired for `fired_for_ms` (UTC epoch
/// milliseconds): the same on every device, whatever its time zone or clock.
pub fn inbox_id(reminder_id: &str, fired_for_ms: i64) -> String {
    format!("inbox_rem_{reminder_id}_{fired_for_ms}")
}

/// Records `due` as fired for its instant and creates its inbox item, clocked
/// and queued, in one transaction. `None` when this device already fired that
/// instant, so a second call (a racing tick, a restart) files nothing.
///
/// An item that already exists, live or deleted (a peer's create arrived first,
/// or this device filed it before), is left alone: a firing never overwrites an
/// edit or brings back a delete.
pub fn fire(
    conn: &Connection,
    due: &DueReminder,
    now_ms: i64,
) -> Result<Option<Fired>, StorageError> {
    let tx = nested_tx::begin(conn).map_err(failed)?;
    let recorded = tx
        .execute(
            "INSERT INTO reminder_fires (reminder_id, fired_for_ms, fired_at_ms) VALUES (?1, ?2, ?3)
             ON CONFLICT (reminder_id, fired_for_ms) DO NOTHING",
            params![due.reminder.id, due.fire_at_ms, now_ms],
        )
        .map_err(failed)?;
    if recorded == 0 {
        return Ok(None);
    }
    let inbox_id = inbox_id(&due.reminder.id, due.fire_at_ms);
    if sync_items::load(&tx, inbox::ITEM_TYPE, &inbox_id)?.is_none() {
        let mut payload = inbox_payload(&tx, due, &inbox_id)?;
        payload.insert("clock".to_owned(), json!({ FIRE_ACTOR: 1 }));
        insert_local(&tx, inbox::ITEM_TYPE, &inbox_id, payload, now_ms)?;
        outbox::enqueue(
            &tx,
            &outbox::Change::upsert(inbox::ITEM_TYPE, &inbox_id),
            now_ms,
        )?;
    }
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
    let fired = fired_instants(conn)?;
    let mut statement = conn
        .prepare(
            "SELECT id, status, remind_at, snoozed_until FROM reminders
             WHERE deleted_at IS NULL AND status IN (?1, ?2)",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![STATUS_PENDING, STATUS_SNOOZED], |row| {
            let id: String = row.get(0)?;
            let status: String = row.get(1)?;
            let remind_at: String = row.get(2)?;
            let snoozed_until: Option<String> = row.get(3)?;
            let instant = fire_instant(&status, &remind_at, snoozed_until.as_deref());
            Ok(instant.is_none_or(|at| !fired.contains(&(id, at))))
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

/// The instants shown for live `pending` and `snoozed` reminders, the only ones
/// a tick can fire.
fn fired_instants(conn: &Connection) -> Result<HashSet<(String, i64)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT f.reminder_id, f.fired_for_ms FROM reminder_fires f
             JOIN reminders r ON r.id = f.reminder_id
             WHERE r.deleted_at IS NULL AND r.status IN (?1, ?2)",
        )
        .map_err(failed)?;
    statement
        .query_map(params![STATUS_PENDING, STATUS_SNOOZED], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

/// `createReminderInboxItem`: the title, content and `ReminderMetadata` desktop
/// files, with its falsy-to-absent rules (`|| undefined` drops `""` and `0`).
/// `createdAt` is the fire instant, not this device's wall clock, so every
/// device writes the same item.
fn inbox_payload(
    tx: &Connection,
    due: &DueReminder,
    inbox_id: &str,
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

    let at = iso(due.fire_at_ms)?;
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
        "localOnly": false,
    })))
}
