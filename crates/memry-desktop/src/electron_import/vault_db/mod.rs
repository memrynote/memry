//! One Electron vault database pair (`.memry/data.db`, `.memry/index.db`) into a verified core
//! pair under `<vault>/.memry/core/` (Step 36, #3553). Step 37 (#3554) calls
//! [`stage_vault_import`] once per vault, then [`StagedVault::install`].
//!
//! The Electron files are only ever read by `std::fs::copy` ([`source`]); SQLite opens the
//! copies. A run is a pure function of those files: a run that fails or crashes leaves at most
//! a staging directory, which the next run deletes and rebuilds. `install` renames the staged
//! pair into place, `data.db` last, and that rename is the commit point.
//!
//! Stage 36a ships the frame: staging, the preflight, the install order and the checks. The
//! importers arrive per owner area in 36b to 36f; until a table's importer exists, a source with
//! rows in it fails with [`ImportError::NotReady`] before anything is written.
//!
//! [`ProfileLock`] is a probe, not a lock: do not run two imports of one vault at once.

pub mod checks;
pub mod crash;
mod docs;
mod install;
mod journal_day_merges;
mod preflight;
mod source;
pub mod sync_state;
pub mod tables;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use memry_core::storage::import::{DATA_FILE, DocumentState, ImportWriter};
use rusqlite::Connection;
use serde::Serialize;
use zeroize::Zeroizing;

pub use super::ImportError;
use super::ProfileLock;
pub use source::read_source_id;
use tables::Importer;

/// The staging directory, beside `core/` under `<vault>/.memry/` so the install renames stay
/// on one file system. The vault watcher ignores it with every dot folder
/// (`vault/watch/filter.rs`).
pub const STAGING_DIR: &str = "core-import-tmp";
pub const CORE_DIR: &str = "core";

/// The local vault key Step 37 derives from the migrated master key.
pub type VaultKey = Zeroizing<[u8; 32]>;

pub struct VaultImportInput<'a> {
    /// Proof the probe found no running Electron. The run probes again before it copies the
    /// Electron files and before it returns [`StageOutcome::Staged`], and fails with
    /// [`ImportError::ProfileInUse`] when Electron started meanwhile.
    pub electron_closed: &'a ProfileLock,
    pub vault_dir: PathBuf,
    /// `vault_metadata.vault_uuid`, the id the core opens the vault under.
    pub vault_id: String,
    pub electron_data_db: PathBuf,
    pub electron_index_db: PathBuf,
    pub docs: Vec<FoldedDoc>,
    pub extra_owed_docs: Vec<String>,
    pub vault_key: Option<VaultKey>,
    /// `memry-config.json` `sync.deviceId` ([`crate::electron_import::ElectronConfig::device_id`]).
    /// A queued delete without a clock is stamped with it, as Electron's push does
    /// (`ensureRequiredClock`); without it such a delete fails
    /// [`ImportError::DeleteWithoutDevice`].
    pub electron_device_id: Option<String>,
    pub now_ms: i64,
    pub progress: Option<Box<dyn Fn(ImportProgress) + Send>>,
}

/// One Yjs document Step 37 read from the Electron store and folded to a single state.
pub struct FoldedDoc {
    pub doc_id: String,
    pub state: Vec<u8>,
    pub watermark: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportProgress {
    pub table: &'static str,
    pub done: usize,
    pub of: usize,
}

pub enum StageOutcome {
    Staged(Box<StagedVault>),
    /// `core/data.db` carries the import marker: an earlier run installed this vault.
    AlreadyImported,
    /// `core/data.db` exists without the marker: the vault was first opened natively. It is
    /// never replaced, and the Electron files stay as they are.
    NativeFirst,
}

/// A verified staged pair waiting for [`StagedVault::install`] or [`StagedVault::discard`].
pub struct StagedVault {
    paths: Paths,
    report: VaultStageReport,
}

impl StagedVault {
    pub fn report(&self) -> &VaultStageReport {
        &self.report
    }

