//! `sync_tombstone_clocks` and the record rows of `sync_queue`: the delete clocks Electron keeps
//! for re-created ids, and the pushes it still owes the server. Both run after every record
//! table, because a queued push is planned against the staged records.
//!
//! A queued push becomes one core outbox row through `outbox::enqueue` (Step 17), which rebuilds
//! the payload from the live record at send time, as Electron's `resolvePushPayload` does
//! (`sync/engine/push-coordinator.ts`). `note_body` rows are the documents' (36c4); the
//! preflight refuses a source holding one.

use std::collections::{BTreeMap, HashSet};

use memry_core::storage::import::{
    ImportDeleted, ImportQueued, ImportTombstoneClock, ImportWriter,
};
use memry_core::sync::clock::{OFFLINE_CLOCK_DEVICE_ID, VectorClock};
use memry_core::sync::hardening::purged::RECREATABLE_AFTER_PURGE_ITEM_TYPES;
use memry_core::sync::outbox::RecordOp;
use rusqlite::Connection;
use serde_json::{Map, Value, json};

use super::records::{malformed, parse_clock, text};
use super::{SourceDb, TableStats};
use crate::electron_import::vault_db::source::source_error;
use crate::electron_import::vault_db::{ImportError, TableCtx, read_source_id};

/// `NOTE_BODY_QUEUE_TYPE` (`packages/sync-client/src/queue.ts`): a note's CRDT body rows.
pub const NOTE_BODY_TYPE: &str = "note_body";

/// `DEFAULT_MAX_ATTEMPTS` (`queue.ts`): a row past it is dead-lettered and Electron's
/// `dequeue` never returns it again.
const MAX_ATTEMPTS: i64 = 5;

/// A frozen delete body is a clock and two instants, or a record snapshot. One past this is no
/// payload Electron queued.
pub const MAX_DELETE_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;

const QUEUE: &str = "sync_queue";
const TOMBSTONES: &str = "sync_tombstone_clocks";

/// Notes and journals share `note_metadata`, so a queued note may be a journal day now.
pub(super) const NOTE_TYPES: [&str; 2] = ["note", "journal"];

/// `sync_tombstone_clocks`: copied, merged per id. Electron files notes and journals under one
/// `note` family; the core reads each type's own row, so a `note` row is written for both.
pub fn sync_tombstone_clocks(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    let mut rows = Vec::new();
    let mut written = 0;
    {
        let mut stmt = ctx
            .source
            .prepare("SELECT rowid, type, item_id, clock, updated_at FROM sync_tombstone_clocks")
            .map_err(|e| source_error(SourceDb::Data, e))?;
        let mut source = stmt
            .query([])
            .map_err(|e| source_error(SourceDb::Data, e))?;
        while let Some(row) = source.next().map_err(|e| source_error(SourceDb::Data, e))? {
            let rowid: i64 = row
                .get("rowid")
                .map_err(|e| source_error(SourceDb::Data, e))?;
            let item_type = read_source_id(row, SourceDb::Data, TOMBSTONES, "type")?;
            let item_id = read_source_id(row, SourceDb::Data, TOMBSTONES, "item_id")?;
            let clock = parse_clock(text(row, "clock")?.as_deref(), TOMBSTONES, rowid)?
                .ok_or_else(|| malformed(TOMBSTONES, rowid, "clock is null"))?;
            let clock = vector_clock(clock, TOMBSTONES, rowid)?;
            let updated_at = seconds_ms(row, "updated_at", TOMBSTONES, rowid)?;
            let types: Vec<String> = if item_type == "note" {
                NOTE_TYPES.iter().map(|t| (*t).to_owned()).collect()
            } else {
                vec![item_type]
            };
            for item_type in types {
                rows.push(ImportTombstoneClock {
                    item_type,
                    item_id: item_id.clone(),
                    clock: clock.clone(),
                    updated_at,
                });
            }
            written += 1;
        }
    }
    ctx.writer.put_tombstone_clocks(&rows)?;
    Ok(TableStats {
        written,
        ..TableStats::default()
    })
}

