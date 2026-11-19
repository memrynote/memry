//! One planned vault of the vault phase: preparation (37e1), Step 36's stage, checks 3, 7 and 8,
//! then, once every vault of the run passed, `.memry/core` and the install. The report section
//! is saved after the preparation and after the stage, so a run cut off later finds what the
//! first attempt reported.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use memry_core::crdt::{DocumentRegistry, canonical_fragment};
use memry_core::domain::notes::identity::VAULT_ORIGIN_META_KEY;
use memry_core::storage::import::{DATA_FILE, DocumentState, INDEX_FILE, read_marker};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{Run, RunError};
use crate::electron_import::journal_replay::BulkApplyJournal;
use crate::electron_import::report::{VaultSection, VaultStatus};
use crate::electron_import::vault_db::{
    CORE_DIR, STAGING_DIR, StageOutcome, StagedVault, VaultImportInput, stage_vault_import,
};
use crate::electron_import::vault_prep::{
    DeferReason, Disposition, PlannedVault, PreparedVault, VaultId, VaultPlan, prepare_vault,
};
use crate::electron_import::{
    ElectronConfig, ElectronProfile, ImportError, ProfileLock, Scratch, YStoreReader,
};

/// What every vault of one run shares.
pub(super) struct VaultPhase<'a> {
    pub profile: &'a ElectronProfile,
    pub config: Option<&'a ElectronConfig>,
    pub plan: &'a VaultPlan,
    pub journal: Option<&'a BulkApplyJournal>,
    /// `crdt-pending-notes.json` ids, owed to the current vault only (Electron imports the
    /// file into the first vault it opens).
    pub pending_notes: &'a [String],
    pub scratch: &'a Scratch,
    pub lock: &'a ProfileLock,
    pub now_ms: i64,
}

/// The section of a vault that needs no import, or `None` for an importable one.
pub(super) fn settled_section(
    phase: &VaultPhase<'_>,
    vault: &PlannedVault,
) -> Option<VaultSection> {
    let mut section = VaultSection::new(&vault.path, VaultStatus::Deferred);
    match &vault.disposition {
        Disposition::Import(_) => return None,
        Disposition::Sandbox => section.status = VaultStatus::Sandbox,
        Disposition::SameFolder(first) => {
            section.status = VaultStatus::SameFolder;
            section.shared_with = vec![first.clone()];
        }
        Disposition::Unreadable(error) => {
            section.status = VaultStatus::Unreadable;
            section.detail = Some(error.to_string());
        }
        Disposition::Deferred(reason) => {
            section.reason = Some(defer_reason(*reason).to_owned());
            if *reason == DeferReason::SharedStore {
                section.shared_with = phase
                    .plan
                    .shared_stores
                    .iter()
                    .filter(|g| g.paths.contains(&vault.path))
                    .flat_map(|g| g.paths.iter().filter(|p| **p != vault.path).cloned())
                    .collect();
            }
        }
    }
    Some(section)
}

pub(super) fn defer_reason(reason: DeferReason) -> &'static str {
    match reason {
        DeferReason::FolderMissing => "folder-missing",
        DeferReason::DataDbMissing => "data-db-missing",
        DeferReason::DataDbUnreachable => "data-db-unreachable",
        DeferReason::SharedStore => "shared-store",
    }
}

pub(super) fn store_name(phase: &VaultPhase<'_>, id: &VaultId) -> String {
    YStoreReader::store_dir(phase.profile, &id.vault_id, phase.config)
        .file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
}

/// A vault staged and checked, waiting for every other vault of the run to pass too.
pub(super) struct PendingInstall {
    section: VaultSection,
    staged: StagedVault,
    prepared: PreparedVault,
}

pub(super) enum Staged {
    /// Nothing to install: imported by an earlier attempt, or opened natively first.
    Settled(Box<VaultSection>),
    Install(Box<PendingInstall>),
}

