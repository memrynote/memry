//! The stage checks a staged pair passes before [`super::stage_vault_import`] returns `Staged`.
//! Numbering follows Step 37's report: 3, 7 and 8 are Step 37's. Check 1 covers every table
//! the report lists; checks 2 (id sets) and 5 (byte-equal ids, clocks and cursor) cover the
//! record tables imported so far ([`RECORD_TABLES`]) and the vault id, less the source rows a
//! queued or pending delete made tombstones, with the clocks the runtime-start replays minted;
//! check 4 holds the staged outbox to the source's queued record pushes and Electron's
//! runtime-start replays ([`replay`]). Details name tables and counts, never ids or values.

use std::collections::{BTreeMap, HashSet};

use memry_core::storage::import::{ImportQueued, ImportWriter};
use memry_core::sync::clock::VectorClock;
use memry_core::sync::outbox::RecordOp;

use super::source::{Sources, source_error};
use super::tables::SourceDb;
use super::tables::queue::{self, Disposition};
use super::tables::records::parse_clock;
use super::tables::replay;
use super::{FoldedDoc, ImportError, VaultStageReport, docs, read_source_id};

/// `(source table, id column, core item type, rows of the type)` of every imported record table
/// with a clock. `note_metadata` holds notes and journal days in one table.
pub const RECORD_TABLES: &[(&str, &str, &str, &str)] = &[
    ("folder_configs", "path", "folder_config", "1"),
    ("property_definitions", "name", "property_definition", "1"),
    ("tag_categories", "id", "tag_category", "1"),
    ("tag_definitions", "name", "tag_definition", "1"),
    ("templates", "id", "template", "1"),
    ("custom_icons", "id", "custom_icon", "1"),
    ("note_metadata", "id", "note", "journal_date IS NULL"),
    ("note_metadata", "id", "journal", "journal_date IS NOT NULL"),
];

pub(super) fn run(
    report: &mut VaultStageReport,
    sources: &Sources,
    writer: &ImportWriter,
    device_id: Option<&str>,
    folded: &[FoldedDoc],
    now_ms: i64,
) -> Result<(), ImportError> {
    row_counts(report)?;
    report.checks_passed.push(1);
    let source = sources.conn(SourceDb::Data);
    // Every record push the import queues, in the order it queues them.
    let mut planned: Vec<ImportQueued> = queue::plan(source, writer, device_id)?
        .into_iter()
        .filter_map(|(_, disposition)| match disposition {
            Disposition::Enqueue(item) => Some(item),
            Disposition::Drop(_) => None,
        })
        .collect();
    planned.extend(replay::plan_deletes(source, writer, device_id, now_ms)?.queued);
    let runtime = replay::plan_runtime_start(source, writer, device_id, now_ms)?;
    planned.extend(runtime.queued);
    let tombstoned: HashSet<(&str, &str)> = planned
        .iter()
        .filter(|item| item.tombstone.is_some())
        .map(|item| (item.item_type.as_str(), item.item_id.as_str()))
        .collect();
    let mut clock_mismatches = Vec::new();
    for (table, id_column, item_type, rows) in RECORD_TABLES {
        let mut expected = source_clocks(source, table, id_column, rows)?;
        expected.retain(|id, _| !tombstoned.contains(&(*item_type, id.as_str())));
        // A clock the replays minted replaces the source's (none, or a never-synced one).
        for (id, clock) in expected.iter_mut() {
            if let Some(minted) = runtime.minted.get(&((*item_type).to_owned(), id.clone())) {
                *clock = Some(minted.clone());
            }
        }
        let staged: BTreeMap<String, Option<String>> =
            writer.record_clocks(item_type)?.into_iter().collect();
        if !expected.keys().eq(staged.keys()) {
            let missing = expected
                .keys()
                .filter(|id| !staged.contains_key(*id))
                .count();
            let extra = staged
                .keys()
                .filter(|id| !expected.contains_key(*id))
                .count();
            return Err(ImportError::CheckFailed {
                check: 2,
                detail: format!(
                    "{table}: {missing} source ids missing, {extra} ids not in the source"
                ),
            });
        }
        let differ = expected
            .iter()
            .filter(|(id, clock)| staged[*id] != **clock)
            .count();
        if differ > 0 {
            clock_mismatches.push(format!(
                "{table}: {differ} clocks differ from the source text"
            ));
        }
    }
    report.checks_passed.push(2);
    let bodies = docs::planned_body_pushes(source, folded)?;
    outbox(&planned, bodies, writer)?;
    report.checks_passed.push(4);
    if source_vault_id(source)? != writer.vault_id()? {
        clock_mismatches.push("vault_metadata: the core vault id is not the source uuid".into());
    }
    if !clock_mismatches.is_empty() {
        return Err(ImportError::CheckFailed {
            check: 5,
            detail: clock_mismatches.join("; "),
        });
    }
    report.checks_passed.push(5);
    let problems = writer.integrity_problems()?;
    if !problems.is_empty() {
        return Err(ImportError::CheckFailed {
            check: 6,
            detail: problems.join("; "),
        });
    }
    report.checks_passed.push(6);
    Ok(())
}

