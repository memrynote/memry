//! What Electron would queue at its next sync runtime start (`recoverDirtyItems`,
//! `apps/desktop/src/main/sync/dirty-recovery.ts`) and its next full sync (`runInitialSeed`,
//! `sync/initial-seed.ts`), for the record types imported so far:
//!
//! - the deletes it still owes the server (`sync_pending_deletes`, `flushPendingLocalDeletes` in
//!   `sync/local-mutations.ts`);
//! - the clocked rows edited since their last push (the dirty sweeps);
//! - the rows that never had a clock (`seedUnclocked` of each item handler).
//!
//! Each becomes the core outbox row Electron would queue, so no change it owes the server is lost
//! and no delete comes back. A later stage adds its types to [`delete_rule`] and [`KINDS`].

use std::collections::{BTreeMap, HashSet};

use memry_core::storage::import::{
    ImportDeleted, ImportQueued, ImportTombstoneClock, ImportWriter,
};
use memry_core::sync::clock::{self, VectorClock};
use memry_core::sync::hardening::purged::RECREATABLE_AFTER_PURGE_ITEM_TYPES;
use memry_core::sync::outbox::RecordOp;
use rusqlite::Connection;
use serde_json::{Map, Value, json};

use super::queue::{MAX_DELETE_PAYLOAD_BYTES, NOTE_TYPES, delete_body, seconds_ms, vector_clock};
use super::records::{malformed, parse_clock, text};
use super::{SourceDb, TableStats, js_json};
use crate::electron_import::vault_db::source::source_error;
use crate::electron_import::vault_db::{ImportError, TableCtx, read_source_id};

const PENDING: &str = "sync_pending_deletes";

/// How Electron's `flushPendingLocalDeletes` replays a pending delete of a type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteRule {
    /// Notes and journals: the body captured at delete time, as is (`enqueueRecoveredDelete`).
    Captured,
    /// The row snapshot with its clock ticked once under the device: the registry's
    /// `enqueueDelete` through `RecordSyncController.enqueueDelete` and `withIncrementedClock`.
    Snapshot,
    /// A type a later stage imports, with its own guards (an inbox local-only snapshot, a
    /// device-local calendar mirror).
    Later(&'static str),
}

/// The rule of every `LocalSyncType`; `None` for a type Electron does not have.
pub fn delete_rule(item_type: &str) -> Option<DeleteRule> {
    Some(match item_type {
        "note" | "journal" => DeleteRule::Captured,
        "folder_config"
        | "property_definition"
        | "tag_definition"
        | "tag_category"
        | "template"
        | "custom_icon" => DeleteRule::Snapshot,
        "settings" | "vault_lock" | "sticky_draft" | "agent_conversation" | "agent_message"
        | "canvas_folder" | "home_page" => DeleteRule::Later("36b"),
        "inbox"
        | "bookmark"
        | "calendar_event"
        | "calendar_source"
        | "calendar_binding"
        | "calendar_external_event" => DeleteRule::Later("36d1"),
        "task" | "project" | "filter" | "reminder" | "task_activity" => DeleteRule::Later("36d2"),
        "canvas" => DeleteRule::Later("36f"),
        _ => return None,
    })
}

/// The first pending delete whose type a later stage owns, as `(stage, type)`, for the preflight.
/// A type Electron does not have fails naming the row.
pub fn later_stage(source: &Connection) -> Result<Option<(&'static str, String)>, ImportError> {
    for (rowid, item_type) in typed_rows(source)? {
        match delete_rule(&item_type) {
            None => return Err(malformed(PENDING, rowid, "type is not a sync item type")),
            Some(DeleteRule::Later(stage)) => return Ok(Some((stage, item_type))),
            Some(_) => {}
        }
    }
    Ok(None)
}

fn typed_rows(source: &Connection) -> Result<Vec<(i64, String)>, ImportError> {
    let mut stmt = source
        .prepare("SELECT rowid, type FROM sync_pending_deletes ORDER BY rowid")
        .map_err(|e| source_error(SourceDb::Data, e))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| source_error(SourceDb::Data, e))?;
    let mut typed = Vec::new();
    while let Some(row) = rows.next().map_err(|e| source_error(SourceDb::Data, e))? {
        let rowid: i64 = row
            .get("rowid")
            .map_err(|e| source_error(SourceDb::Data, e))?;
        typed.push((rowid, read_source_id(row, SourceDb::Data, PENDING, "type")?));
    }
    Ok(typed)
}