    /// The staged document `doc_id` (state vector and canonical body text), for Step 37's check
    /// 3 against the folded Electron state; `None` when the import wrote no log for it.
    pub fn document_state(&self, doc_id: &str) -> Result<Option<DocumentState>, ImportError> {
        Ok(memry_core::storage::import::document_state(
            &self.paths.staging.join(DATA_FILE),
            doc_id,
        )?)
    }
}

/// What a run read and wrote. No secrets and no note text: counts and table names only.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStageReport {
    /// Keyed `<db>/<table>`, for every mapped table the source holds.
    pub tables: BTreeMap<String, TableReport>,
    /// Source rows or keys not carried over, by named reason.
    pub dropped: BTreeMap<String, u64>,
    /// Source rows carried over with less than the source held, by named reason.
    pub notices: BTreeMap<String, u64>,
    /// Pushes queued by Electron's runtime-start replays ([`tables::replay::runtime_start`]),
    /// by rule: `dirtyRecordsQueued`, `deletedNotesRecreated`.
    pub queued: BTreeMap<String, u64>,
    pub merged_tables: Vec<String>,
    pub checks_passed: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableReport {
    pub class: &'static str,
    pub source_count: u64,
    pub target_count: u64,
    pub dropped: u64,
}

/// What an importer of [`tables::TABLE_MAP`] reads from and writes to.
pub struct TableCtx<'a> {
    pub source: &'a Connection,
    /// The Electron `index.db` copy, which the note payload reads as Electron's push does.
    pub index: &'a Connection,
    /// The vault, whose note files the note payload reads as Electron's push does.
    pub vault_dir: &'a Path,
    /// [`VaultImportInput::vault_id`].
    pub vault_id: &'a str,
    pub writer: &'a mut ImportWriter,
    pub now_ms: i64,
    /// [`VaultImportInput::electron_device_id`].
    pub electron_device_id: Option<&'a str>,
    /// [`VaultImportInput::docs`].
    pub docs: &'a [FoldedDoc],
}

#[derive(Debug, Clone)]
struct Paths {
    memry: PathBuf,
    core: PathBuf,
    staging: PathBuf,
}

impl Paths {
    fn new(vault_dir: &Path) -> Self {
        let memry = vault_dir.join(".memry");
        Self {
            core: memry.join(CORE_DIR),
            staging: memry.join(STAGING_DIR),
            memry,
        }
    }
}

/// Stages one vault. See the module docs; [`StageOutcome`] names the three results.
pub fn stage_vault_import(input: VaultImportInput<'_>) -> Result<StageOutcome, ImportError> {
    let paths = Paths::new(&input.vault_dir);
    if let Some(outcome) = existing_core(&paths)? {
        if matches!(outcome, StageOutcome::NativeFirst) {
            install::restore_replaced_index(&paths)?;
        }
        remove_staging(&paths)?;
        return Ok(outcome);
    }
    remove_staging(&paths)?;
    fs::create_dir_all(&paths.staging).map_err(|e| ImportError::io(&paths.staging, e))?;
    // A failure discards the staging directory here, explicitly and not on drop, so a crash
    // point (a panic) leaves it behind the way a real crash would.
    match stage(&input, &paths) {
        Ok(report) => Ok(StageOutcome::Staged(Box::new(StagedVault {
            paths,
            report,
        }))),
        Err(error) => {
            if let Err(cleanup) = remove_staging(&paths) {
                tracing::warn!(%cleanup, "could not remove the import staging directory");
            }
            Err(error)
        }
    }
}

