//! One journal item per day, `j<YYYY-MM-DD>` (protocol §1.9, #2939).
//!
//! A journal id other than `j<D>` carrying date `D` is *foreign*. It is never
//! projected as a row: `journal_entries.date` is `UNIQUE`, and before this
//! module a foreign record for a day this device already held failed that
//! constraint and was recorded corrupt.
//!
//! Two halves, both keyed by one `meta` row per foreign id,
//! `journal.day_merge:<foreignId>` = `{foreignId, date, clock}`:
//!
//! - [`plan_inbound`] runs inside the page apply. It asks
//!   [`plan_journal_day_apply`] what to do, records each owed merge, removes a
//!   foreign local holder's projection when the canonical day arrives, and
//!   answers `Skipped` for a foreign record.
//! - [`drain`] runs after the pass's body step. Per owed merge it makes sure
//!   `j<D>` exists, pulls the foreign body, relinks tasks, merges the foreign
//!   Yjs state into `j<D>` as a local edit, queues the foreign id's tombstone
//!   and purges its body. Every step converges on a re-run.

use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::crdt::registry::UpdateSink;
use crate::crdt::{DocumentRegistry, update_log};
use crate::domain::journal::{self, ITEM_TYPE};
use crate::domain::journal_rules::{canonical_journal_id, plan_journal_day_apply};
use crate::domain::{body_write, tasks};
use crate::storage::Db;
use crate::storage::repositories::payload::{Change, StoredPayload};
use crate::storage::repositories::projectors;
use crate::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};

use super::body_debt;
use super::body_pull::BodyPull;
use super::clock::{self, ClockOrder, VectorClock};
use super::{outbox, store};

const OWED_PREFIX: &str = "journal.day_merge:";

/// One owed merge: the foreign id's body goes into `j<date>`, then the
/// foreign id is tombstoned under `clock` ticked by this device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwedMerge {
    pub foreign_id: String,
    pub date: String,
    pub clock: VectorClock,
    /// A tombstone for the foreign id already arrived: another device merged
    /// it. The body is still merged when there is one; no tombstone is queued.
    pub deleted: bool,
}