/// The pending deletes as Electron replays them.
pub struct DeletePlan {
    pub queued: Vec<ImportQueued>,
    /// The ticked delete clocks Electron records again at the replay (`recordLocalDeleteClock`).
    pub tombstone_clocks: Vec<ImportTombstoneClock>,
    /// #2423: the id of a re-creatable type is live again, and the row is what the user has.
    pub stale: u64,
}

pub fn plan_deletes(
    source: &Connection,
    writer: &ImportWriter,
    device_id: Option<&str>,
    now_ms: i64,
) -> Result<DeletePlan, ImportError> {
    let mut plan = DeletePlan {
        queued: Vec::new(),
        tombstone_clocks: Vec::new(),
        stale: 0,
    };
    let mut stmt = source
        .prepare(
            "SELECT rowid, type, item_id, payload, created_at FROM sync_pending_deletes \
             ORDER BY rowid",
        )
        .map_err(|e| source_error(SourceDb::Data, e))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| source_error(SourceDb::Data, e))?;
    while let Some(row) = rows.next().map_err(|e| source_error(SourceDb::Data, e))? {
        let rowid: i64 = row
            .get("rowid")
            .map_err(|e| source_error(SourceDb::Data, e))?;
        let item_type = read_source_id(row, SourceDb::Data, PENDING, "type")?;
        let item_id = read_source_id(row, SourceDb::Data, PENDING, "item_id")?;
        let payload =
            text(row, "payload")?.ok_or_else(|| malformed(PENDING, rowid, "payload is null"))?;
        let deleted_at = seconds_ms(row, "created_at", PENDING, rowid)?;
        if payload.len() > MAX_DELETE_PAYLOAD_BYTES {
            return Err(malformed(PENDING, rowid, "a delete payload is over 8 MiB"));
        }
        let family: Vec<&str> = if NOTE_TYPES.contains(&item_type.as_str()) {
            NOTE_TYPES.to_vec()
        } else {
            vec![item_type.as_str()]
        };
        if RECREATABLE_AFTER_PURGE_ITEM_TYPES.contains(&item_type.as_str())
            && writer.live_record_type(&item_id, &family)?.is_some()
        {
            plan.stale += 1;
            continue;
        }
        let body = match delete_rule(&item_type) {
            Some(DeleteRule::Captured) => payload,
            Some(DeleteRule::Snapshot) => {
                let device_id = device_id.ok_or(ImportError::DeleteWithoutDevice)?;
                let (body, ticked) = with_incremented_clock(&payload, device_id, rowid)?;
                if let Some(ticked) = ticked
                    && RECREATABLE_AFTER_PURGE_ITEM_TYPES.contains(&item_type.as_str())
                {
                    plan.tombstone_clocks.push(ImportTombstoneClock {
                        item_type: item_type.clone(),
                        item_id: item_id.clone(),
                        clock: ticked,
                        updated_at: now_ms,
                    });
                }
                body
            }
            // The preflight refuses both before anything is written.
            Some(DeleteRule::Later(_)) | None => {
                return Err(malformed(PENDING, rowid, "type is not imported yet"));
            }
        };
        let (payload, clock) = delete_body(&item_id, &body, PENDING, rowid, device_id)?;
        plan.queued.push(ImportQueued {
            item_type,
            item_id,
            op: RecordOp::Delete,
            tombstone: Some(ImportDeleted {
                payload,
                clock,
                deleted_at,
            }),
            minted: None,
            enqueued_at: now_ms,
        });
    }
    Ok(plan)
}

/// Electron's `withIncrementedClock` (`packages/sync-core/src/record-sync.ts`): a body that is a
/// JSON object gets its clock ticked once under `device_id`, in place; any other body is left as
/// is (the push then rebuilds it, [`delete_body`]). Returns the ticked clock when there is one.
fn with_incremented_clock(
    payload: &str,
    device_id: &str,
    rowid: i64,
) -> Result<(String, Option<VectorClock>), ImportError> {
    let Ok(Value::Object(mut body)) = serde_json::from_str::<Value>(payload) else {
        return Ok((payload.to_owned(), None));
    };
    let current = match body.get("clock") {
        None | Some(Value::Null) => VectorClock::new(),
        Some(clock) => vector_clock(clock.clone(), PENDING, rowid)?,
    };
    let ticked = clock::increment(&current, device_id);
    body.insert("clock".to_owned(), json!(ticked));
    Ok((js_json::stringify(&Value::Object(body)), Some(ticked)))
}

