//! The apply-time half of §1.9.1: which foreign ids are owed a merge, kept as
//! one `meta` row per foreign id, `journal.day_merge:<foreignId>` =
//! `{foreignId, date, clock, deleted, recordMarkdown?, recordTags?, holderTags?,
//! unpushedHolderTags?}`, and a foreign row's last synced tags and clock under
//! `journal.synced_tags:<foreignId>` = `{tags, clock}`.

use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::journal::{self, ITEM_TYPE};
use crate::domain::journal_rules::{canonical_journal_id, plan_journal_day_apply};
use crate::domain::tags;
use crate::storage::nested_tx;
use crate::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use crate::sync::clock::{self, ClockOrder, VectorClock};
use crate::sync::outbox::OP_UPSERT;
use crate::sync::store;

use super::{OWED_PREFIX, OwedMerge, failed};

const SYNCED_TAGS_PREFIX: &str = "journal.synced_tags:";

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
    let incoming_clock = payload_clock(&payload).unwrap_or_default();

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
                    &HolderTags::default(),
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
/// kept. `holder` are a local holder's as its stored record holds them now,
/// and a sighting replaces them: a tag the user removed from the held day
/// since stays removed (#5694).
pub(super) fn owe(
    conn: &Connection,
    foreign_id: &str,
    date: &str,
    seen: &VectorClock,
    content: Option<&str>,
    record_tags: Option<&[String]>,
    holder: &HolderTags,
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
    let (kept_record, kept_holder, kept_unpushed) = existing
        .as_ref()
        .map(|e| {
            (
                e.record_tags.clone(),
                e.holder_tags.clone(),
                e.unpushed_holder_tags.clone(),
            )
        })
        .unwrap_or_default();
    let owed = OwedMerge {
        foreign_id: foreign_id.to_owned(),
        date: date.to_owned(),
        clock,
        deleted: existing.is_some_and(|existing| existing.deleted),
        record_markdown: markdown,
        record_tags: record_tags.map_or(kept_record, <[String]>::to_vec),
        holder_tags: if holder.sighted {
            holder.all.clone()
        } else {
            kept_holder
        },
        // A tombstone's weighing replaces the list: before one, every holder
        // tag was kept as unpushed, and a tag the deleting device saw would
        // come back (#5659).
        unpushed_holder_tags: if holder.weighed {
            tags::dedupe(holder.unpushed.iter().cloned())
        } else {
            tags::dedupe(
                kept_unpushed
                    .into_iter()
                    .filter(|tag| {
                        !holder.sighted || holder.all.iter().any(|t| tags::same_tag(t, tag))
                    })
                    .chain(holder.unpushed.iter().cloned()),
            )
        },
    };
    write_owed(conn, &owed)
}

/// A foreign local holder's stored tags, and the ones among them the device
/// that deleted it may never have seen (§1.9.1 step 6).
#[derive(Debug, Default)]
pub(super) struct HolderTags {
    all: Vec<String>,
    unpushed: Vec<String>,
    /// Read against a tombstone's clock.
    weighed: bool,
    /// Read from the holder's stored record: `all` is every tag it holds.
    sighted: bool,
}

impl HolderTags {
    /// Weighs the holder's tags against the clock of the tombstone that
    /// deleted it. An ack proves nothing: a tombstone clocked before a pushed
    /// edit replaces it on the server unseen (REVIEW-5656).
    ///
    /// - None are unpushed when no upsert is queued and the tombstone's clock
    ///   covers the row's: the deleting device saw the row as it is.
    /// - Those absent from the [`note_local_edit`] snapshot are, when the
    ///   tombstone's clock covers the snapshot's and no tick the row took
    ///   after it: the deleting device saw the snapshot's tags.
    /// - Otherwise all are: no tombstone clock (none yet, or an unclocked
    ///   delete), or no snapshot it saw exactly (an edit an older build
    ///   queued, or pushed).
    fn read(
        conn: &Connection,
        item_id: &str,
        payload: &serde_json::Map<String, Value>,
        tombstone: Option<&VectorClock>,
    ) -> Result<Self, StorageError> {
        let all = payload_tags(payload).unwrap_or_default();
        // Defense in depth (VERIFY-5656): no test goes red without the filter.
        let tombstone = tombstone.filter(|clock| !clock.is_empty());
        let weighed = tombstone.is_some();
        let (Some(deleted), Some(row)) = (tombstone, payload_clock(payload)) else {
            return Ok(Self {
                unpushed: all.clone(),
                all,
                weighed,
                sighted: true,
            });
        };
        // The queue check is defense in depth (VERIFY-5656): no test goes red
        // without it.
        let unpushed = if covers(deleted, &row) && !upsert_queued(conn, item_id)? {
            Vec::new()
        } else {
            match synced_tags(conn, item_id)? {
                Some((synced, at)) if saw_exactly(deleted, &at, &row) => all
                    .iter()
                    .filter(|tag| !synced.iter().any(|kept| tags::same_tag(kept, tag)))
                    .cloned()
                    .collect(),
                _ => all.clone(),
            }
        };
        Ok(Self {
            all,
            unpushed,
            weighed,
            sighted: true,
        })
    }
}

