//! The apply-time half of §1.9.1: which foreign ids are owed a merge, kept as
//! one `meta` row per foreign id, `journal.day_merge:<foreignId>` =
//! `{foreignId, date, clock, deleted, recordMarkdown?, recordTags?, holderTags?}`.

use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::journal::{self, ITEM_TYPE};
use crate::domain::journal_rules::{canonical_journal_id, plan_journal_day_apply};
use crate::domain::tags;
use crate::storage::nested_tx;
use crate::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use crate::sync::clock::{self, ClockOrder, VectorClock};

use super::{OWED_PREFIX, OwedMerge, failed};

/// The apply-time decision for an inbound `journal` record.
///
/// `None` hands the record to the ordinary apply: no date (a tombstone), a
/// payload that will not parse, or a canonical record with no foreign holder.
/// `Some(Skipped)` means a foreign record: its merge is owed and nothing is
/// stored for it.
pub(crate) fn plan_inbound(
    conn: &Connection,
    record: &InboundRecord,
) -> Result<Option<ApplyOutcome>, StorageError> {
    let Ok(Value::Object(payload)) = serde_json::from_str::<Value>(&record.payload_json) else {
        return Ok(None);
    };
    let Some(date) = payload.get("date").and_then(Value::as_str) else {
        return Ok(None);
    };
    if journal::valid_date(date).is_err() {
        return Ok(None);
    }
    let content = payload.get("content").and_then(Value::as_str);
    let incoming_tags = payload_tags(&payload);
    let incoming_clock = payload
        .get("clock")
        .and_then(|value| serde_json::from_value::<VectorClock>(value.clone()).ok())
        .unwrap_or_default();

    let held = journal::entry_for(conn, date)?;
    let live_holder = held
        .as_ref()
        .filter(|(_, deleted)| !deleted)
        .map(|(id, _)| id.as_str());
    let plan = plan_journal_day_apply(&record.item_id, date, live_holder);
    // A tombstoned foreign row still holds the date in the projection.
    let stale_holder = held
        .as_ref()
        .filter(|(id, deleted)| *deleted && plan.apply_incoming && *id != record.item_id)
        .map(|(id, _)| id.as_str());
    if plan.owe_merge.is_empty() && stale_holder.is_none() {
        return Ok(None);
    }

    let tx = nested_tx::begin(conn).map_err(failed)?;
    for foreign_id in &plan.owe_merge {
        if *foreign_id == record.item_id {
            if !tombstoned_past(&tx, foreign_id, &incoming_clock)? {
                owe(
                    &tx,
                    foreign_id,
                    date,
                    &incoming_clock,
                    content,
                    incoming_tags.as_deref(),
                    &[],
                )?;
            }
        } else {
            owe_holder(&tx, foreign_id, date)?;
        }
    }
    let removed = if plan.remove_holder {
        live_holder
    } else {
        stale_holder
    };
    if let Some(holder) = removed {
        // The row only. The holder's Yjs docs stay for the drain.
        tx.execute("DELETE FROM journal_entries WHERE id = ?1", params![holder])
            .map_err(failed)?;
        tx.execute("DELETE FROM note_tags WHERE note_id = ?1", params![holder])
            .map_err(failed)?;
    }
    tx.commit().map_err(failed)?;
    Ok((!plan.apply_incoming).then_some(ApplyOutcome::Skipped))
}

/// Whether this device already tombstoned `item_id` at or past `incoming`,
/// so a re-delivered record of a merged foreign id owes nothing again.
fn tombstoned_past(
    conn: &Connection,
    item_id: &str,
    incoming: &VectorClock,
) -> Result<bool, StorageError> {
    let Some(row) = sync_items::load(conn, ITEM_TYPE, item_id)? else {
        return Ok(false);
    };
    let local = row
        .clock
        .filter(|_| row.deleted_at.is_some())
        .and_then(|text| serde_json::from_str::<VectorClock>(&text).ok());
    Ok(local.is_some_and(|local| {
        matches!(
            clock::compare(&local, incoming),
            ClockOrder::After | ClockOrder::Equal
        )
    }))
}