pub fn sync_pending_deletes(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    let plan = plan_deletes(ctx.source, ctx.writer, ctx.electron_device_id, ctx.now_ms)?;
    ctx.writer.put_tombstone_clocks(&plan.tombstone_clocks)?;
    let mut stats = TableStats::default();
    for was_queued in ctx.writer.put_outbox(&plan.queued)? {
        if was_queued {
            stats.written += 1;
        } else {
            stats.dropped.push(("localOnlyPendingDeletes", 1));
        }
    }
    if plan.stale > 0 {
        stats.dropped.push(("stalePendingDeletes", plan.stale));
    }
    Ok(stats)
}

/// How a type's first clock is minted.
#[derive(Debug, Clone, Copy)]
enum Mint {
    /// `nextLocalClock(.., 'create')` (`packages/sync-client/src/tombstone-clocks.ts`): past the
    /// id's delete clock, for the re-creatable types.
    AfterTombstone,
    /// `increment({}, deviceId)`.
    First,
}

/// A dirty sweep of `dirty-recovery.ts`: clocked rows never pushed or `modified` since.
struct Dirty {
    rows: &'static str,
    modified: Option<&'static str>,
    /// `enqueueCreateOrRecoveredUpdate`: a never-synced row goes out as a create, which ticks its
    /// clock. Without it every dirty row is a recovered update at its stored clock.
    create_never_synced: bool,
}

/// One record type of the runtime-start pass.
struct Kind {
    item_type: &'static str,
    table: &'static str,
    id: &'static str,
    /// `seedUnclocked`'s filter of unclocked rows.
    seed: &'static str,
    mint: Mint,
    /// `seedSkipsDeletedNote`: an unclocked row with a delete clock is a leftover of the delete,
    /// unless this device's own pending delete of it was retired as superseded
    /// (`pushClocklessContentRecreate`).
    held_back_if_deleted: bool,
    /// `None`: exempt in `DIRTY_RECOVERY`.
    dirty: Option<Dirty>,
}

const NOTE_DIRTY: &str = "journal_date IS NULL AND local_only IS NOT 1";
const JOURNAL_DIRTY: &str = "journal_date IS NOT NULL AND local_only IS NOT 1";

const KINDS: &[Kind] = &[
    Kind {
        item_type: "note",
        table: "note_metadata",
        id: "id",
        seed: NOTE_DIRTY,
        mint: Mint::AfterTombstone,
        held_back_if_deleted: true,
        dirty: Some(Dirty {
            rows: NOTE_DIRTY,
            modified: Some("modified_at"),
            create_never_synced: false,
        }),
    },
    Kind {
        item_type: "journal",
        table: "note_metadata",
        id: "id",
        seed: "journal_date IS NOT NULL",
        mint: Mint::AfterTombstone,
        held_back_if_deleted: true,
        dirty: Some(Dirty {
            rows: JOURNAL_DIRTY,
            modified: Some("modified_at"),
            create_never_synced: false,
        }),
    },
    Kind {
        item_type: "folder_config",
        table: "folder_configs",
        id: "path",
        seed: "1",
        mint: Mint::AfterTombstone,
        held_back_if_deleted: false,
        dirty: None,
    },
    // `isPersistableDefinitionType`: older builds wrote unclocked `relation` rows that stay local.
    Kind {
        item_type: "property_definition",
        table: "property_definitions",
        id: "name",
        seed: "type IS NOT 'relation'",
        mint: Mint::AfterTombstone,
        held_back_if_deleted: false,
        dirty: None,
    },
    Kind {
        item_type: "tag_definition",
        table: "tag_definitions",
        id: "name",
        seed: "1",
        mint: Mint::AfterTombstone,
        held_back_if_deleted: false,
        dirty: None,
    },
    Kind {
        item_type: "tag_category",
        table: "tag_categories",
        id: "id",
        seed: "1",
        mint: Mint::First,
        held_back_if_deleted: false,
        dirty: None,
    },
    Kind {
        item_type: "template",
        table: "templates",
        id: "id",
        seed: "1",
        mint: Mint::First,
        held_back_if_deleted: false,
        dirty: Some(Dirty {
            rows: "1",
            modified: Some("modified_at"),
            create_never_synced: true,
        }),
    },
    Kind {
        item_type: "custom_icon",
        table: "custom_icons",
        id: "id",
        seed: "1",
        mint: Mint::First,
        held_back_if_deleted: false,
        dirty: Some(Dirty {
            rows: "1",
            modified: Some("updated_at"),
            create_never_synced: true,
        }),
    },
];

