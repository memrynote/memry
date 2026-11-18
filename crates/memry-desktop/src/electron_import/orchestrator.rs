//! The first-launch migration (Step 37e2, #3554): [`run_first_launch`] runs the phases in order,
//! preflight, `app-state`, `secrets`, `vault`, `finish`, and [`migrate_vault`] imports a vault the
//! run deferred when the session first opens it. Nothing calls either in production until the
//! Tauri wiring (37f).
//!
//! **Resuming.** Every phase is a pure function of the untouched Electron data, and the report
//! (`electron-import-report.json`) is saved after each one: a rerun after a crash or a failure
//! skips the phases the report holds (the app-state phase is never applied again over the
//! user's changes) and keeps each vault's first report section, so it ends with the report a
//! run without the crash would have written. The marker (`electron-import.json`) is written
//! last; while it is absent no vault opens.
//!
//! **Failures.** Any error stops the run: the report names the failing check, the marker stays
//! unwritten and the shell keeps the previous app's data as it is. A Step 36 `NotReady` stops
//! the whole run too (Kaan, #3554 Q3). A vault whose store another vault shares is never
//! imported (Q4), and opening it fails with every path of its group.
//!
//! **One import at a time.** [`ProfileLock`] only probes for a running Electron; the imports of
//! this process serialize on one lock, and the app runs as a single instance.

pub mod marker;
pub mod preflight;
mod vault;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Instant;

use serde_json::{Value, json};

use self::marker::{Marker, MarkerVault, write_json};
use self::vault::{VaultPhase, settled_section, source_fingerprint, store_name};
use super::app_state::{AppStateInput, import_app_state};
use super::journal_replay::BulkApplyJournal;
use super::profile::locate_profile;
use super::progress::{Phase, ProgressSink, ProgressUpdate};
use super::report::{Failure, REPORT_FILE, VaultSection, VaultStatus, VerificationReport};
use super::secrets::{ChromiumKeySource, KeytarSource, read_all_secrets};
use super::secrets_import::{SecretsError, SecretsEvidence, SecretsMode, SecretsPhase};
use super::vault_prep::{DeferReason, Disposition, PlannedVault, plan_vaults};
use super::{
    ElectronConfig, ElectronProfile, ImportError, ProfileEnv, ProfileLock, Scratch, import_secrets,
    read_vault_evidence,
};
use crate::launch_env::LaunchEnv;
use crate::registry::AppConfig;
use crate::seams::secure_store::{DeviceIdentityStore, KeyringStore};

/// Names the phase after which a test build panics, read through [`LaunchEnv`]: a phase
/// (`app-state`, `secrets`, `vault`, `finish`) or a Step 36 install point
/// ([`super::vault_db::crash::POINTS`]). Only builds with the `import-crash-points` feature
/// read it, and no app build has it.
pub const CRASH_AFTER_VAR: &str = "MEMRY_IMPORT_CRASH_AFTER";
/// Scratch copies of the Electron stores, under the Tauri data dir; removed by a finished run.
const SCRATCH_DIR: &str = "electron-import-scratch";

static IMPORT_LOCK: Mutex<()> = Mutex::new(());

/// The three telemetry events. Their fields are counts, a duration and a check name: never a
/// path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationEventName {
    Started,
    Completed,
    Failed,
}

impl MigrationEventName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Started => "migration_started",
            Self::Completed => "migration_completed",
            Self::Failed => "migration_failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationEvent {
    pub name: MigrationEventName,
    pub duration_ms: u64,
    /// Vaults in the plan.
    pub item_count: u32,
    /// Vaults deferred to their first open.
    pub queue_count: u32,
    /// [`RunError::check`] of a failure.
    pub error_code: Option<String>,
}

/// The Tauri shell sends these through `track_main_event` (37f), which honours the telemetry
/// config; the run emits nothing before the app-state phase carried Electron's opt-out into it.
pub trait MigrationTelemetry: Send + Sync {
    fn record(&self, event: MigrationEvent);
}