/// Stages one vault and runs checks 3, 7 and 8, saving its section into `run` as it goes.
/// Installs nothing.
pub(super) fn stage(
    run: &mut Run<'_>,
    phase: &VaultPhase<'_>,
    vault: &PlannedVault,
    id: &VaultId,
) -> Result<Staged, RunError> {
    let path = vault.path.as_str();
    let fail = |source: ImportError| RunError::Vault {
        vault: path.to_owned(),
        source,
    };
    let previous = run.section(path).cloned();
    // Taken before the copy: Electron writing after it makes the fingerprint stale, and the
    // later launch then shows the downgrade notice instead of missing the change.
    let fingerprint = source_fingerprint(Path::new(path)).map_err(fail)?;
    if let Some(done) = earlier_import(previous.as_ref(), path, &fingerprint) {
        return Ok(Staged::Settled(Box::new(done.map_err(fail)?)));
    }
    // An id minted by a cut-off attempt stays the vault's id.
    let id = &match previous.as_ref().and_then(|s| s.vault_id.clone()) {
        Some(vault_id) if id.minted => VaultId {
            vault_id,
            minted: true,
        },
        _ => id.clone(),
    };
    let mut prepared = prepare_vault(
        phase.profile,
        phase.config,
        path,
        id,
        phase.journal,
        phase.scratch,
    )
    .map_err(fail)?;
    let mut section = VaultSection::new(path, VaultStatus::Prepared);
    section.vault_id = Some(id.vault_id.clone());
    section.store = Some(store_name(phase, id));
    section.source_fingerprint = Some(fingerprint);
    // A rerun's replay reads the first attempt's writes as settled: the first report stands.
    section.prep = match previous.as_ref().and_then(|s| s.prep.clone()) {
        Some(prep) => Some(prep),
        None => Some(serde_json::to_value(prepared.report()).map_err(|_| fail(report_error()))?),
    };
    run.save_section(section.clone())?;

    let expected = prepared
        .fold
        .docs
        .iter()
        .map(|doc| Ok((doc.doc_id.clone(), folded_state(&doc.doc_id, &doc.state)?)))
        .collect::<Result<Vec<_>, ImportError>>()
        .map_err(fail)?;
    let mut owed = prepared.fold.owed_compactions.clone();
    if vault.current {
        owed.extend(phase.pending_notes.iter().cloned());
    }
    owed.sort();
    owed.dedup();
    let memry = prepared.dir.join(".memry");
    let input = VaultImportInput {
        electron_closed: phase.lock,
        vault_dir: prepared.dir.clone(),
        vault_id: id.vault_id.clone(),
        electron_data_db: memry.join("data.db"),
        electron_index_db: memry.join("index.db"),
        docs: std::mem::take(&mut prepared.fold.docs),
        extra_owed_docs: owed,
        vault_key: None,
        electron_device_id: phase
            .config
            .and_then(ElectronConfig::device_id)
            .map(str::to_owned),
        now_ms: phase.now_ms,
        progress: None,
    };
    let staged = match stage_vault_import(input).map_err(fail)? {
        StageOutcome::Staged(staged) => staged,
        // `earlier_import` removed every core this import wrote: this one is not ours.
        StageOutcome::AlreadyImported => {
            return Err(fail(ImportError::CoreFileExists(
                memry.join(CORE_DIR).join(DATA_FILE),
            )));
        }
        StageOutcome::NativeFirst => {
            section.status = VaultStatus::NativeFirst;
            return Ok(Staged::Settled(Box::new(section)));
        }
    };
    if let Err(error) = checks(&staged, &expected, &prepared, &mut section) {
        if let Err(discard) = staged.discard() {
            tracing::warn!(%discard, "could not remove the import staging directory");
        }
        return Err(fail(error));
    }
    section.stage = Some(serde_json::to_value(staged.report()).map_err(|_| fail(report_error()))?);
    section.status = VaultStatus::Staged;
    run.save_section(section.clone())?;
    Ok(Staged::Install(Box::new(PendingInstall {
        section,
        staged,
        prepared,
    })))
}

/// Stages and installs one vault: the import of a vault the run deferred.
pub(super) fn import(
    run: &mut Run<'_>,
    phase: &VaultPhase<'_>,
    vault: &PlannedVault,
    id: &VaultId,
) -> Result<VaultSection, RunError> {
    match stage(run, phase, vault, id)? {
        Staged::Settled(section) => Ok(*section),
        Staged::Install(pending) => pending.install(),
    }
}

impl PendingInstall {
    /// Check 7 again, right before the first install of the run: the vaults staged after this
    /// one gave another writer time to change it.
    pub(super) fn recheck(&self) -> Result<(), RunError> {
        let changed = self
            .prepared
            .unexpected_changes()
            .map_err(|e| self.fail(e))?;
        match changed.first() {
            None => Ok(()),
            Some(first) => Err(self.fail(ImportError::CheckFailed {
                check: 7,
                detail: format!("{} vault files changed, first {first}", changed.len()),
            })),
        }
    }

    pub(super) fn install(self) -> Result<VaultSection, RunError> {
        let Self {
            mut section,
            staged,
            prepared,
        } = self;
        let fail = |source| RunError::Vault {
            vault: section.path.clone(),
            source,
        };
        create_core_dir(&prepared.dir.join(".memry")).map_err(fail)?;
        staged.install().map_err(fail)?;
        section.status = VaultStatus::Imported;
        Ok(section)
    }