/// What happens to one folded queue item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Disposition {
    Enqueue(ImportQueued),
    /// Not queued, counted under the named reason.
    Drop(&'static str),
}

/// The `sync_queue` rows of one `(type family, id)`, folded as Electron's push coordinator
/// folds them (`coalesceSyncOperations`, oldest first).
#[derive(Debug, Clone)]
pub struct QueueItem {
    item_type: String,
    item_id: String,
    op: Folded,
    rows: u64,
    dead_letters: u64,
    enqueued_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Folded {
    Create,
    Update,
    /// The newest delete row's `rowid`, frozen body and `created_at` (ms).
    Delete {
        rowid: i64,
        payload: String,
        at: i64,
    },
}

/// Every queued record push of the source with what the import does with it, in Electron's
/// push order (`priority DESC, created_at ASC`). Stage check 4 runs the same plan against the
/// staged outbox.
/// `device_id` is Electron's, which stamps a delete without a clock.
pub fn plan(
    source: &Connection,
    writer: &ImportWriter,
    device_id: Option<&str>,
) -> Result<Vec<(QueueItem, Disposition)>, ImportError> {
    fold(source)?
        .into_iter()
        .map(|item| {
            let disposition = dispose(writer, &item, device_id)?;
            Ok((item, disposition))
        })
        .collect()
}

pub fn sync_queue(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    let plan = plan(ctx.source, ctx.writer, ctx.electron_device_id)?;
    let mut stats = TableStats::default();
    let mut dropped: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut queued = Vec::new();
    // Electron's `dequeue` skips these rows; the core outbox has no attempt cap, so a kept item
    // is pushed again. Counted over every item, dropped or kept.
    let dead_letters: u64 = plan.iter().map(|(item, _)| item.dead_letters).sum();
    for (item, disposition) in &plan {
        match disposition {
            Disposition::Enqueue(change) => queued.push((item, change.clone())),
            Disposition::Drop(reason) => *dropped.entry(reason).or_default() += item.rows,
        }
    }
    let changes: Vec<ImportQueued> = queued.iter().map(|(_, change)| change.clone()).collect();
    for ((item, _), was_queued) in queued.iter().zip(ctx.writer.put_outbox(&changes)?) {
        if was_queued {
            stats.written += item.rows;
        } else {
            *dropped.entry("localOnlyQueueRows").or_default() += item.rows;
        }
    }
    // Body pushes (36c4): one outbox row per `note_body` row, never collapsed.
    let pushes = crate::electron_import::vault_db::docs::queued_body_pushes(ctx.source, ctx.docs)?;
    for was_queued in ctx.writer.put_body_pushes(&pushes)? {
        match was_queued {
            true => stats.written += 1,
            false => *dropped.entry("localOnlyBodyRows").or_default() += 1,
        }
    }
    stats.dropped = dropped.into_iter().collect();
    if dead_letters > 0 {
        stats.notices.push(("deadLetterQueueRows", dead_letters));
    }
    Ok(stats)
}

/// The note and journal ids whose queued rows fold to a `create`: the pushes whose payload
/// carries the body (`note-handler-sync-helpers.ts`, `journal-handler.ts`). A note's rows stay
/// typed `note` after it became a journal day, so the two types fold together.
pub fn queued_creates(source: &Connection) -> Result<HashSet<String>, ImportError> {
    Ok(fold(source)?
        .into_iter()
        .filter(|item| NOTE_TYPES.contains(&item.item_type.as_str()) && item.op == Folded::Create)
        .map(|item| item.item_id)
        .collect())
}

/// Electron's `coalesceSyncOperations` (`packages/sync-client/src/queue.ts`): a later delete
/// wins; otherwise an unacked create survives.
fn coalesce(existing: &'static str, incoming: &'static str) -> &'static str {
    if incoming == "delete" {
        "delete"
    } else if existing == "create" || incoming == "create" {
        "create"
    } else {
        incoming
    }
}