pub struct ImportContext<'a> {
    pub env: ProfileEnv,
    pub tauri_data_dir: PathBuf,
    pub progress: &'a dyn ProgressSink,
    pub telemetry: &'a dyn MigrationTelemetry,
    /// [`CRASH_AFTER_VAR`]; see [`ImportContext::crash_after_from`].
    pub crash_after: Option<String>,
    pub now_ms: fn() -> i64,
    pub free_space: preflight::FreeSpace,
}

impl ImportContext<'_> {
    pub fn crash_after_from(env: &LaunchEnv) -> Option<String> {
        env.get(CRASH_AFTER_VAR).map(str::to_owned)
    }

    fn crash_after(&self, phase: &str) {
        #[cfg(feature = "import-crash-points")]
        if self.crash_after.as_deref() == Some(phase) {
            panic!("import crash after {phase}");
        }
        let _ = phase;
    }

    /// Arms the Step 36 install point [`CRASH_AFTER_VAR`] names, if it names one.
    fn arm_install_point(&self) {
        #[cfg(feature = "import-crash-points")]
        if let Some(point) = super::vault_db::crash::POINTS
            .iter()
            .find(|p| Some(**p) == self.crash_after.as_deref())
        {
            super::vault_db::crash::arm(point);
        }
    }

    fn progress(&self, phase: Phase, current: usize, total: usize, label: &str) {
        self.progress.update(ProgressUpdate {
            phase,
            current: u32::try_from(current).unwrap_or(u32::MAX),
            total: u32::try_from(total).unwrap_or(u32::MAX),
            label: label.to_owned(),
        });
    }
}

/// What the secrets phase needs, and the running app's config owner.
pub struct FirstLaunchInput<'a> {
    pub app_config: &'a AppConfig,
    pub keyring: &'a KeyringStore,
    pub identity: &'a DeviceIdentityStore,
    pub key_source: &'a dyn ChromiumKeySource,
    pub keytar: &'a dyn KeytarSource,
    pub secrets_mode: SecretsMode,
}

#[derive(Debug)]
pub enum FirstLaunch {
    /// No Electron profile with a config or a secret store: a fresh install.
    NoProfile,
    /// The marker is present: an earlier run finished.
    AlreadyDone,
    Migrated(Box<VerificationReport>),
}

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("Quit the previous MemryNote app, then start MemryNote again.")]
    ElectronRunning,
    #[error(
        "There is not enough free space on {}: moving your data needs {needed} bytes and \
         {available} are free. Free some space and try again.",
        volume.display()
    )]
    DiskSpace {
        volume: PathBuf,
        needed: u64,
        available: u64,
    },
    /// The vault's `data.db` is not at the schema of the last Electron release.
    #[error(
        "The previous MemryNote app has not finished updating the vault at {vault}. Update the \
         previous app, open the vault in it once, quit it, then start MemryNote again."
    )]
    ElectronSchema {
        vault: String,
        found: Option<i64>,
        expected: i64,
    },
    #[error(
        "These vaults share one sync history, so MemryNote cannot move them: {}. Nothing was \
         changed. Keep using the previous MemryNote app for them.",
        paths.join(", ")
    )]
    SharedStore { paths: Vec<String> },
    #[error(
        "The vault at {vault} cannot be read now. Check that its drive is connected and try again."
    )]
    VaultUnreachable { vault: String },
    #[error(transparent)]
    Secrets(SecretsError),
    #[error("{vault}: {source}")]
    Vault {
        vault: String,
        #[source]
        source: ImportError,
    },
    #[error(transparent)]
    Import(#[from] ImportError),
}

