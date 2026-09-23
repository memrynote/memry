//! Reminders on a note (N804, chapter 13 §13.7.12).
//!
//! **`triggeredAt` is deliberately not written here**, and the chapter says
//! why: each device shows its own notification, so a synced "already fired"
//! would suppress it on a device that never displayed it. Dismiss and snooze
//! state *does* sync, and both are written.
//!
//! The status values are carried verbatim rather than mapped to an enum,
//! because §13.7.12 marks `status` a string and never enumerates it. A core
//! that closed the set would refuse a value desktop writes.

use rusqlite::Connection;
use serde_json::json;

use crate::api::errors::StorageError;
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox::{self, Durable};

use super::notes::{insert_local, iso, next_clock, object, stamp};

pub const ITEM_TYPE: &str = "reminder";

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
            "status": "pending",
            "clock": next_clock(&Default::default(), device_id)?,
            "createdAt": at,
            "modifiedAt": at,
        }));
        insert_local(tx, ITEM_TYPE, id, payload, now_ms)
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
            ("status", Change::set("dismissed")),
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
            ("status", Change::set("snoozed")),
            ("snoozedUntil", Change::set(until)),
        ],
        device_id,
        now_ms,
    )
}

fn edit(
    conn: &Connection,
    id: &str,
    changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    outbox::commit(conn, &outbox::Change::upsert(ITEM_TYPE, id), now_ms, |tx| {
        let mut merged = stamp(tx, ITEM_TYPE, id, device_id, now_ms)?;
        merged.extend(changes);
        sync_items::apply_local_edit_in(tx, ITEM_TYPE, id, &merged, now_ms)
    })
}
