//! State writes on one capture (spec 006 IB022-IB024): viewed, snooze,
//! archive, delete, filed, tags. Clears are explicit `null`s, which is what
//! desktop's unsnooze, unarchive and unfile push.

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::notes::{failed, iso};
use crate::storage::repositories::Change;
use crate::sync::outbox::{self, Durable};

use super::write::{edit, edit_in, require_live};
use super::{ITEM_TYPE, InboxItem, queries};

/// `handleMarkViewed`.
pub fn mark_viewed(
    conn: &Connection,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    edit(
        conn,
        item_id,
        vec![("viewedAt", Change::set(iso(now_ms)?))],
        device_id,
        now_ms,
    )
}

/// `snoozeItem`: a future instant, never on a filed capture.
pub fn snooze(
    conn: &Connection,
    item_id: &str,
    until_ms: i64,
    reason: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    if until_ms <= now_ms {
        return Err(StorageError::Invalid {
            what: "Snooze time must be in the future".to_owned(),
        });
    }
    let item = require_live(conn, item_id)?;
    if item.filed_at.is_some() {
        return Err(StorageError::Invalid {
            what: "Cannot snooze a filed item".to_owned(),
        });
    }
    let reason = reason
        .filter(|r| !r.is_empty())
        .map_or(Value::Null, Value::from);
    edit(
        conn,
        item_id,
        vec![
            ("snoozedUntil", Change::set(iso(until_ms)?)),
            ("snoozeReason", Change::Set(reason)),
        ],
        device_id,
        now_ms,
    )
}

/// `unsnoozeItem`: explicit `null`s, so a peer clears too.
pub fn unsnooze(
    conn: &Connection,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    let item = require_live(conn, item_id)?;
    if item.snoozed_until.is_none() {
        return Err(StorageError::Invalid {
            what: "Item is not snoozed".to_owned(),
        });
    }
    edit(
        conn,
        item_id,
        clear(&["snoozedUntil", "snoozeReason"]),
        device_id,
        now_ms,
    )
}

/// The snooze scheduler's pass (`processDueItems`): every due snooze cleared
/// and pushed. Returns the captures that came back.
pub fn resurface_due(
    conn: &Connection,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<InboxItem>, StorageError> {
    let due = queries::due_snoozed(conn, now_ms)?;
    let mut back = Vec::new();
    for item in due {
        let written = edit(
            conn,
            &item.id,
            clear(&["snoozedUntil", "snoozeReason"]),
            device_id,
            now_ms,
        )?;
        back.push(written.acknowledge());
    }
    Ok(back)
}

fn clear(keys: &[&'static str]) -> Vec<(&'static str, Change)> {
    keys.iter()
        .map(|key| (*key, Change::Set(Value::Null)))
        .collect()
}

/// `handleArchive`.
pub fn archive(
    conn: &Connection,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    require_live(conn, item_id)?;
    edit(
        conn,
        item_id,
        vec![("archivedAt", Change::set(iso(now_ms)?))],
        device_id,
        now_ms,
    )
}

/// `handleUnarchive` / `handleUndoArchive`.
pub fn unarchive(
    conn: &Connection,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    let item = require_live(conn, item_id)?;
    if item.archived_at.is_none() {
        return Err(StorageError::Invalid {
            what: "Item is not archived".to_owned(),
        });
    }
    edit(conn, item_id, clear(&["archivedAt"]), device_id, now_ms)
}

/// `handleDeletePermanent`: a tombstone (desktop's delete push) and the local
/// tags. The shell removes `attachments/inbox/{id}/`.
pub fn delete_permanent(
    conn: &Connection,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<()>, StorageError> {
    require_live(conn, item_id)?;
    outbox::commit(
        conn,
        &outbox::Change::delete(ITEM_TYPE, item_id),
        now_ms,
        |tx| {
            // The ticked clock first, while the row is live; then the tombstone on
            // the record and its projection.
            edit_in(tx, item_id, Vec::new(), device_id, now_ms)?;
            tx.execute(
                "UPDATE sync_items SET deleted_at = ?3, updated_at = ?3
              WHERE item_type = ?1 AND item_id = ?2",
                params![ITEM_TYPE, item_id, now_ms],
            )
            .map_err(failed)?;
            tx.execute(
                "UPDATE inbox_items SET deleted_at = ?2 WHERE id = ?1",
                params![item_id, now_ms],
            )
            .map_err(failed)?;
            tx.execute(
                "DELETE FROM inbox_item_tags WHERE item_id = ?1",
                params![item_id],
            )
            .map_err(failed)?;
            Ok(())
        },
    )
}

/// `markItemAsFiled`: filed, and any snooze cleared.
pub fn mark_filed(
    conn: &Connection,
    item_id: &str,
    filed_to: &str,
    filed_action: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    let at = iso(now_ms)?;
    edit(
        conn,
        item_id,
        vec![
            ("filedAt", Change::set(at)),
            ("filedTo", Change::set(filed_to)),
            ("filedAction", Change::set(filed_action)),
            ("snoozedUntil", Change::Set(Value::Null)),
            ("snoozeReason", Change::Set(Value::Null)),
        ],
        device_id,
        now_ms,
    )
}

/// `handleUndoFile`.
pub fn undo_file(
    conn: &Connection,
    item_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<InboxItem>, StorageError> {
    let item = require_live(conn, item_id)?;
    if item.filed_at.is_none() {
        return Err(StorageError::Invalid {
            what: "Item is not filed".to_owned(),
        });
    }
    edit(
        conn,
        item_id,
        clear(&["filedAt", "filedTo", "filedAction"]),
        device_id,
        now_ms,
    )
}

pub(crate) fn insert_tag(
    tx: &Connection,
    item_id: &str,
    tag: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tag = tag.trim();
    if tag.is_empty() {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO inbox_item_tags (item_id, tag, created_at) VALUES (?1, ?2, ?3)",
        params![item_id, tag, now_ms],
    )
    .map_err(failed)?;
    Ok(())
}

/// `handleAddTag`: device-local, no push (tags never sync).
pub fn add_tag(
    conn: &Connection,
    item_id: &str,
    tag: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    require_live(conn, item_id)?;
    insert_tag(conn, item_id, tag, now_ms)
}

/// `handleRemoveTag`.
pub fn remove_tag(conn: &Connection, item_id: &str, tag: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM inbox_item_tags WHERE item_id = ?1 AND tag = ?2",
        params![item_id, tag],
    )
    .map_err(failed)?;
    Ok(())
}
