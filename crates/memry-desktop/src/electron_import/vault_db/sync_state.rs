//! Every Electron `sync_state` key and where it goes. A key the list does not match is a key of
//! a newer Electron: Electron never refuses one, so the import reports it
//! (`unknownSyncStateKeys`) and carries on. Keys come from `SYNC_STATE_KEYS`
//! (`sync/engine/sync-context.ts`) over Electron's history, plus the per-item prefixes written
//! outside it.
//!
//! The `sync_state` table's importer ([`import`]) reads every row: a carried key's handler
//! parses its value as Electron reads it into [`ImportSyncState`], which the core writes in one
//! transaction (`storage::import::sync_state` names each key's core owner). Stage check 5
//! re-plans the source and compares the staged state ([`mismatches`]).

use std::collections::BTreeMap;

use memry_core::protocol::types::Declaration;
use memry_core::storage::import::{
    ImportQuarantined, ImportRecordCursor, ImportRefused, ImportSyncState, ImportWriter,
};
use rusqlite::Connection;
use rusqlite::types::ValueRef;
use serde::Deserialize;
use serde_json::Value;

use super::source::source_error;
use super::tables::records::malformed;
use super::tables::{SourceDb, TableStats, pending_area};
use super::{ImportError, TableCtx, read_source_id};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyMatch {
    Exact(&'static str),
    /// The prefix followed by at least one character (a note or item id).
    Prefix(&'static str),
}

/// What a handler did with its key's row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Carried {
    Written,
    /// Not carried, for the named reason; the core reads the key's state as absent.
    Dropped(&'static str),
}

/// Parses one key's value into the plan, as Electron reads it.
pub type KeyFn = fn(&mut SyncStatePlan, &str) -> Carried;

/// What the import does with a key. A key that carries data names its handler, or the stage that
/// writes it, so a carried key without either cannot be written.
#[derive(Debug, Clone, Copy)]
pub enum KeyRule {
    /// Dropped into the report.
    Skip { reason: &'static str },
    /// Carried by a handler the named stage writes; a source holding the key fails the import
    /// with [`ImportError::NotReady`].
    Pending {
        stage: &'static str,
        reason: &'static str,
    },
    /// Carried by `handler`, which the `sync_state` table's importer runs per key.
    Convert {
        handler: KeyFn,
        reason: &'static str,
    },
}

#[derive(Debug, Clone, Copy)]
pub struct SyncStateKey {
    pub key: KeyMatch,
    pub rule: KeyRule,
}

impl SyncStateKey {
    fn matches(&self, key: &str) -> bool {
        match self.key {
            KeyMatch::Exact(exact) => key == exact,
            KeyMatch::Prefix(prefix) => key.len() > prefix.len() && key.starts_with(prefix),
        }
    }

    /// The report line a dropped key counts under: the key, or the prefix of a prefixed key.
    pub fn report_name(&self) -> &'static str {
        match self.key {
            KeyMatch::Exact(key) | KeyMatch::Prefix(key) => key,
        }
    }
}

const fn convert(key: KeyMatch, handler: KeyFn, reason: &'static str) -> SyncStateKey {
    SyncStateKey {
        key,
        rule: KeyRule::Convert { handler, reason },
    }
}

/// A key the documents carry (36c4).
const fn document(key: KeyMatch, reason: &'static str) -> SyncStateKey {
    SyncStateKey {
        key,
        rule: KeyRule::Pending {
            stage: "36c4",
            reason,
        },
    }
}

const fn skip(key: KeyMatch, reason: &'static str) -> SyncStateKey {
    SyncStateKey {
        key,
        rule: KeyRule::Skip { reason },
    }
}

use KeyMatch::{Exact, Prefix};

pub const SYNC_STATE_KEYS: &[SyncStateKey] = &[
    convert(
        Exact("lastCursor"),
        last_cursor,
        "sync_cursors scope record, with the desktop declaration and first_sync.completed",
    ),
    skip(
        Exact("lastSyncAt"),
        "session status; Electron clears it per session and core keeps it in memory",
    ),
    convert(
        Exact("syncPaused"),
        sync_paused,
        "Step 17 pause state (meta sync.paused): a paused vault stays paused",
    ),
    skip(
        Exact("initialSeedDone"),
        "gates nothing: Electron's runInitialSeed seeds every unclocked row whatever the flag \
         (initial-seed.ts:23-31), and so does the import's runtime-start seed (36c2)",
    ),
    convert(
        Exact("quarantinedItems"),
        quarantined_items,
        "Step 17 sync_quarantine ledger, reasons kept",
    ),
    convert(
        Exact("schemaInvalidItems"),
        schema_invalid_items,
        "Step 17 sync_refused_items; refetched on the first pull, kind kept",
    ),
    convert(
        Exact("cursorSkipRepair"),
        cursor_skip_repair,
        "meta sync.cursor_skip_repair, the same three states",
    ),
    skip(
        Exact("noteBodyFeedCursor"),
        "core pulls per document and defines no note body feed cursor",
    ),
    skip(
        Exact("noteBodyLegacySweep"),
        "core pulls per document and runs no legacy note body sweep",
    ),
    convert(
        Exact("packsAppliedThroughCursor"),
        packs_applied_through,
        "Step 17 pack_bootstrap applied-through cursor",
    ),
    skip(
        Exact("packSeedSettlePending"),
        "pack seed settling is Electron's; dropped with a report line",
    ),
    skip(
        Prefix("packSeeded:"),
        "pack seed settling is Electron's; dropped with a report line",
    ),
    skip(
        Exact("lastManifestCheckAt"),
        "throttle only: the next manifest check runs early",
    ),
    skip(
        Exact("crdtStoreEpoch"),
        "store and database come from one snapshot, nothing left to mismatch",
    ),
    skip(
        Exact("crdtBodyDebtMirrorAt"),
        "store and database come from one snapshot, nothing left to mismatch",
    ),
    document(
        Exact("crdtUnmergedDebt"),
        "marks every document owed as a core body debt",
    ),
    skip(
        Exact("lastCrdtSweepAt"),
        "retired in #2421; the row stays only for older Electron builds",
    ),
    document(
        Prefix("journalDayMerge:"),
        "an owed journal day merge (sync/journal-day-merge.ts); destination set by 36c4",
    ),
    document(
        Prefix("note-cover:"),
        "an owed note cover sync marker (item-handlers/note-cover-sync.ts); destination set by 36c4",
    ),
];

pub fn classify(key: &str) -> Option<&'static SyncStateKey> {
    SYNC_STATE_KEYS.iter().find(|rule| rule.matches(key))
}

/// The cap on a carried value, checked before it is parsed.
pub const MAX_VALUE_BYTES: usize = 8 * 1024 * 1024;

/// The sync state the source holds and the row counts of the `sync_state` table.
#[derive(Debug, Default)]
pub struct SyncStatePlan {
    pub state: ImportSyncState,
    pub stats: TableStats,
}

const TABLE: &str = "sync_state";

/// Reads every `sync_state` row. Pure: stage check 5 runs it again.
pub fn plan(source: &Connection) -> Result<SyncStatePlan, ImportError> {
    let db = SourceDb::Data;
    let mut plan = SyncStatePlan::default();
    let mut stmt = source
        .prepare("SELECT rowid, key, value FROM sync_state ORDER BY key")
        .map_err(|e| source_error(db, e))?;
    let mut rows = stmt.query([]).map_err(|e| source_error(db, e))?;
    while let Some(row) = rows.next().map_err(|e| source_error(db, e))? {
        let rowid: i64 = row.get("rowid").map_err(|e| source_error(db, e))?;
        let key = read_source_id(row, db, TABLE, "key")?;
        let carried = match classify(&key) {
            None => {
                // A newer Electron's key. The name before any `:` only: a prefixed key ends in
                // an item id.
                let name = key.split(':').next().unwrap_or_default();
                tracing::warn!(
                    key = name,
                    "the vault import does not know a sync_state key"
                );
                Carried::Dropped("unknownSyncStateKeys")
            }
            Some(rule) => match rule.rule {
                KeyRule::Skip { .. } => Carried::Dropped(rule.report_name()),
                KeyRule::Pending { stage, .. } => {
                    return Err(ImportError::NotReady {
                        area: pending_area(stage).unwrap_or("data"),
                        detail: format!("sync_state key {key} ({stage})"),
                    });
                }
                KeyRule::Convert { handler, .. } => {
                    let value = match row.get_ref("value").map_err(|e| source_error(db, e))? {
                        ValueRef::Text(bytes) => std::str::from_utf8(bytes)
                            .map_err(|_| malformed(TABLE, rowid, "a value that is not UTF-8"))?,
                        _ => return Err(malformed(TABLE, rowid, "a value that is not text")),
                    };
                    if value.len() > MAX_VALUE_BYTES {
                        return Err(malformed(TABLE, rowid, "a value is over 8 MiB"));
                    }
                    handler(&mut plan, value)
                }
            },
        };
        match carried {
            Carried::Written => plan.stats.written += 1,
            Carried::Dropped(reason) => plan.stats.dropped.push((reason, 1)),
        }
    }
    Ok(plan)
}

/// The `sync_state` table's importer.
pub fn import(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    let plan = plan(ctx.source)?;
    ctx.writer.put_sync_state(&plan.state, ctx.now_ms)?;
    Ok(plan.stats)
}

/// Stage check 5's part: what differs between the staged sync state and the source's, by field.
pub fn mismatches(source: &Connection, writer: &ImportWriter) -> Result<Vec<String>, ImportError> {
    let planned = plan(source)?.state;
    let staged = writer.staged_sync_state()?;
    let differ = [
        ("cursor", planned.record_cursor != staged.record_cursor),
        (
            "cursor repair",
            planned.cursor_skip_repair != staged.cursor_skip_repair,
        ),
        ("pause", planned.paused != staged.paused),
        (
            "pack watermark",
            planned.packs_applied_through != staged.packs_applied_through,
        ),
        ("quarantine", planned.quarantined != staged.quarantined),
        ("refused items", planned.refused != staged.refused),
    ];
    Ok(differ
        .into_iter()
        .filter(|(_, differs)| *differs)
        .map(|(field, _)| format!("sync_state: the staged {field} differs from the source"))
        .collect())
}

/// Electron reads `Number(lastCursor)`; a value that is no non-negative integer is not carried,
/// so the core reads the feed from the start.
fn last_cursor(plan: &mut SyncStatePlan, value: &str) -> Carried {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Carried::Dropped("unreadableLastCursor");
    }
    let Ok(cursor) = value.parse::<i64>() else {
        return Carried::Dropped("unreadableLastCursor");
    };
    plan.state.record_cursor = Some(ImportRecordCursor {
        cursor: cursor.to_string(),
        // Electron advanced the cursor under `SYNC_TYPES_HEADER_VALUE`, which is byte for byte
        // the desktop declaration (`protocol/types.rs`).
        declaration: Declaration::desktop().header_value(),
    });
    Carried::Written
}

