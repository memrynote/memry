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

mod deferred;
mod error;
pub mod marker;
pub mod preflight;
mod secrets;
mod vault;

pub use self::deferred::migrate_vault;
pub use self::error::RunError;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Instant;

use self::marker::{Marker, MarkerVault, write_json};
use self::vault::{VaultPhase, settled_section, source_fingerprint};
use super::app_state::{AppStateInput, import_app_state};
use super::journal_replay::BulkApplyJournal;
use super::profile::locate_profile;
use super::progress::{Phase, ProgressSink, ProgressUpdate};
use super::report::{Failure, REPORT_FILE, VaultSection, VaultStatus, VerificationReport};
use super::secrets::{ChromiumKeySource, KeytarSource};
use super::secrets_import::SecretsMode;
use super::vault_prep::{Disposition, PlannedVault, plan_vaults};
use super::{ElectronConfig, ElectronProfile, ImportError, ProfileEnv, ProfileLock, Scratch};
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
        run.report.secrets = Some(secrets::run(
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

#[cfg(test)]
mod tests;