/// What one [`drain`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DrainReport {
    /// Foreign ids merged and tombstoned (or settled with no clock to tombstone).
    pub settled: Vec<String>,
    /// Foreign ids still owed: body not fully fetched, no Yjs state, or a failure.
    pub owed: Vec<String>,
}

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

    let tx = conn.unchecked_transaction().map_err(failed)?;
    for foreign_id in &plan.owe_merge {
        if *foreign_id == record.item_id {
            if !tombstoned_past(&tx, foreign_id, &incoming_clock)? {
                owe(&tx, foreign_id, date, &incoming_clock)?;
            }
        } else {
            let holder_clock = sync_items::load(&tx, ITEM_TYPE, foreign_id)?
                .and_then(|row| row.clock)
                .and_then(|text| serde_json::from_str::<VectorClock>(&text).ok())
                .unwrap_or_default();
            owe(&tx, foreign_id, date, &holder_clock)?;
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
/// the tombstone dominates every version seen.
fn owe(
    conn: &Connection,
    foreign_id: &str,
    date: &str,
    seen: &VectorClock,
) -> Result<(), StorageError> {
    let existing = read_owed(conn, foreign_id)?;
    let clock = match &existing {
        Some(existing) => clock::merge(&existing.clock, seen),
        None => seen.clone(),
    };
    let deleted = existing.is_some_and(|existing| existing.deleted);
    write_owed(conn, foreign_id, date, &clock, deleted)
}

/// Called from the tombstone apply: an owed foreign id is already deleted on
/// the server. No-op for an id with no owed merge.
pub(crate) fn mark_deleted(conn: &Connection, foreign_id: &str) -> Result<(), StorageError> {
    match read_owed(conn, foreign_id)? {
        Some(owed) => write_owed(conn, foreign_id, &owed.date, &owed.clock, true),
        None => Ok(()),
    }
}

fn write_owed(
    conn: &Connection,
    foreign_id: &str,
    date: &str,
    clock: &VectorClock,
    deleted: bool,
) -> Result<(), StorageError> {
    let value =
        json!({ "foreignId": foreign_id, "date": date, "clock": clock, "deleted": deleted });
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
    Some(OwedMerge {
        foreign_id: value.get("foreignId")?.as_str()?.to_owned(),
        date: value.get("date")?.as_str()?.to_owned(),
        clock: value
            .get("clock")
            .and_then(|clock| serde_json::from_value(clock.clone()).ok())
            .unwrap_or_default(),
        deleted: value.get("deleted").and_then(Value::as_bool) == Some(true),
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

/// Settles every owed merge it can. Runs after the pass's body step.
///
/// A merge stays owed when the foreign body did not fully arrive, when it has
/// no Yjs state (the core cannot parse markdown, §12.1.2; desktop resolves
/// it), or when a step failed. Only a local storage failure propagates.
pub async fn drain(
    db: &Db,
    bodies: &BodyPull,
    device_id: &str,
) -> Result<DrainReport, StorageError> {
    let mut report = DrainReport::default();
    for merge in db.call(|conn| owed(conn)).await? {
        let foreign_id = merge.foreign_id.clone();
        let settled = match drain_one(db, bodies, device_id, merge).await {
            Ok(settled) => settled,
            Err(DrainError::Storage(error)) => return Err(error),
            Err(DrainError::Step(what)) => {
                eprintln!("memry-core: journal day merge of {foreign_id} stays owed: {what}");
                false
            }
        };
        if settled {
            report.settled.push(foreign_id);
        } else {
            report.owed.push(foreign_id);
        }
    }
    Ok(report)
}

enum DrainError {
    Storage(StorageError),
    Step(String),
}

impl From<StorageError> for DrainError {
    fn from(error: StorageError) -> Self {
        DrainError::Storage(error)
    }
}

async fn drain_one(
    db: &Db,
    bodies: &BodyPull,
    device_id: &str,
    merge: OwedMerge,
) -> Result<bool, DrainError> {
    // b. The foreign body, whole, or the merge waits for a later pass.
    let pulled = bodies
        .pull_document(&merge.foreign_id)
        .await
        .map_err(|error| DrainError::Step(error.to_string()))?;
    if !pulled.merged() {
        return Ok(false);
    }
    // No Yjs state: the core cannot merge markdown (§12.1.2), so the merge
    // waits for desktop, unless another device already merged and deleted it.
    let (foreign, deleted) = (merge.foreign_id.clone(), merge.deleted);
    let empty_settled = db
        .call(move |conn| {
            if !update_log::load_plan(conn, &foreign)
                .map_err(crdt_failed)?
                .is_empty()
            {
                return Ok(None);
            }
            if !deleted {
                return Ok(Some(false));
            }
            let tx = conn.unchecked_transaction().map_err(failed)?;
            forget(&tx, &foreign, now_ms())?;
            tx.commit().map_err(failed)?;
            Ok(Some(true))
        })
        .await?;
    if let Some(settled) = empty_settled {
        return Ok(settled);
    }

    let canonical = canonical_journal_id(&merge.date);
    // a. The canonical day, created empty if missing. A foreign live holder
    // is swept first, as an incoming canonical record would sweep it.
    let (date, device) = (merge.date.clone(), device_id.to_owned());
    let opened = db
        .call(move |conn| ensure_canonical(conn, &date, &device, now_ms()))
        .await
        .map_err(|error| DrainError::Step(error.to_string()))?;
    if opened != canonical {
        return Err(DrainError::Step(format!(
            "day {} is held by {opened}, not {canonical}",
            merge.date
        )));
    }

    let foreign = merge.foreign_id.clone();
    let device = device_id.to_owned();
    db.call(move |conn| settle(conn, &merge, &canonical, &device, now_ms()))
        .await
        .map_err(|error| match error {
            StorageError::Failed { what } => DrainError::Step(format!("{foreign}: {what}")),
            other => DrainError::Storage(other),
        })
}

fn ensure_canonical(
    conn: &Connection,
    date: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let canonical = canonical_journal_id(date);
    let holder = journal::live_entry(conn, date)?;
    let plan = plan_journal_day_apply(&canonical, date, holder.as_deref());
    let tx = conn.unchecked_transaction().map_err(failed)?;
    if let (true, Some(holder)) = (plan.remove_holder, holder.as_deref()) {
        let clock = sync_items::load(&tx, ITEM_TYPE, holder)?
            .and_then(|row| row.clock)
            .and_then(|text| serde_json::from_str::<VectorClock>(&text).ok())
            .unwrap_or_default();
        owe(&tx, holder, date, &clock)?;
        tx.execute("DELETE FROM journal_entries WHERE id = ?1", params![holder])
            .map_err(failed)?;
        tx.execute("DELETE FROM note_tags WHERE note_id = ?1", params![holder])
            .map_err(failed)?;
    }
    let opened = journal::open_day_in(&tx, date, device_id, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(opened.id)
}

/// Steps c to e for a foreign body already local. `Ok(false)` leaves it owed.
fn settle(
    conn: &Connection,
    merge: &OwedMerge,
    canonical: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let foreign = &merge.foreign_id;
    let plan = update_log::load_plan(conn, foreign).map_err(crdt_failed)?;
    if plan.is_empty() {
        return Ok(false);
    }
    let state = folded_state(foreign, &plan.blobs()).map_err(crdt_failed)?;

    // d. Tasks linked to the foreign day follow it, each through the task
    // edit path so the change syncs. Each edit commits on its own; a re-run
    // finds nothing left to relink.
    for (task_id, linked) in tasks_linking(conn, foreign)? {
        let mut relinked: Vec<String> = Vec::with_capacity(linked.len());
        for id in linked {
            let id = if id == *foreign {
                canonical.to_owned()
            } else {
                id
            };
            if !relinked.contains(&id) {
                relinked.push(id);
            }
        }
        tasks::fields::set_linked_note_ids(conn, &task_id, &relinked, device_id, now_ms)?;
    }

    // c. The foreign state as a local edit of the canonical day: what it
    // authors is exactly the part the day does not hold yet, so a repeat
    // authors nothing and queues nothing.
    let update = body_write::author_with(conn, canonical, device_id, |document| {
        document.apply_local_update(&state)
    })
    .map_err(crdt_failed)?;

    let tx = conn.unchecked_transaction().map_err(failed)?;
    if let Some(update) = update {
        body_write::append_in(&tx, ITEM_TYPE, canonical, &update, now_ms).map_err(crdt_failed)?;
    }
    // e. The foreign id's tombstone, unless one already arrived, then its
    // body and its debts.
    if !merge.deleted && !merge.clock.is_empty() {
        tombstone_foreign(
            &tx,
            foreign,
            &clock::increment(&merge.clock, device_id),
            now_ms,
        )?;
    }
    forget(&tx, foreign, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(true)
}

/// The foreign id's projection, local body, body debt and owed-merge row.
fn forget(tx: &Connection, foreign: &str, now_ms: i64) -> Result<(), StorageError> {
    projectors::delete(tx, ITEM_TYPE, foreign, now_ms)?;
    update_log::purge_in(tx, foreign).map_err(crdt_failed)?;
    body_debt::settle(tx, foreign)?;
    tx.execute(
        "DELETE FROM meta WHERE key = ?1",
        params![format!("{OWED_PREFIX}{foreign}")],
    )
    .map_err(failed)?;
    Ok(())
}

/// Every update of the foreign doc, server then local, as one v1 update.
fn folded_state(doc_id: &str, blobs: &[&[u8]]) -> Result<Vec<u8>, CrdtError> {
    let sink: UpdateSink = std::sync::Arc::new(|_, _| {});
    let document = DocumentRegistry::new("journal-day-merge", sink).get_or_open(doc_id)?;
    for blob in blobs {
        document.apply_durable_update(blob)?;
    }
    document.encode_state()
}

fn tasks_linking(
    conn: &Connection,
    foreign_id: &str,
) -> Result<Vec<(String, Vec<String>)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id, linked_note_ids FROM tasks
             WHERE deleted_at IS NULL AND instr(linked_note_ids, ?1) > 0",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![foreign_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, linked)| {
            let linked: Vec<String> = serde_json::from_str(&linked).ok()?;
            linked
                .iter()
                .any(|linked| linked == foreign_id)
                .then_some((id, linked))
        })
        .collect())
}

/// Writes the foreign id's tombstone row and queues its delete. The push
/// rebuilds the envelope from this row (§6.5.2 P2), so the row carries the
/// ticked clock and `deleted_at`. A stored payload keeps its keys; a foreign
/// id this device never stored gets `{clock}`, which a delete never decodes
/// (§5.12).
fn tombstone_foreign(
    tx: &Connection,
    foreign_id: &str,
    clock: &VectorClock,
    now_ms: i64,
) -> Result<(), StorageError> {
    let clock_value = serde_json::to_value(clock).map_err(|error| StorageError::Failed {
        what: error.to_string(),
    })?;
    let payload = match sync_items::load(tx, ITEM_TYPE, foreign_id)?.and_then(|row| row.payload) {
        Some(stored) => StoredPayload::parse(&stored)
            .map(|parsed| parsed.merge(&[("clock", Change::Set(clock_value.clone()))]))
            .unwrap_or_else(|_| json!({ "clock": clock_value }).to_string()),
        None => json!({ "clock": clock_value }).to_string(),
    };
    tx.execute(
        "INSERT INTO sync_items (
             item_type, item_id, payload, payload_state, clock, updated_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(item_type, item_id) DO UPDATE SET
             payload = excluded.payload,
             payload_state = excluded.payload_state,
             clock = excluded.clock,
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             corrupt_reason = NULL,
             corrupt_at = NULL",
        params![
            ITEM_TYPE,
            foreign_id,
            payload,
            sync_items::PAYLOAD_STATE_FULL,
            clock_value.to_string(),
            now_ms,
        ],
    )
    .map_err(failed)?;
    store::record_tombstone_clock(tx, ITEM_TYPE, foreign_id, clock, now_ms)?;
    outbox::enqueue(tx, &outbox::Change::delete(ITEM_TYPE, foreign_id), now_ms)?;
    Ok(())
}

fn crdt_failed(error: CrdtError) -> StorageError {
    match error {
        CrdtError::Storage { source } => source,
        other => StorageError::Failed {
            what: other.to_string(),
        },
    }
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}
