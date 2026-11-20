//! The stage checks a staged pair passes before [`super::stage_vault_import`] returns `Staged`.
//! Numbering follows Step 37's report: 3, 7 and 8 are Step 37's. Check 1 covers every table
//! the report lists; checks 2 (id sets) and 5 (byte-equal ids, clocks and cursor) arrive with
//! the 36b importers of the tables they compare; check 4 (outbox rows) with 36c.

use memry_core::storage::import::ImportWriter;

use super::{ImportError, VaultStageReport};

pub(super) fn run(report: &mut VaultStageReport, writer: &ImportWriter) -> Result<(), ImportError> {
    row_counts(report)?;
    report.checks_passed.push(1);
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