/// The dirty sweeps, then the seed of unclocked rows, in Electron's order.
#[derive(Default)]
pub struct RuntimeStart {
    pub queued: Vec<ImportQueued>,
    /// The clock text each minted record carries, by `(type, id)`, for stage check 5.
    pub minted: BTreeMap<(String, String), String>,
    pub dirty: u64,
    pub seeded: u64,
    pub held_back: u64,
}

pub fn plan_runtime_start(
    source: &Connection,
    writer: &ImportWriter,
    device_id: Option<&str>,
    now_ms: i64,
) -> Result<RuntimeStart, ImportError> {
    let mut plan = RuntimeStart::default();
    for kind in KINDS {
        if let Some(dirty) = &kind.dirty {
            plan_dirty(&mut plan, kind, dirty, source, writer, device_id, now_ms)?;
        }
    }
    let retired = retired_note_deletes(source, writer)?;
    for kind in KINDS {
        plan_seed(&mut plan, kind, &retired, source, writer, device_id, now_ms)?;
    }
    Ok(plan)
}

/// Queues the plan; returns the counts the report names.
pub fn runtime_start(ctx: &mut TableCtx<'_>) -> Result<RuntimeStart, ImportError> {
    let plan = plan_runtime_start(ctx.source, ctx.writer, ctx.electron_device_id, ctx.now_ms)?;
    ctx.writer.put_outbox(&plan.queued)?;
    Ok(plan)
}

fn plan_dirty(
    plan: &mut RuntimeStart,
    kind: &Kind,
    dirty: &Dirty,
    source: &Connection,
    writer: &ImportWriter,
    device_id: Option<&str>,
    now_ms: i64,
) -> Result<(), ImportError> {
    let since = dirty.modified.map_or(String::new(), |modified| {
        format!(" OR {modified} > synced_at")
    });
    let sql = format!(
        "SELECT rowid, {id} AS id, clock, synced_at IS NULL AS never FROM {table} \
         WHERE clock IS NOT NULL AND {rows} AND (synced_at IS NULL{since}) ORDER BY rowid",
        id = kind.id,
        table = kind.table,
        rows = dirty.rows,
    );
    for_each_row(source, &sql, |row, rowid| {
        let id = read_source_id(row, SourceDb::Data, kind.table, "id")?;
        // A pending delete made it a tombstone, and Electron's later delete wins the fold.
        if writer.live_record_type(&id, &[kind.item_type])?.is_none() {
            return Ok(());
        }
        let never: bool = row
            .get("never")
            .map_err(|e| source_error(SourceDb::Data, e))?;
        plan.dirty += 1;
        if dirty.create_never_synced && never {
            let device_id = device_id.ok_or(ImportError::ClockWithoutDevice)?;
            let stored = parse_clock(text(row, "clock")?.as_deref(), kind.table, rowid)?
                .map(|clock| vector_clock(clock, kind.table, rowid))
                .transpose()?
                .unwrap_or_default();
            // `recoverPendingChange` rebinds `_offline` ticks, then `applyLocalChange` ticks.
            let minted =
                clock::increment(&clock::rebind_clock_device(&stored, device_id), device_id);
            push_minted(plan, kind, id, minted, writer, now_ms)
        } else {
            // `enqueueRecoveredUpdate` at the stored clock; the core push rebinds `_offline`
            // under the same device (`seal.rs` `wire_clock`).
            plan.queued
                .push(queued(kind.item_type, id, RecordOp::Upsert, None, now_ms));
            Ok(())
        }
    })
}