    pub(super) fn discard(self) {
        if let Err(error) = self.staged.discard() {
            tracing::warn!(%error, "could not remove the import staging directory");
        }
    }

    fn fail(&self, source: ImportError) -> RunError {
        RunError::Vault {
            vault: self.section.path.clone(),
            source,
        }
    }
}

/// A `core/data.db` an earlier attempt imported. Kept when that attempt read the Electron
/// `data.db` this run finds (`Some`). Otherwise (Electron wrote it since, or the attempt is
/// unknown) it is removed and the vault imported again (`None`), but only if this app never
/// opened it: an opened core may hold the user's writes, so it is kept as
/// [`VaultStatus::Kept`]. A native core or none at all is `None` and left to Step 36.
fn earlier_import(
    previous: Option<&VaultSection>,
    path: &str,
    fingerprint: &str,
) -> Option<Result<VaultSection, ImportError>> {
    let vault = Path::new(path);
    let data = vault.join(".memry").join(CORE_DIR).join(DATA_FILE);
    match fs::symlink_metadata(&data) {
        Ok(meta) if meta.is_file() => {}
        _ => return None,
    }
    match read_marker(&data) {
        Ok(Some(_)) => {}
        Ok(None) => return None,
        Err(error) => return Some(Err(error.into())),
    }
    let same_source = |s: &&VaultSection| {
        s.source_fingerprint.as_deref() == Some(fingerprint)
            && matches!(
                s.status,
                VaultStatus::Staged | VaultStatus::Imported | VaultStatus::AlreadyImported
            )
    };
    if let Some(done) = previous.filter(same_source) {
        // Cut off after the commit rename: the staging directory install would have removed.
        let staging = vault.join(".memry").join(STAGING_DIR);
        match fs::remove_dir_all(&staging) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Some(Err(ImportError::io(&staging, e))),
        }
        let mut done = done.clone();
        done.status = VaultStatus::Imported;
        return Some(Ok(done));
    }
    match opened(&data) {
        Ok(false) => remove_core(&data).err().map(Err),
        Ok(true) => {
            let mut kept = previous
                .cloned()
                .unwrap_or_else(|| VaultSection::new(path, VaultStatus::Kept));
            kept.status = VaultStatus::Kept;
            kept.detail = Some(
                "MemryNote already opened this vault, so it keeps the copy it moved earlier. \
                 Changes made to the vault in the previous MemryNote app after that were not \
                 moved; they are still there. Make them again in MemryNote."
                    .into(),
            );
            Some(Ok(kept))
        }
        Err(error) => Some(Err(error)),
    }
}

/// Whether a session opened this core: every open records the vault's origin before the vault
/// is used (`session::open`), and the import never writes it.
fn opened(data: &Path) -> Result<bool, ImportError> {
    let read = || -> rusqlite::Result<bool> {
        let conn = Connection::open_with_flags(
            data,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM meta WHERE key = ?1)",
            [VAULT_ORIGIN_META_KEY],
            |row| row.get(0),
        )
    };
    read().map_err(|error| ImportError::Sqlite(error.to_string()))
}

/// Removes an imported `core/` pair, sidecars before each database: a crash part way leaves
/// either the marked `data.db` (removed again) or no `data.db` (staged again).
fn remove_core(data: &Path) -> Result<(), ImportError> {
    let index = data.with_file_name(INDEX_FILE);
    for db in [data, index.as_path()] {
        let mut files: Vec<PathBuf> = ["-wal", "-shm", "-journal"]
            .iter()
            .map(|suffix| {
                let mut name = db.as_os_str().to_owned();
                name.push(suffix);
                PathBuf::from(name)
            })
            .collect();
        files.push(db.to_owned());
        for file in files {
            match fs::remove_file(&file) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(ImportError::io(&file, e)),
            }
        }
    }
    Ok(())
}

fn report_error() -> ImportError {
    ImportError::parse("electron-import-report.json", 0)
}