fn covers(deleted: &VectorClock, clock: &VectorClock) -> bool {
    matches!(
        clock::compare(clock, deleted),
        ClockOrder::Before | ClockOrder::Equal
    )
}

/// Whether `deleted` covers `synced` and none of the ticks `row` took after
/// it, so the deleting device merged the tags kept at `synced`. A stale
/// snapshot, one an older build pushed past, fails here.
fn saw_exactly(deleted: &VectorClock, synced: &VectorClock, row: &VectorClock) -> bool {
    covers(deleted, synced)
        && row.iter().all(|(device, &tick)| {
            tick.min(clock::get_tick(deleted, device)) <= clock::get_tick(synced, device)
        })
}

/// Runs before every local edit of a sync item, ahead of its outbox row. A
/// foreign journal row with no upsert queued holds the last record it
/// synced, so its tags and clock are kept for [`HolderTags::read`]. An edit
/// after that, still unpushed, keeps the snapshot taken before it.
/// [`note_acked`] drops it.
pub(crate) fn note_local_edit(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    stored: &str,
) -> Result<(), StorageError> {
    if item_type != ITEM_TYPE {
        return Ok(());
    }
    let Ok(Value::Object(payload)) = serde_json::from_str::<Value>(stored) else {
        return Ok(());
    };
    let foreign = payload
        .get("date")
        .and_then(Value::as_str)
        .is_some_and(|date| canonical_journal_id(date) != item_id);
    // Keeping the snapshot taken before the first unpushed edit is defense in
    // depth (VERIFY-5656): no test goes red when a later edit replaces it.
    if !foreign || upsert_queued(conn, item_id)? {
        return Ok(());
    }
    let synced = json!({
        "tags": payload_tags(&payload).unwrap_or_default(),
        "clock": payload.get("clock"),
    });
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![format!("{SYNCED_TAGS_PREFIX}{item_id}"), synced.to_string()],
    )
    .map_err(failed)?;
    Ok(())
}

fn upsert_queued(conn: &Connection, item_id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM outbox WHERE item_type = ?1 AND item_id = ?2 AND op = ?3)",
        params![ITEM_TYPE, item_id, OP_UPSERT],
        |row| row.get(0),
    )
    .map_err(failed)
}

/// The snapshot's tags and clock. One that will not parse is none.
fn synced_tags(
    conn: &Connection,
    item_id: &str,
) -> Result<Option<(Vec<String>, VectorClock)>, StorageError> {
    let value = meta_value(conn, &format!("{SYNCED_TAGS_PREFIX}{item_id}"))?;
    Ok(value.and_then(|value| {
        let Ok(Value::Object(snapshot)) = serde_json::from_str::<Value>(&value) else {
            return None;
        };
        Some((string_list(&snapshot, "tags")?, payload_clock(&snapshot)?))
    }))
}

/// Runs when the server takes a queued record row: the snapshot an upsert of
/// a journal id kept is no longer what the server holds. Defense in depth
/// (VERIFY-5656): no test goes red when the ack keeps the snapshot.
pub(crate) fn note_acked(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    op: &str,
) -> Result<(), StorageError> {
    if item_type != ITEM_TYPE || op != OP_UPSERT {
        return Ok(());
    }
    drop_synced_tags(conn, item_id)
}

/// Called when the foreign id is forgotten with its owed merge, or pushed.
pub(super) fn drop_synced_tags(conn: &Connection, foreign_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM meta WHERE key = ?1",
        params![format!("{SYNCED_TAGS_PREFIX}{foreign_id}")],
    )
    .map_err(failed)?;
    Ok(())
}

/// Owes the merge of a foreign local holder, with the clock and `content`
/// of its stored record, and its stored `tags` as holder tags. The caller deletes its `note_tags` rows, so
/// the stored payload is where its tags survive. A holder a tombstone already
/// held is weighed against that tombstone again; before one, every tag counts.
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
    let tombstone = match &row {
        Some(row) if row.deleted_at.is_some() => {
            store::tombstone_clock(conn, ITEM_TYPE, foreign_id)?
        }
        _ => None,
    };
    let payload = stored_payload(row);
    let content = payload.get("content").and_then(Value::as_str);
    let holder = HolderTags::read(conn, foreign_id, &payload, tombstone.as_ref())?;
    owe(conn, foreign_id, date, &clock, content, None, &holder)
}

