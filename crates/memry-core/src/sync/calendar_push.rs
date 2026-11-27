//! The outbox's calendar hook (split from [`super::outbox`] at the 600-line
//! ceiling): a local change to an item a calendar provider can carry queues
//! its push (spec 007 CL075).

use rusqlite::{Connection, params};

use super::outbox::Change;
use crate::api::errors::StorageError;
use crate::domain::notes::failed;

/// A local change to an item the calendar can put on a provider queues its
/// push (spec 007 CL075): events, tasks, reminders and inbox snoozes, the
/// four `CalendarSyncSourceType`s. Remote applies never come through here.
pub(super) fn queue(tx: &Connection, change: &Change, now_ms: i64) -> Result<(), StorageError> {
    let Change::Record {
        item_type, item_id, ..
    } = change
    else {
        return Ok(());
    };
    let source_type = match item_type.as_str() {
        "calendar_event" => "event",
        "task" => "task",
        "reminder" => "reminder",
        "inbox" => "inbox_snooze",
        _ => return Ok(()),
    };
    queue_source(tx, source_type, item_id, now_ms)
}

/// Queues the push of one calendar source (`event`, `task`, `reminder`,
/// `inbox_snooze`): a local change that makes no outbox row still moves it on
/// or off a provider calendar, as a reminder's fire does.
pub(crate) fn queue_source(
    tx: &Connection,
    source_type: &str,
    source_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    // The stamp only grows: a push that lands drops the row only if it still has the stamp the
    // push was planned from, so an edit in the same millisecond must move it too.
    tx.execute(
        "INSERT INTO calendar_push_queue (source_type, source_id, queued_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(source_type, source_id) DO UPDATE
           SET queued_at = MAX(excluded.queued_at, calendar_push_queue.queued_at + 1),
           attempts = 0, last_error = NULL",
        params![source_type, source_id, now_ms],
    )
    .map_err(failed)?;
    Ok(())
}