impl RunError {
    /// The failing check or error kind: the report's `failure.check` and telemetry's
    /// `errorCode`. Never a path.
    pub fn check(&self) -> String {
        match self {
            Self::ElectronRunning => "electron-running".into(),
            Self::DiskSpace { .. } => "disk-space".into(),
            Self::ElectronSchema { .. } => "electron-schema".into(),
            Self::SharedStore { .. } => "shared-store".into(),
            Self::VaultUnreachable { .. } => "vault-unreachable".into(),
            Self::Secrets(error) => format!("secrets:{}", secrets_code(error)),
            Self::Vault { source, .. } | Self::Import(source) => import_code(source),
        }
    }

    fn vault(&self) -> Option<String> {
        match self {
            Self::ElectronSchema { vault, .. }
            | Self::VaultUnreachable { vault }
            | Self::Vault { vault, .. } => Some(vault.clone()),
            _ => None,
        }
    }
}

fn secrets_code(error: &SecretsError) -> &'static str {
    match error {
        SecretsError::Read(_) => "read",
        SecretsError::DoneMarker(_) => "done-marker",
        SecretsError::Unreadable(_) => "unreadable",
        SecretsError::KeytarUnlisted(_) => "keytar-unlisted",
        SecretsError::Malformed { .. } => "malformed",
        SecretsError::DeviceKeyMismatch => "device_key_mismatch",
        SecretsError::KeyVerifierMismatch => "KeyVerifierMismatch",
        SecretsError::TargetOccupied { .. } => "target-occupied",
        SecretsError::Keychain(_) => "keychain",
        SecretsError::RollbackIncomplete { cause, .. } => secrets_code(cause),
    }
}

fn import_code(error: &ImportError) -> String {
    match error {
        ImportError::CheckFailed { check, .. } => format!("check-{check}"),
        ImportError::NotReady { .. } => "not-ready".into(),
        ImportError::ProfileInUse(_) => "electron-running".into(),
        ImportError::SourceSchema { .. } => "electron-schema".into(),
        ImportError::DeleteWithoutDevice => "delete-without-device".into(),
        ImportError::MalformedRow { .. } | ImportError::NonTextId { .. } => "malformed-row".into(),
        ImportError::CoreFileExists(_) => "core-file-exists".into(),
        ImportError::SourceChanged(_) => "source-changed".into(),
        ImportError::Io { .. } => "io".into(),
        _ => "import".into(),
    }
}

/// The report of the run in progress, saved after every step that changed it.
pub(super) struct Run<'a> {
    data_dir: &'a Path,
    report: VerificationReport,
}

impl<'a> Run<'a> {
    /// Resumes the report an earlier run saved. One this build cannot read starts over: every
    /// phase repeats with the same result.
    fn load(data_dir: &'a Path) -> Self {
        let report = match std::fs::read(data_dir.join(REPORT_FILE)) {
            Ok(bytes) => VerificationReport::parse(&bytes).unwrap_or_else(|error| {
                tracing::warn!(%error, "the earlier migration report is unreadable; starting over");
                VerificationReport::default()
            }),
            Err(_) => VerificationReport::default(),
        };
        Self { data_dir, report }
    }

    fn save(&self) -> Result<(), RunError> {
        Ok(write_json(&self.data_dir.join(REPORT_FILE), &self.report)?)
    }

    pub(super) fn section(&self, path: &str) -> Option<&VaultSection> {
        self.report.vaults.iter().find(|s| s.path == path)
    }

    pub(super) fn save_section(&mut self, section: VaultSection) -> Result<(), RunError> {
        match self
            .report
            .vaults
            .iter_mut()
            .find(|s| s.path == section.path)
        {
            Some(slot) => *slot = section,
            None => self.report.vaults.push(section),
        }
        self.save()
    }

    fn fail(&mut self, error: &RunError) {
        self.report.failure = Some(Failure {
            check: error.check(),
            message: error.to_string(),
            vault: error.vault(),
        });
        if let Err(save) = self.save() {
            tracing::error!(%save, "could not save the migration report");
        }
    }
}