/// Checks 3, 7 and 8 (1, 2, 4, 5 and 6 are Step 36's), all before install so a failure leaves
/// `core/` as it was. Check 7 runs here too: install writes only under `.memry/`, which the
/// digest leaves out.
fn checks(
    staged: &StagedVault,
    expected: &[(String, DocumentState)],
    prepared: &PreparedVault,
    section: &mut VaultSection,
) -> Result<(), ImportError> {
    for (doc_id, folded) in expected {
        let check3 = |detail: String| ImportError::CheckFailed { check: 3, detail };
        match staged.document_state(doc_id)? {
            Some(state)
                if state.state_vector == folded.state_vector && state.text == folded.text => {}
            Some(_) => return Err(check3(format!("document {doc_id} differs from Electron's"))),
            None => return Err(check3(format!("document {doc_id} was not imported"))),
        }
    }
    let changed = prepared.unexpected_changes()?;
    if let Some(first) = changed.first() {
        return Err(ImportError::CheckFailed {
            check: 7,
            detail: format!("{} vault files changed, first {first}", changed.len()),
        });
    }
    let mut passed = staged.report().checks_passed.clone();
    passed.extend([3, 7]);
    // Check 8 decrypts an agent conversation with the migrated key through Step 28's envelope
    // reader, which is not merged (#3545). The rows are copied byte for byte (check 5) and the
    // master key passed the verifier in the secrets phase; the check is recorded as not run.
    let agent_rows = staged
        .report()
        .tables
        .get("data/agent_conversations")
        .is_some_and(|t| t.target_count > 0);
    if agent_rows {
        section.checks_not_run.insert(
            "8".into(),
            Value::String("the Step 28 envelope reader is not merged (#3545)".into()),
        );
    } else {
        passed.push(8);
    }
    passed.sort_unstable();
    passed.dedup();
    section.checks_passed = passed;
    Ok(())
}

/// The state vector and canonical text of a folded document, read the way Step 36's
/// `document_state` reads the staged one.
fn folded_state(doc_id: &str, state: &[u8]) -> Result<DocumentState, ImportError> {
    let failed = |e: memry_core::crdt::CrdtError| ImportError::CheckFailed {
        check: 3,
        detail: format!("document {doc_id} cannot be read: {e}"),
    };
    let document = DocumentRegistry::new("import", Arc::new(|_: &str, _: &[u8]| {}))
        .get_or_open(doc_id)
        .map_err(failed)?;
    document.apply_durable_update(state).map_err(failed)?;
    Ok(DocumentState {
        state_vector: document.state_vector().map_err(failed)?,
        text: canonical_fragment(&document).map_err(failed)?,
    })
}

/// `<vault>/.memry/core`, mode 0700 on Unix, as the session creates it.
fn create_core_dir(memry: &Path) -> Result<(), ImportError> {
    let core = memry.join(CORE_DIR);
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&core).map_err(|e| ImportError::io(&core, e))
}

/// sha256 over the Electron `data.db` and its WAL, hex: the marker's downgrade fingerprint.
pub(super) fn source_fingerprint(vault: &Path) -> Result<String, ImportError> {
    let mut hasher = Sha256::new();
    for name in ["data.db", "data.db-wal"] {
        let path = vault.join(".memry").join(name);
        let mut file = match fs::File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(ImportError::io(&path, e)),
        };
        hasher.update(name.as_bytes());
        let mut buf = vec![0_u8; 1 << 16];
        loop {
            let n = file.read(&mut buf).map_err(|e| ImportError::io(&path, e))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
    }
    Ok(hex::encode(hasher.finalize()))
}

/// The `crdt-pending-notes.json` ids an Electron build before #2298 left in userData, read as
/// `parseLegacyPendingNoteIds` does (`sync/note-body-outbox.ts`): a JSON array of ids, else
/// every complete string token of a torn write.
pub(super) fn pending_notes(profile: &ElectronProfile) -> Result<Vec<String>, ImportError> {
    let path = profile.dir.join("crdt-pending-notes.json");
    let raw = match fs::read(&path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(ImportError::io(&path, e)),
    };
    if let Ok(Value::Array(ids)) = serde_json::from_str::<Value>(&raw) {
        return Ok(ids
            .into_iter()
            .filter_map(|id| id.as_str().filter(|s| !s.is_empty()).map(str::to_owned))
            .collect());
    }
    let mut ids = Vec::new();
    let mut rest = raw.as_str();
    while let Some(start) = rest.find('"') {
        let mut escaped = false;
        let end = rest[start + 1..].char_indices().find_map(|(i, c)| {
            let close = c == '"' && !escaped;
            escaped = c == '\\' && !escaped;
            close.then_some(start + 1 + i)
        });
        let Some(end) = end else { break };
        if let Ok(Value::String(id)) = serde_json::from_str::<Value>(&rest[start..=end])
            && !id.is_empty()
            && !ids.contains(&id)
        {
            ids.push(id);
        }
        rest = &rest[end + 1..];
    }
    Ok(ids)
}