/// Check 4: the staged outbox holds exactly what `outbox::enqueue` leaves of the planned record
/// pushes (per `(type, id)` the last op wins, and an upsert over a queued create stays a create),
/// one CRDT row per body push (`docs`), and nothing else. A local-only note's push is withheld by
/// the outbox itself. A create or upsert whose record has no clock the core push sends fails too:
/// the push would retire it unsent.
fn outbox(
    planned: &[ImportQueued],
    bodies: Vec<memry_core::storage::import::ImportBodyPush>,
    writer: &ImportWriter,
) -> Result<(), ImportError> {
    let mut expected_bodies = Vec::new();
    for push in bodies {
        // An in-flight push of a gone note is skipped (`docs::note_body_sync`).
        if writer.body_owner(&push.doc_id)?.is_some() && !writer.is_local_only_note(&push.doc_id)? {
            expected_bodies.push(push.doc_id);
        }
    }
    let (mut staged_bodies, mut staged): (Vec<_>, Vec<_>) = writer
        .outbox_rows()?
        .into_iter()
        .partition(|(_, _, op)| op == memry_core::sync::outbox::OP_CRDT_UPDATE);
    let mut staged_bodies: Vec<String> = staged_bodies.drain(..).map(|(_, id, _)| id).collect();
    expected_bodies.sort();
    staged_bodies.sort();
    if expected_bodies != staged_bodies {
        return Err(ImportError::CheckFailed {
            check: 4,
            detail: format!(
                "outbox: {} body pushes queued, {} expected",
                staged_bodies.len(),
                expected_bodies.len()
            ),
        });
    }
    let mut collapsed: BTreeMap<(String, String), RecordOp> = BTreeMap::new();
    for item in planned {
        if item.item_type == "note" && writer.is_local_only_note(&item.item_id)? {
            continue;
        }
        let key = (item.item_type.clone(), item.item_id.clone());
        let op = match collapsed.get(&key) {
            Some(RecordOp::Create) if item.op == RecordOp::Upsert => RecordOp::Create,
            _ => item.op,
        };
        collapsed.insert(key, op);
    }
    let mut unclocked = 0;
    for ((item_type, item_id), op) in &collapsed {
        if *op != RecordOp::Delete && !sends_clock(writer, item_type, item_id)? {
            unclocked += 1;
        }
    }
    if unclocked > 0 {
        return Err(ImportError::CheckFailed {
            check: 4,
            detail: format!("outbox: {unclocked} queued pushes have no clock the push sends"),
        });
    }
    let mut expected: Vec<(String, String, String)> = collapsed
        .into_iter()
        .map(|((item_type, item_id), op)| (item_type, item_id, op.as_str().to_owned()))
        .collect();
    expected.sort();
    staged.sort();
    if expected != staged {
        let missing = expected.iter().filter(|row| !staged.contains(row)).count();
        let extra = staged.iter().filter(|row| !expected.contains(row)).count();
        return Err(ImportError::CheckFailed {
            check: 4,
            detail: format!(
                "outbox: {missing} queued pushes missing, {extra} rows not in the source queue"
            ),
        });
    }
    Ok(())
}

/// Whether the live staged record carries a clock the core push sends ([`queue::usable`]).
fn sends_clock(writer: &ImportWriter, item_type: &str, item_id: &str) -> Result<bool, ImportError> {
    let Some(payload) = writer.record_payload(item_type, item_id)? else {
        return Ok(false);
    };
    let clock = serde_json::from_str::<serde_json::Value>(&payload)
        .ok()
        .and_then(|mut body| body.get_mut("clock").map(serde_json::Value::take))
        .and_then(|clock| serde_json::from_value::<VectorClock>(clock).ok());
    Ok(clock.is_some_and(|clock| queue::usable(&clock)))
}

/// Check 1: every `copy` and `convert` table wrote its source rows minus the named drops.
pub fn row_counts(report: &VaultStageReport) -> Result<(), ImportError> {
    for (name, table) in &report.tables {
        if table.class != "copy" && table.class != "convert" {
            continue;
        }
        if table.source_count.checked_sub(table.dropped) != Some(table.target_count) {
            return Err(ImportError::CheckFailed {
                check: 1,
                detail: format!(
                    "{name}: {} source rows, {} dropped, {} written",
                    table.source_count, table.dropped, table.target_count
                ),
            });
        }
    }
    Ok(())
}

/// Source id to clock text, where the clock reads as one (`parse_clock`): the exact string the
/// staged `sync_items.clock` must equal.
fn source_clocks(
    source: &rusqlite::Connection,
    table: &'static str,
    id_column: &str,
    rows: &str,
) -> Result<BTreeMap<String, Option<String>>, ImportError> {
    let mut stmt = source
        .prepare(&format!(
            "SELECT rowid, {id_column}, clock FROM {table} WHERE {rows}"
        ))
        .map_err(|e| source_error(SourceDb::Data, e))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| source_error(SourceDb::Data, e))?;
    let mut clocks = BTreeMap::new();
    while let Some(row) = rows.next().map_err(|e| source_error(SourceDb::Data, e))? {
        let rowid: i64 = row
            .get("rowid")
            .map_err(|e| source_error(SourceDb::Data, e))?;
        let id = read_source_id(row, SourceDb::Data, table, id_column)?;
        let text: Option<String> = row
            .get("clock")
            .map_err(|e| source_error(SourceDb::Data, e))?;
        let clock = parse_clock(text.as_deref(), table, rowid)?.and(text);
        clocks.insert(id, clock);
    }
    Ok(clocks)
}

fn source_vault_id(source: &rusqlite::Connection) -> Result<Option<String>, ImportError> {
    use rusqlite::OptionalExtension;
    source
        .query_row(
            "SELECT vault_uuid FROM vault_metadata WHERE id = 'singleton'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| source_error(SourceDb::Data, e))
}