/// Runs the first-launch migration unless the marker says it ran or there is no Electron
/// profile.
pub fn run_first_launch(
    ctx: &ImportContext<'_>,
    input: &FirstLaunchInput<'_>,
) -> Result<FirstLaunch, RunError> {
    let _one = IMPORT_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    if Marker::read(&ctx.tauri_data_dir)?.is_some() {
        return Ok(FirstLaunch::AlreadyDone);
    }
    let Some(profile) = locate_profile(&ctx.env)? else {
        return Ok(FirstLaunch::NoProfile);
    };
    if !profile.has_config && !profile.has_secure_store {
        return Ok(FirstLaunch::NoProfile);
    }
    let started = Instant::now();
    let mut run = Run::load(&ctx.tauri_data_dir);
    run.report.failure = None;
    let mut counts = (0, 0);
    match phases(ctx, input, &profile, &mut run, &mut counts, started) {
        Ok(()) => Ok(FirstLaunch::Migrated(Box::new(run.report))),
        Err(error) => {
            run.fail(&error);
            if run.report.app_state.is_some() {
                emit(
                    ctx,
                    MigrationEventName::Failed,
                    started,
                    counts,
                    Some(error.check()),
                );
            }
            Err(error)
        }
    }
}

fn emit(
    ctx: &ImportContext<'_>,
    name: MigrationEventName,
    started: Instant,
    (vaults, deferred): (usize, usize),
    error_code: Option<String>,
) {
    ctx.telemetry.record(MigrationEvent {
        name,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        item_count: u32::try_from(vaults).unwrap_or(u32::MAX),
        queue_count: u32::try_from(deferred).unwrap_or(u32::MAX),
        error_code,
    });
}

fn phases(
    ctx: &ImportContext<'_>,
    input: &FirstLaunchInput<'_>,
    profile: &ElectronProfile,
    run: &mut Run<'_>,
    counts: &mut (usize, usize),
    started: Instant,
) -> Result<(), RunError> {
    let lock = probe(profile)?;
    let config = ElectronConfig::read(profile)?;
    let scratch = Scratch::new(ctx.tauri_data_dir.join(SCRATCH_DIR))?;
    let plan = plan_vaults(profile, config.as_ref(), &scratch);
    let deferred = plan
        .vaults
        .iter()
        .filter(|v| matches!(v.disposition, Disposition::Deferred(_)))
        .count();
    *counts = (plan.vaults.len(), deferred);
    let all: Vec<&PlannedVault> = plan.vaults.iter().collect();
    preflight::run(
        profile,
        config.as_ref(),
        &all,
        &ctx.tauri_data_dir,
        ctx.free_space,
    )?;

    if run.report.app_state.is_none() {
        let app_state = import_app_state(&AppStateInput {
            profile,
            scratch: &scratch,
            tauri_data_dir: &ctx.tauri_data_dir,
            config: input.app_config,
            progress: ctx.progress,
        })?;
        run.report.app_state = Some(app_state);
        run.save()?;
    }
    ctx.crash_after("app-state");
    emit(ctx, MigrationEventName::Started, started, *counts, None);

    if run.report.secrets.is_none() {
        ctx.progress(Phase::Secrets, 0, 1, "secrets");
        run.report.secrets = Some(secrets(
            input,
            profile,
            config.as_ref(),
            &scratch,
            &ctx.tauri_data_dir,
        )?);
        run.save()?;
    }
    ctx.crash_after("secrets");

    ctx.arm_install_point();
    let journal = BulkApplyJournal::read(profile)?;
    let pending_notes = vault::pending_notes(profile)?;
    let phase = VaultPhase {
        profile,
        config: config.as_ref(),
        plan: &plan,
        journal: journal.as_ref(),
        pending_notes: &pending_notes,
        scratch: &scratch,
        lock: &lock,
        now_ms: (ctx.now_ms)(),
    };
    let mut marked = Vec::with_capacity(plan.vaults.len());
    for (index, planned) in plan.vaults.iter().enumerate() {
        let label = crate::registry::vaults::basename(&planned.path);
        ctx.progress(Phase::Vault, index + 1, plan.vaults.len(), &label);
        let section = match (&planned.disposition, run.section(&planned.path)) {
            (Disposition::Import(_), Some(done)) if done.status == VaultStatus::Imported => {
                done.clone()
            }
            (Disposition::Import(id), _) => vault::import(run, &phase, planned, id)?,
            _ => settled_section(&phase, planned).unwrap_or_else(|| unreachable!()),
        };
        marked.push(marker_vault(&section)?);
        run.save_section(section)?;
    }
    ctx.crash_after("vault");

    ctx.progress(Phase::Finish, 0, 1, "report");
    run.save()?;
    ctx.crash_after("finish");
    Marker {
        version: marker::MARKER_VERSION,
        completed_at: (ctx.now_ms)(),
        electron_profile: profile.dir.to_string_lossy().into_owned(),
        vaults: marked,
        extra: serde_json::Map::new(),
    }
    .write(&ctx.tauri_data_dir)?;
    if let Err(error) = std::fs::remove_dir_all(scratch.root()) {
        tracing::warn!(%error, "could not remove the migration scratch directory");
    }
    emit(ctx, MigrationEventName::Completed, started, *counts, None);
    Ok(())
}