fn plan_seed(
    plan: &mut RuntimeStart,
    kind: &Kind,
    retired: &HashSet<String>,
    source: &Connection,
    writer: &ImportWriter,
    device_id: Option<&str>,
    now_ms: i64,
) -> Result<(), ImportError> {
    let sql = format!(
        "SELECT rowid, {id} AS id FROM {table} WHERE clock IS NULL AND {seed} ORDER BY rowid",
        id = kind.id,
        table = kind.table,
        seed = kind.seed,
    );
    for_each_row(source, &sql, |row, _| {
        let id = read_source_id(row, SourceDb::Data, kind.table, "id")?;
        if writer.live_record_type(&id, &[kind.item_type])?.is_none() {
            return Ok(());
        }
        let tombstone = writer.tombstone_clock(kind.item_type, &id)?;
        if kind.held_back_if_deleted && tombstone.is_some() && !retired.contains(&id) {
            plan.held_back += 1;
            return Ok(());
        }
        let device_id = device_id.ok_or(ImportError::ClockWithoutDevice)?;
        let base = match kind.mint {
            Mint::AfterTombstone => tombstone.unwrap_or_default(),
            Mint::First => VectorClock::new(),
        };
        plan.seeded += 1;
        push_minted(
            plan,
            kind,
            id,
            clock::increment(&base, device_id),
            writer,
            now_ms,
        )
    })
}

/// The note-family ids whose pending delete the replay retires because the id is live again.
fn retired_note_deletes(
    source: &Connection,
    writer: &ImportWriter,
) -> Result<HashSet<String>, ImportError> {
    let mut retired = HashSet::new();
    for_each_row(
        source,
        "SELECT rowid, item_id FROM sync_pending_deletes WHERE type IN ('note', 'journal')",
        |row, _| {
            let id = read_source_id(row, SourceDb::Data, PENDING, "item_id")?;
            if writer.live_record_type(&id, &NOTE_TYPES)?.is_some() {
                retired.insert(id);
            }
            Ok(())
        },
    )?;
    Ok(retired)
}

/// A create carrying `minted` as the record's clock: the staged payload with its `clock` key
/// replaced in place or appended, as `JSON.stringify({ ...item, clock })`.
fn push_minted(
    plan: &mut RuntimeStart,
    kind: &Kind,
    id: String,
    minted: VectorClock,
    writer: &ImportWriter,
    now_ms: i64,
) -> Result<(), ImportError> {
    let stored = writer
        .record_payload(kind.item_type, &id)?
        .unwrap_or_default();
    let mut payload: Map<String, Value> = match serde_json::from_str(&stored) {
        Ok(Value::Object(payload)) => payload,
        _ => {
            return Err(ImportError::CheckFailed {
                check: 4,
                detail: format!("{}: a staged record is no JSON object", kind.table),
            });
        }
    };
    let text = serde_json::to_string(&minted).map_err(|e| ImportError::CheckFailed {
        check: 4,
        detail: format!("{}: a minted clock will not serialise: {e}", kind.table),
    })?;
    payload.insert("clock".to_owned(), json!(minted));
    plan.minted
        .insert((kind.item_type.to_owned(), id.clone()), text);
    plan.queued.push(queued(
        kind.item_type,
        id,
        RecordOp::Create,
        Some(js_json::stringify(&Value::Object(payload))),
        now_ms,
    ));
    Ok(())
}

fn queued(
    item_type: &str,
    item_id: String,
    op: RecordOp,
    minted: Option<String>,
    now_ms: i64,
) -> ImportQueued {
    ImportQueued {
        item_type: item_type.to_owned(),
        item_id,
        op,
        tombstone: None,
        minted,
        enqueued_at: now_ms,
    }
}

fn for_each_row(
    source: &Connection,
    sql: &str,
    mut each: impl FnMut(&rusqlite::Row<'_>, i64) -> Result<(), ImportError>,
) -> Result<(), ImportError> {
    let mut stmt = source
        .prepare(sql)
        .map_err(|e| source_error(SourceDb::Data, e))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| source_error(SourceDb::Data, e))?;
    while let Some(row) = rows.next().map_err(|e| source_error(SourceDb::Data, e))? {
        let rowid: i64 = row
            .get("rowid")
            .map_err(|e| source_error(SourceDb::Data, e))?;
        each(row, rowid)?;
    }
    Ok(())
}