fn fold(source: &Connection) -> Result<Vec<QueueItem>, ImportError> {
    let mut stmt = source
        .prepare(
            "SELECT rowid, type, item_id, operation, payload, attempts, created_at
               FROM sync_queue WHERE type <> ?1
              ORDER BY priority DESC, created_at ASC, rowid ASC",
        )
        .map_err(|e| source_error(SourceDb::Data, e))?;
    let mut rows = stmt
        .query([NOTE_BODY_TYPE])
        .map_err(|e| source_error(SourceDb::Data, e))?;
    // Push order is per item's first row; the fold itself runs oldest first.
    let mut order: Vec<(String, String)> = Vec::new();
    let mut by_key: BTreeMap<(String, String), Vec<QueueRow>> = BTreeMap::new();
    while let Some(row) = rows.next().map_err(|e| source_error(SourceDb::Data, e))? {
        let rowid: i64 = row
            .get("rowid")
            .map_err(|e| source_error(SourceDb::Data, e))?;
        let item_type = read_source_id(row, SourceDb::Data, QUEUE, "type")?;
        let item_id = read_source_id(row, SourceDb::Data, QUEUE, "item_id")?;
        let op = match text(row, "operation")?.as_deref() {
            Some("create") => "create",
            Some("update") => "update",
            Some("delete") => "delete",
            _ => {
                return Err(malformed(
                    QUEUE,
                    rowid,
                    "operation is not create, update or delete",
                ));
            }
        };
        let attempts: i64 = row
            .get("attempts")
            .map_err(|_| malformed(QUEUE, rowid, "attempts is not an integer"))?;
        let family = if NOTE_TYPES.contains(&item_type.as_str()) {
            NOTE_TYPES[0].to_owned()
        } else {
            item_type.clone()
        };
        let key = (family, item_id.clone());
        let queued = QueueRow {
            rowid,
            item_type,
            op,
            dead_letter: attempts >= MAX_ATTEMPTS,
            created_at: seconds_ms(row, "created_at", QUEUE, rowid)?,
            payload: (op == "delete")
                .then(|| text(row, "payload"))
                .transpose()?
                .flatten(),
        };
        let entry = by_key.entry(key.clone()).or_default();
        if entry.is_empty() {
            order.push(key);
        }
        entry.push(queued);
    }
    let mut items = Vec::with_capacity(order.len());
    for key in order {
        let mut group = by_key.remove(&key).unwrap_or_default();
        group.sort_by_key(|row| (row.created_at, row.rowid));
        let op = group
            .iter()
            .map(|row| row.op)
            .reduce(coalesce)
            .unwrap_or("update");
        let newest = &group[group.len() - 1];
        let op = match op {
            "create" => Folded::Create,
            "update" => Folded::Update,
            // A fold ends in a delete only when its newest row is one.
            _ => Folded::Delete {
                rowid: newest.rowid,
                payload: newest
                    .payload
                    .clone()
                    .ok_or_else(|| malformed(QUEUE, newest.rowid, "a delete has no payload"))?,
                at: newest.created_at,
            },
        };
        items.push(QueueItem {
            item_type: newest.item_type.clone(),
            item_id: key.1,
            op,
            rows: group.len() as u64,
            dead_letters: group.iter().filter(|row| row.dead_letter).count() as u64,
            enqueued_at: group[0].created_at,
        });
    }
    Ok(items)
}

struct QueueRow {
    rowid: i64,
    item_type: String,
    op: &'static str,
    dead_letter: bool,
    created_at: i64,
    payload: Option<String>,
}