fn probe(profile: &ElectronProfile) -> Result<ProfileLock, RunError> {
    ProfileLock::probe(profile).map_err(|error| match error {
        ImportError::ProfileInUse(_) => RunError::ElectronRunning,
        other => other.into(),
    })
}

fn marker_vault(section: &VaultSection) -> Result<MarkerVault, RunError> {
    let imported = matches!(
        section.status,
        VaultStatus::Imported | VaultStatus::AlreadyImported
    );
    let source_fingerprint = if imported {
        Some(source_fingerprint(Path::new(&section.path))?)
    } else {
        None
    };
    Ok(MarkerVault {
        path: section.path.clone(),
        vault_uuid: section.vault_id.clone(),
        status: section.status,
        reason: section.reason.clone(),
        store: section.store.clone(),
        source_fingerprint,
        shared_with: section.shared_with.clone(),
        extra: serde_json::Map::new(),
    })
}

/// The secrets phase (Step 37c's [`import_secrets`]) with this run's inputs, as the report's
/// `secrets` section.
fn secrets(
    input: &FirstLaunchInput<'_>,
    profile: &ElectronProfile,
    config: Option<&ElectronConfig>,
    scratch: &Scratch,
    data_dir: &Path,
) -> Result<Value, RunError> {
    let mut inline_ai_reenter = Vec::new();
    let inputs = || -> Result<_, ImportError> {
        let report = read_all_secrets(profile, input.key_source, input.keytar)?;
        let evidence = match input.secrets_mode {
            // Sign in again skips every check the evidence feeds.
            SecretsMode::SignInAgain => SecretsEvidence::default(),
            SecretsMode::Full => evidence(config, scratch, &mut inline_ai_reenter)?,
        };
        Ok((report, evidence))
    };
    let phase = import_secrets(
        inputs,
        input.secrets_mode,
        input.keyring,
        input.identity,
        data_dir,
    )
    .map_err(RunError::Secrets)?;
    Ok(match phase {
        SecretsPhase::Done => json!({ "done": true }),
        SecretsPhase::Ran(outcome) => json!({
            "mode": format!("{:?}", input.secrets_mode),
            "written": outcome.written,
            "present": outcome.present,
            "verified": format!("{:?}", outcome.verified),
            "deviceKey": format!("{:?}", outcome.device_key),
            "deviceChecked": outcome.device_checked,
            "signInRequired": outcome.sign_in_required,
            "keytarUnlisted": outcome.keytar_unlisted,
            "skipped": outcome.skipped.iter().map(|s| json!({
                "service": s.service,
                "account": s.account,
                "reason": format!("{:?}", s.reason),
            })).collect::<Vec<_>>(),
            "inlineAiReenter": inline_ai_reenter,
        }),
    })
}