fn existing_core(paths: &Paths) -> Result<Option<StageOutcome>, ImportError> {
    let data = paths.core.join(DATA_FILE);
    match fs::symlink_metadata(&data) {
        // Only a regular file is opened: SQLite would follow a symlink and could create its
        // target.
        Ok(meta) if meta.is_file() => {
            return Ok(Some(
                match memry_core::storage::import::read_marker(&data)? {
                    Some(_) => StageOutcome::AlreadyImported,
                    None => StageOutcome::NativeFirst,
                },
            ));
        }
        Ok(_) => return Err(ImportError::CoreFileExists(data)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(ImportError::io(&data, e)),
    }
    // A native recovery moved `data.db` aside and has not opened the fresh one yet: still a
    // native core, whose salvage would let imported rows win over native ones.
    if memry_core::storage::recovery::pending_recovery(&data)?.is_some() {
        return Ok(Some(StageOutcome::NativeFirst));
    }
    // A marker naming no quarantine is no pending recovery, but install would refuse it: stop
    // here instead of staging a whole import that can never install.
    install::refuse_if_present(&memry_core::storage::recovery::marker_path(&data))?;
    // A WAL with no database beside it is no leftover of ours (install never writes one); it
    // may hold a native core's last writes, so it is reported and never deleted.
    for sidecar in install::sidecars(&data) {
        install::refuse_if_present(&sidecar)?;
    }
    Ok(None)
}

fn stage(input: &VaultImportInput<'_>, paths: &Paths) -> Result<VaultStageReport, ImportError> {
    memry_core::storage::vec::register()?;
    input.electron_closed.recheck()?;
    let sources = source::copy_sources(
        &input.electron_data_db,
        &input.electron_index_db,
        &paths.staging,
    )?;
    let preflight = preflight::run(&sources)?;
    let mut writer = ImportWriter::create(&paths.staging)?;
    crash::point("stage:writer-created");

    let mut report = VaultStageReport {
        ..VaultStageReport::default()
    };
    let total = preflight.tables.len();
    for (done, (mapping, source_count)) in preflight.tables.into_iter().enumerate() {
        let mut table = TableReport {
            class: mapping.class.as_str(),
            source_count,
            target_count: 0,
            dropped: 0,
        };
        match mapping.class.importer() {
            Some(Importer::Ready(import)) => {
                if let Some(progress) = &input.progress {
                    progress(ImportProgress {
                        table: mapping.table,
                        done,
                        of: total,
                    });
                }
                let mut ctx = TableCtx {
                    source: sources.conn(mapping.db),
                    index: sources.conn(tables::SourceDb::Index),
                    vault_dir: &input.vault_dir,
                    vault_id: &input.vault_id,
                    writer: &mut writer,
                    now_ms: input.now_ms,
                    electron_device_id: input.electron_device_id.as_deref(),
                    docs: &input.docs,
                };
                let stats = import(&mut ctx)?;
                table.target_count = stats.written;
                for (reason, count) in stats.dropped {
                    table.dropped += count;
                    *report.dropped.entry(reason.to_owned()).or_default() += count;
                }
                for (reason, count) in stats.notices {
                    *report.notices.entry(reason.to_owned()).or_default() += count;
                }
            }
            // The preflight refused a pending table with rows, so this one is empty.
            Some(Importer::Pending(_)) => {}
            None => table.dropped = source_count,
        }
        report
            .tables
            .insert(format!("{}/{}", mapping.db.name(), mapping.table), table);
    }

    let replayed = tables::replay::runtime_start(&mut TableCtx {
        source: sources.conn(tables::SourceDb::Data),
        index: sources.conn(tables::SourceDb::Index),
        vault_dir: &input.vault_dir,
        vault_id: &input.vault_id,
        writer: &mut writer,
        now_ms: input.now_ms,
        electron_device_id: input.electron_device_id.as_deref(),
        docs: &input.docs,
    })?;
    for (rule, count) in [
        ("dirtyRecordsQueued", replayed.dirty),
        ("deletedNotesRecreated", replayed.recreated),
    ] {
        if count > 0 {
            report.queued.insert(rule.to_owned(), count);
        }
    }
    docs::import_documents(
        input,
        sources.conn(tables::SourceDb::Data),
        sources.conn(tables::SourceDb::Index),
        &mut writer,
    )?;
    journal_day_merges::put_holders(
        sources.conn(tables::SourceDb::Data),
        &mut writer,
        input.now_ms,
    )?;
    checks::run(
        &mut report,
        &sources,
        &writer,
        input.electron_device_id.as_deref(),
        &input.docs,
        input.now_ms,
    )?;
    drop(sources);
    source::remove(&paths.staging)?;
    writer.finish(&marker(&report, input.now_ms))?;
    // A writer that opened after the copy and has not written yet slips past the copy's
    // fingerprint; Electron holds its locks while it runs, so this probe sees it.
    input.electron_closed.recheck()?;
    crash::point("stage:staged");
    Ok(report)
}

/// The `electron_import.v1` value: `{version, importedAt, tables, pending}`. `pending` lists
/// the tables this build could not import yet, all empty in the source (else the run fails
/// `NotReady`), so a later build can tell that nothing was owed.
fn marker(report: &VaultStageReport, now_ms: i64) -> String {
    let tables: BTreeMap<&str, u64> = report
        .tables
        .iter()
        .filter(|(_, t)| t.class == "copy" || t.class == "convert")
        .map(|(name, t)| (name.as_str(), t.target_count))
        .collect();
    let pending: Vec<String> = tables::TABLE_MAP
        .iter()
        .filter(|m| matches!(m.class.importer(), Some(Importer::Pending(_))))
        .map(|m| format!("{}/{}", m.db.name(), m.table))
        .collect();
    serde_json::json!({
        "version": 1,
        "importedAt": now_ms,
        "tables": tables,
        "pending": pending,
    })
    .to_string()
}

fn remove_staging(paths: &Paths) -> Result<(), ImportError> {
    match fs::remove_dir_all(&paths.staging) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ImportError::io(&paths.staging, e)),
    }
}

#[cfg(test)]
#[path = "../../../tests/support/electron_db.rs"]
mod electron_db;
#[cfg(test)]
mod tests;