/// `merge` as its holder `F` is now. While `F`'s entry holds the day, the
/// user can still edit it after its tombstone was held, and an owed merge
/// read before that edit holds tags `F` no longer has, or lacks one it gained
/// (#5694). `F` is owed again from its stored record, then read back. A
/// soft-deleted entry counts too, as defense in depth: [`held_live`] keeps a
/// held `F` live, but an older build may have soft-deleted one.
pub(super) fn owed_now(conn: &Connection, merge: OwedMerge) -> Result<OwedMerge, StorageError> {
    let held = journal::entry_for(conn, &merge.date)?.is_some_and(|(id, _)| id == merge.foreign_id);
    if !held {
        return Ok(merge);
    }
    owe_holder(conn, &merge.foreign_id, &merge.date)?;
    Ok(read_owed(conn, &merge.foreign_id)?.unwrap_or(merge))
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

fn payload_clock(payload: &serde_json::Map<String, Value>) -> Option<VectorClock> {
    serde_json::from_value(payload.get("clock")?.clone()).ok()
}

/// A tombstone arrived for a foreign id that is a live row here (a pre-fix
/// install projected it), or was one until `j<D>` displaced it. Its row, its
/// stored record and its local body stay for the drain, which folds them,
/// unpushed edits included, into `j<D>` (#2984): the ordinary delete would
/// purge them first. True when the tombstone was held this way, on every
/// delivery: `j<D>` can arrive first, and the feed can bring the tombstone
/// again (#5659).
///
/// Runs before the tombstone drops the row's queued upsert, which tells
/// [`HolderTags::read`] what was never pushed.
pub(crate) fn hold_for_merge(
    conn: &Connection,
    item_id: &str,
    tombstone: Option<&VectorClock>,
) -> Result<bool, StorageError> {
    let live: Option<String> = conn
        .query_row(
            "SELECT date FROM journal_entries WHERE id = ?1 AND deleted_at IS NULL",
            params![item_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    // Its tags may be an unpushed local edit, as its body may.
    let payload = stored_payload(sync_items::load(conn, ITEM_TYPE, item_id)?);
    let date = match live {
        Some(date) => date,
        // A displaced holder: an owed merge, and the record it held the day by.
        None => match read_owed(conn, item_id)? {
            Some(owed)
                if payload.get("date").and_then(Value::as_str) == Some(owed.date.as_str()) =>
            {
                owed.date
            }
            _ => return Ok(false),
        },
    };
    if canonical_journal_id(&date) == item_id {
        return Ok(false);
    }
    let clock = tombstone.cloned().unwrap_or_default();
    let holder = HolderTags::read(conn, item_id, &payload, tombstone)?;
    owe(conn, item_id, &date, &clock, None, None, &holder)?;
    mark_deleted(conn, item_id)?;
    Ok(true)
}

/// Invariant (#5763): a foreign journal row `F` whose owed merge is marked
/// deleted and whose entry is live is held, and stays live until the drain
/// removes it. Its `sync_items.deleted_at` is the tombstone's, so a local
/// edit must not project it: a soft-deleted `F` makes the next edit revive it,
/// purging its unpushed body and queuing an upsert over the tombstone.
pub(crate) fn held_live(conn: &Connection, kind: &str, id: &str) -> Result<bool, StorageError> {
    if kind != ITEM_TYPE || !read_owed(conn, id)?.is_some_and(|owed| owed.deleted) {
        return Ok(false);
    }
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM journal_entries WHERE id = ?1 AND deleted_at IS NULL)",
        params![id],
        |row| row.get(0),
    )
    .map_err(failed)
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
        // Even when empty: an absent list reads as every holder tag.
        value["unpushedHolderTags"] = json!(owed.unpushed_holder_tags);
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

pub(super) fn read_owed(
    conn: &Connection,
    foreign_id: &str,
) -> Result<Option<OwedMerge>, StorageError> {
    let value = meta_value(conn, &format!("{OWED_PREFIX}{foreign_id}"))?;
    Ok(value.and_then(|value| parse_owed(&value)))
}

fn meta_value(conn: &Connection, key: &str) -> Result<Option<String>, StorageError> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(failed)
}

fn parse_owed(value: &str) -> Option<OwedMerge> {
    let value: Value = serde_json::from_str(value).ok()?;
    let object = value.as_object();
    let holder_tags = object
        .and_then(|o| string_list(o, "holderTags"))
        .unwrap_or_default();
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
        // An older build kept no unpushed list and added every holder tag.
        unpushed_holder_tags: object
            .and_then(|o| string_list(o, "unpushedHolderTags"))
            .unwrap_or_else(|| holder_tags.clone()),
        holder_tags,
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