/// Records an owed merge. Idempotent; a second sighting widens the clock so
/// the tombstone dominates every version seen, and keeps the record text
/// (`content`) the drain builds a body from when the foreign doc has none.
///
/// Tags come in two kinds (§1.9.1 step 6). `record_tags` are the newest
/// foreign record's `tags`: a later record replaces them, so a tag removed on
/// the writing device stays removed; `None` (no `tags` key) keeps the ones
/// kept. `holder_tags` are a local holder's, which may never have been
/// pushed, so every sighting adds to them.
pub(super) fn owe(
    conn: &Connection,
    foreign_id: &str,
    date: &str,
    seen: &VectorClock,
    content: Option<&str>,
    record_tags: Option<&[String]>,
    holder_tags: &[String],
) -> Result<(), StorageError> {
    let existing = read_owed(conn, foreign_id)?;
    let clock = match &existing {
        Some(existing) => clock::merge(&existing.clock, seen),
        None => seen.clone(),
    };
    let markdown = content
        .filter(|content| !content.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| existing.as_ref().and_then(|e| e.record_markdown.clone()));
    let (kept_record, kept_holder) = existing
        .as_ref()
        .map(|e| (e.record_tags.clone(), e.holder_tags.clone()))
        .unwrap_or_default();
    let owed = OwedMerge {
        foreign_id: foreign_id.to_owned(),
        date: date.to_owned(),
        clock,
        deleted: existing.is_some_and(|existing| existing.deleted),
        record_markdown: markdown,
        record_tags: record_tags.map_or(kept_record, <[String]>::to_vec),
        holder_tags: tags::dedupe(kept_holder.into_iter().chain(holder_tags.iter().cloned())),
    };
    write_owed(conn, &owed)
}

/// Owes the merge of a foreign local holder, with the clock and `content`
/// of its stored record, and its stored `tags` as holder tags. The caller deletes its `note_tags` rows, so
/// the stored payload is where its tags survive.
pub(super) fn owe_holder(
    conn: &Connection,
    foreign_id: &str,
    date: &str,
) -> Result<(), StorageError> {
    let row = sync_items::load(conn, ITEM_TYPE, foreign_id)?;
    let clock = row
        .as_ref()
        .and_then(|row| row.clock.as_deref())
        .and_then(|text| serde_json::from_str::<VectorClock>(text).ok())
        .unwrap_or_default();
    let payload = stored_payload(row);
    let content = payload.get("content").and_then(Value::as_str);
    owe(
        conn,
        foreign_id,
        date,
        &clock,
        content,
        None,
        &payload_tags(&payload).unwrap_or_default(),
    )
}

fn stored_payload(row: Option<sync_items::SyncItemRow>) -> serde_json::Map<String, Value> {
    match row
        .and_then(|row| row.payload)
        .and_then(|payload| serde_json::from_str::<Value>(&payload).ok())
    {
        Some(Value::Object(payload)) => payload,
        _ => serde_json::Map::new(),
    }
}

/// The string array under `key`, skipping non-strings; `None` when absent.
fn string_list(object: &serde_json::Map<String, Value>, key: &str) -> Option<Vec<String>> {
    object.get(key).and_then(Value::as_array).map(|list| {
        list.iter()
            .filter_map(|tag| tag.as_str().map(str::to_owned))
            .collect()
    })
}

fn payload_tags(payload: &serde_json::Map<String, Value>) -> Option<Vec<String>> {
    string_list(payload, "tags")
}