/// One evidence slot per config entry, in config order, so `current_vault` indexes its own
/// vault. A vault without a folder or a `data.db` fills its slot empty, which every check
/// skips. A `data.db` SQLite refuses does too when the config holds the account verifier; with
/// none, its verifier may be the only one, and the phase stops (Retry).
fn evidence(
    config: Option<&ElectronConfig>,
    scratch: &Scratch,
    inline_ai_reenter: &mut Vec<String>,
) -> Result<SecretsEvidence, ImportError> {
    let Some(config) = config else {
        return Ok(SecretsEvidence::default());
    };
    let account_key_verifier = config.account_key_verifier().map(str::to_owned);
    let (stored, _) = config.vaults();
    let mut vaults = Vec::with_capacity(stored.len());
    for vault in &stored {
        let dir = Path::new(&vault.path);
        let read = if dir.is_dir() {
            read_vault_evidence(dir, scratch.root())
        } else {
            Ok(None)
        };
        let evidence = match read {
            Ok(evidence) => evidence.unwrap_or_default(),
            Err(ImportError::Sqlite(_)) if account_key_verifier.is_some() => Default::default(),
            Err(error) => return Err(error),
        };
        if evidence.inline_ai_reenter && !inline_ai_reenter.contains(&vault.path) {
            inline_ai_reenter.push(vault.path.clone());
        }
        vaults.push(evidence);
    }
    let current_vault = config
        .current_vault()
        .and_then(|current| stored.iter().position(|v| v.path == current));
    Ok(SecretsEvidence {
        account_key_verifier,
        device_id: config.device_id().map(str::to_owned),
        current_vault,
        vaults,
    })
}

/// Imports a vault the first-launch run deferred, when the session first opens it. Reads only
/// the marker when there is nothing to do: no marker (no migration on this install), a path the
/// marker does not list, or a vault already settled.
pub fn migrate_vault(ctx: &ImportContext<'_>, vault: &Path) -> Result<(), RunError> {
    let path = vault.to_string_lossy();
    let pending = |marker: &Marker| {
        marker.vaults.iter().find(|v| v.path == path).and_then(|v| {
            matches!(v.status, VaultStatus::Deferred | VaultStatus::Unreadable).then(|| v.clone())
        })
    };
    let Some(marker) = Marker::read(&ctx.tauri_data_dir)? else {
        return Ok(());
    };
    if pending(&marker).is_none() {
        return Ok(());
    }
    let _one = IMPORT_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    // Read again under the lock: another open may have imported it meanwhile.
    let Some(mut marker) = Marker::read(&ctx.tauri_data_dir)? else {
        return Ok(());
    };
    let Some(entry) = pending(&marker) else {
        return Ok(());
    };
    if entry.reason.as_deref() == Some(vault::defer_reason(DeferReason::SharedStore)) {
        return Err(shared_store(&entry.path, &entry.shared_with));
    }
    let started = Instant::now();
    let mut run = Run::load(&ctx.tauri_data_dir);
    run.report.failure = None;
    emit(ctx, MigrationEventName::Started, started, (1, 0), None);
    match deferred_import(ctx, &mut marker, &mut run, &entry.path) {
        Ok(()) => {
            emit(ctx, MigrationEventName::Completed, started, (1, 0), None);
            Ok(())
        }
        Err(error) => {
            run.fail(&error);
            emit(
                ctx,
                MigrationEventName::Failed,
                started,
                (1, 0),
                Some(error.check()),
            );
            Err(error)
        }
    }
}