/// `setPaused` writes `'true'` or `'false'`; `isPaused` is `=== 'true'`.
fn sync_paused(plan: &mut SyncStatePlan, value: &str) -> Carried {
    plan.state.paused = value == "true";
    Carried::Written
}

/// `done` and `pending:<cursor>` carry; anything else Electron reads as not started, which the
/// core does for an absent key.
fn cursor_skip_repair(plan: &mut SyncStatePlan, value: &str) -> Carried {
    let pending = value
        .strip_prefix("pending:")
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    if value != "done" && !pending {
        return Carried::Dropped("unreadableCursorSkipRepair");
    }
    plan.state.cursor_skip_repair = Some(value.to_owned());
    Carried::Written
}

/// A missing or unreadable watermark reads as 0 in both apps.
fn packs_applied_through(plan: &mut SyncStatePlan, value: &str) -> Carried {
    match value.parse::<i64>() {
        Ok(watermark) => {
            plan.state.packs_applied_through = Some(watermark);
            Carried::Written
        }
        Err(_) => Carried::Dropped("unreadablePacksAppliedThroughCursor"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuarantineEntry {
    item_id: String,
    item_type: String,
    signer_device_id: String,
    failed_at: i64,
    attempt_count: i64,
    last_error: String,
}

/// `QuarantineManager.loadState`: `{v, entries}`; the id-keyed v1 array is discarded. A later
/// entry of the same `(type, id)` replaces an earlier one, as the map does. Expired entries are
/// carried: the core expires them by `failed_at` as Electron's load does.
fn quarantined_items(plan: &mut SyncStatePlan, value: &str) -> Carried {
    let entries = match serde_json::from_str::<Value>(value) {
        Ok(Value::Array(_)) => return Carried::Dropped("legacyQuarantineState"),
        Ok(Value::Object(mut state)) => match state.remove("entries") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(entries)) => entries,
            Some(_) => return Carried::Dropped("unreadableQuarantineState"),
        },
        _ => return Carried::Dropped("unreadableQuarantineState"),
    };
    let mut kept = BTreeMap::new();
    let mut unreadable: u64 = 0;
    for entry in entries {
        match serde_json::from_value::<QuarantineEntry>(entry) {
            Ok(e) => {
                kept.insert(
                    (e.item_type.clone(), e.item_id.clone()),
                    ImportQuarantined {
                        item_type: e.item_type,
                        item_id: e.item_id,
                        signer_device_id: e.signer_device_id,
                        failed_at: e.failed_at,
                        attempt_count: e.attempt_count,
                        last_error: e.last_error,
                    },
                );
            }
            Err(_) => unreadable += 1,
        }
    }
    if unreadable > 0 {
        plan.stats
            .notices
            .push(("unreadableQuarantineEntries", unreadable));
    }
    plan.state.quarantined = kept.into_values().collect();
    Carried::Written
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LedgerEntry {
    id: String,
    #[serde(rename = "type")]
    item_type: String,
    #[serde(default)]
    kind: Value,
    last_refused_by_version: String,
    failed_at: i64,
}

/// `SchemaInvalidLedger.read`: a JSON object of entries; one that does not parse is dropped, and
/// a kind it does not know reads as `payload`. The refusing version names Electron's app and the
/// kind, so the core build never matches it and the first pull past the cooldown refetches the
/// item, as Electron does once another app version runs.
fn schema_invalid_items(plan: &mut SyncStatePlan, value: &str) -> Carried {
    let Ok(Value::Object(entries)) = serde_json::from_str::<Value>(value) else {
        return Carried::Dropped("unreadableSchemaInvalidState");
    };
    let mut kept = BTreeMap::new();
    let mut unreadable: u64 = 0;
    for (_, entry) in entries {
        let Ok(e) = serde_json::from_value::<LedgerEntry>(entry) else {
            unreadable += 1;
            continue;
        };
        let kind = e
            .kind
            .as_str()
            .filter(|kind| ["payload", "envelope", "blob_missing", "pending_intent"].contains(kind))
            .unwrap_or("payload");
        kept.insert(
            (e.item_type.clone(), e.id.clone()),
            ImportRefused {
                item_type: e.item_type,
                item_id: e.id,
                refused_by_version: format!("electron {} {kind}", e.last_refused_by_version),
                refused_at: e.failed_at,
            },
        );
    }
    if unreadable > 0 {
        plan.stats
            .notices
            .push(("unreadableSchemaInvalidEntries", unreadable));
    }
    plan.state.refused = kept.into_values().collect();
    Carried::Written
}

#[cfg(test)]
#[path = "sync_state_tests.rs"]
mod tests;