/// A tombstone arrived for a foreign id that is a live row here (a pre-fix
/// install projected it). Its row and local body stay for the drain, which
/// folds them, unpushed edits included, into `j<D>` (#2984): the ordinary
/// delete would purge them first. True when the tombstone was held this way.
pub(crate) fn hold_for_merge(
    conn: &Connection,
    item_id: &str,
    tombstone: Option<&VectorClock>,
) -> Result<bool, StorageError> {
    let date: Option<String> = conn
        .query_row(
            "SELECT date FROM journal_entries WHERE id = ?1 AND deleted_at IS NULL",
            params![item_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    let Some(date) = date.filter(|date| canonical_journal_id(date) != item_id) else {
        return Ok(false);
    };
    let clock = tombstone.cloned().unwrap_or_default();
    // Its tags may be an unpushed local edit, as its body may.
    let tags = payload_tags(&stored_payload(sync_items::load(conn, ITEM_TYPE, item_id)?))
        .unwrap_or_default();
    owe(conn, item_id, &date, &clock, None, None, &tags)?;
    mark_deleted(conn, item_id)?;
    Ok(true)
}

/// Called from the tombstone apply: an owed foreign id is already deleted on
/// the server. No-op for an id with no owed merge.
pub(crate) fn mark_deleted(conn: &Connection, foreign_id: &str) -> Result<(), StorageError> {
    match read_owed(conn, foreign_id)? {
        Some(owed) => write_owed(
            conn,
            &OwedMerge {
                deleted: true,
                ..owed
            },
        ),
        None => Ok(()),
    }
}

fn write_owed(conn: &Connection, owed: &OwedMerge) -> Result<(), StorageError> {
    let mut value = json!({
        "foreignId": owed.foreign_id,
        "date": owed.date,
        "clock": owed.clock,
        "deleted": owed.deleted,
    });
    if let Some(markdown) = &owed.record_markdown {
        value["recordMarkdown"] = json!(markdown);
    }
    if !owed.record_tags.is_empty() {
        value["recordTags"] = json!(owed.record_tags);
    }
    if !owed.holder_tags.is_empty() {
        value["holderTags"] = json!(owed.holder_tags);
    }
    let foreign_id = &owed.foreign_id;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![format!("{OWED_PREFIX}{foreign_id}"), value.to_string()],
    )
    .map_err(failed)?;
    Ok(())
}

fn read_owed(conn: &Connection, foreign_id: &str) -> Result<Option<OwedMerge>, StorageError> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![format!("{OWED_PREFIX}{foreign_id}")],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(value.and_then(|value| parse_owed(&value)))
}

fn parse_owed(value: &str) -> Option<OwedMerge> {
    let value: Value = serde_json::from_str(value).ok()?;
    let object = value.as_object();
    Some(OwedMerge {
        foreign_id: value.get("foreignId")?.as_str()?.to_owned(),
        date: value.get("date")?.as_str()?.to_owned(),
        clock: value
            .get("clock")
            .and_then(|clock| serde_json::from_value(clock.clone()).ok())
            .unwrap_or_default(),
        deleted: value.get("deleted").and_then(Value::as_bool) == Some(true),
        record_markdown: value
            .get("recordMarkdown")
            .and_then(Value::as_str)
            .map(str::to_owned),
        // An older build wrote neither tag list.
        record_tags: object
            .and_then(|o| string_list(o, "recordTags"))
            .unwrap_or_default(),
        holder_tags: object
            .and_then(|o| string_list(o, "holderTags"))
            .unwrap_or_default(),
    })
}

/// Every owed merge, in foreign-id order.
pub fn owed(conn: &Connection) -> Result<Vec<OwedMerge>, StorageError> {
    let mut statement = conn
        .prepare("SELECT value FROM meta WHERE substr(key, 1, ?1) = ?2 ORDER BY key")
        .map_err(failed)?;
    let values = statement
        .query_map(params![OWED_PREFIX.len() as i64, OWED_PREFIX], |row| {
            row.get::<_, String>(0)
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    Ok(values
        .iter()
        .filter_map(|value| parse_owed(value))
        .collect())
}