fn shared_store(path: &str, others: &[String]) -> RunError {
    RunError::SharedStore {
        paths: std::iter::once(path.to_owned())
            .chain(others.iter().cloned())
            .collect(),
    }
}

fn deferred_import(
    ctx: &ImportContext<'_>,
    marker: &mut Marker,
    run: &mut Run<'_>,
    path: &str,
) -> Result<(), RunError> {
    let profile = locate_profile(&ctx.env)?.ok_or(ImportError::ProfileNotFound)?;
    let lock = probe(&profile)?;
    let config = ElectronConfig::read(&profile)?;
    let scratch = Scratch::new(ctx.tauri_data_dir.join(SCRATCH_DIR))?;
    let plan = plan_vaults(&profile, config.as_ref(), &scratch);
    let Some(planned) = plan.vaults.iter().find(|v| v.path == path) else {
        // The previous app's config no longer names it: nothing to import from.
        return settle(
            ctx,
            marker,
            run,
            VaultSection::new(path, VaultStatus::NoData),
        );
    };
    let phase = VaultPhase {
        profile: &profile,
        config: config.as_ref(),
        plan: &plan,
        journal: None,
        pending_notes: &[],
        scratch: &scratch,
        lock: &lock,
        now_ms: (ctx.now_ms)(),
    };
    let section = match &planned.disposition {
        Disposition::Import(id) => {
            let store = store_name(&phase, id);
            let others: Vec<String> = marker
                .vaults
                .iter()
                .filter(|v| v.path != path && v.store.as_deref() == Some(store.as_str()))
                .map(|v| v.path.clone())
                .collect();
            if !others.is_empty() {
                if let Some(entry) = marker.vault_mut(path) {
                    entry.reason = Some(vault::defer_reason(DeferReason::SharedStore).into());
                    entry.shared_with.clone_from(&others);
                }
                marker.write(&ctx.tauri_data_dir)?;
                return Err(shared_store(path, &others));
            }
            preflight::run(
                &profile,
                config.as_ref(),
                &[planned],
                &ctx.tauri_data_dir,
                ctx.free_space,
            )?;
            // The journal replay is the first launch's: its entries name the vaults present then.
            vault::import(run, &phase, planned, id)?
        }
        Disposition::Deferred(DeferReason::DataDbMissing) => {
            VaultSection::new(path, VaultStatus::NoData)
        }
        Disposition::Deferred(DeferReason::SharedStore) => {
            let section = settled_section(&phase, planned).unwrap_or_else(|| unreachable!());
            let error = shared_store(path, &section.shared_with);
            if let Some(entry) = marker.vault_mut(path) {
                entry.reason.clone_from(&section.reason);
                entry.shared_with.clone_from(&section.shared_with);
            }
            marker.write(&ctx.tauri_data_dir)?;
            return Err(error);
        }
        Disposition::Deferred(_) => {
            return Err(RunError::VaultUnreachable {
                vault: path.to_owned(),
            });
        }
        // The plan's error is SQLite's, which names the row, never a value.
        Disposition::Unreadable(error) => {
            return Err(RunError::Vault {
                vault: path.to_owned(),
                source: ImportError::Sqlite(error.to_string()),
            });
        }
        Disposition::Sandbox | Disposition::SameFolder(_) => {
            settled_section(&phase, planned).unwrap_or_else(|| unreachable!())
        }
    };
    settle(ctx, marker, run, section)
}

/// Saves a vault's final section, then its marker entry.
fn settle(
    ctx: &ImportContext<'_>,
    marker: &mut Marker,
    run: &mut Run<'_>,
    section: VaultSection,
) -> Result<(), RunError> {
    let entry = marker_vault(&section)?;
    run.save_section(section)?;
    match marker.vault_mut(&entry.path) {
        Some(slot) => *slot = entry,
        None => marker.vaults.push(entry),
    }
    Ok(marker.write(&ctx.tauri_data_dir)?)
}

#[cfg(test)]
mod tests;