fn dispose(
    writer: &ImportWriter,
    item: &QueueItem,
    device_id: Option<&str>,
) -> Result<Disposition, ImportError> {
    let types: Vec<&str> = if NOTE_TYPES.contains(&item.item_type.as_str()) {
        NOTE_TYPES.to_vec()
    } else {
        vec![item.item_type.as_str()]
    };
    let live = writer.live_record_type(&item.item_id, &types)?;
    let queued = |item_type: String, op: RecordOp, tombstone: Option<ImportDeleted>| {
        Disposition::Enqueue(ImportQueued {
            item_type,
            item_id: item.item_id.clone(),
            op,
            tombstone,
            minted: None,
            enqueued_at: item.enqueued_at,
        })
    };
    Ok(match (&item.op, live) {
        // #2423 (`pending-deletes.ts` `isSupersededByLiveRow`): the id of a re-creatable type is
        // live here again, and the row is what the user has. Another type keeps a soft-deleted
        // row under its id (`deleteTagCategory`), which says nothing about a re-create.
        (Folded::Delete { .. }, Some(item_type))
            if RECREATABLE_AFTER_PURGE_ITEM_TYPES.contains(&item_type.as_str()) =>
        {
            Disposition::Drop("staleQueueDeletes")
        }
        // A staged row of another type becomes the tombstone.
        (Folded::Delete { rowid, payload, at }, _) => {
            let (payload, clock) = delete_body(&item.item_id, payload, QUEUE, *rowid, device_id)?;
            queued(
                item.item_type.clone(),
                RecordOp::Delete,
                Some(ImportDeleted {
                    payload,
                    clock,
                    deleted_at: *at,
                }),
            )
        }
        // The push coordinator would send the frozen payload of a row gone locally; the core
        // outbox retires such a row unsent ("no live sync_items row at send time").
        (_, None) => Disposition::Drop("queueRowsWithoutRecord"),
        (Folded::Create, Some(item_type)) => queued(item_type, RecordOp::Create, None),
        (Folded::Update, Some(item_type)) => queued(item_type, RecordOp::Upsert, None),
    })
}

/// The body and clock a frozen delete is pushed with, as Electron's `ensureRequiredClock`
/// (`sync/engine/push-coordinator.ts`) sends it: a body that is no JSON object is rebuilt as
/// `{id, clock}`, and one without a clock the core push could send is stamped `{deviceId: 1}`.
pub(super) fn delete_body(
    item_id: &str,
    payload: &str,
    table: &'static str,
    rowid: i64,
    device_id: Option<&str>,
) -> Result<(String, VectorClock), ImportError> {
    if payload.len() > MAX_DELETE_PAYLOAD_BYTES {
        return Err(malformed(table, rowid, "a delete payload is over 8 MiB"));
    }
    let mut body = match serde_json::from_str::<Value>(payload) {
        Ok(Value::Object(body)) => body,
        _ => Map::from_iter([("id".to_owned(), Value::from(item_id))]),
    };
    if let Some(clock @ Value::Object(_)) = body.get("clock") {
        let clock = vector_clock(clock.clone(), table, rowid)?;
        if usable(&clock) {
            return Ok((payload.to_owned(), clock));
        }
    }
    let device_id = device_id.ok_or(ImportError::DeleteWithoutDevice)?;
    let clock = VectorClock::from([(device_id.to_owned(), 1)]);
    body.insert("clock".to_owned(), json!(clock));
    Ok((Value::Object(body).to_string(), clock))
}

/// Whether the core push sends `clock`: it drops `_offline: 0` and sends no clock for an empty
/// one (§6.6), and it retires a record or delete without one.
pub fn usable(clock: &VectorClock) -> bool {
    clock
        .iter()
        .any(|(device, ticks)| device != OFFLINE_CLOCK_DEVICE_ID || *ticks > 0)
}

pub(super) fn vector_clock(
    clock: Value,
    table: &'static str,
    rowid: i64,
) -> Result<VectorClock, ImportError> {
    serde_json::from_value(clock)
        .map_err(|_| malformed(table, rowid, "clock is not a vector clock"))
}

/// A drizzle `mode: 'timestamp'` column: epoch seconds, as ms.
pub(crate) fn seconds_ms(
    row: &rusqlite::Row<'_>,
    column: &str,
    table: &'static str,
    rowid: i64,
) -> Result<i64, ImportError> {
    row.get::<_, i64>(column)
        .ok()
        .and_then(|seconds| seconds.checked_mul(1000))
        .ok_or_else(|| malformed(table, rowid, "a timestamp is not epoch seconds"))
}
