//! The stage checks a staged pair passes before [`super::stage_vault_import`] returns `Staged`.
//! Numbering follows Step 37's report: 3, 7 and 8 are Step 37's. Check 1 covers every table
//! the report lists; checks 2 (id sets) and 5 (byte-equal ids, clocks and cursor) cover the
//! record tables imported so far ([`RECORD_TABLES`]) and the vault id; check 4 (outbox rows)
//! arrives with 36c. Details name tables and counts, never ids or values.

use std::collections::BTreeMap;

use memry_core::storage::import::ImportWriter;

use super::source::{Sources, source_error};
use super::tables::SourceDb;
use super::tables::records::parse_clock;
use super::{ImportError, VaultStageReport, read_source_id};

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
) -> Result<(), ImportError> {
    row_counts(report)?;
    report.checks_passed.push(1);
    let source = sources.conn(SourceDb::Data);
    let mut clock_mismatches = Vec::new();
    for (table, id_column, item_type, rows) in RECORD_TABLES {
        let expected = source_clocks(source, table, id_column, rows)?;
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
