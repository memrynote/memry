//! The first-launch migration (Step 37e2, #3554): [`run_first_launch`] runs the phases in order,
//! preflight, `app-state`, `secrets`, `vault`, `finish`, and [`migrate_vault`] imports a vault the
//! run deferred when the session first opens it. The Tauri shell runs the first in its
//! `Migration` startup stage and installs the second as the session's open hook
//! ([`vault_migrator`]).
//!
//! **Resuming.** Every phase is a pure function of the untouched Electron data, and the report
//! (`electron-import-report.json`) is saved after each one: a rerun after a crash skips the
//! phases the report holds (the app-state phase is never applied again over the user's changes)
//! and keeps each vault's first report section, so it ends with the report a run without the
//! crash would have written. A rerun after a failure runs app-state and secrets again: the
//! user went back to the previous app meanwhile. An installed vault is kept only while its
//! Electron `data.db` has the fingerprint the import read; otherwise it is imported again. The
//! marker (`electron-import.json`) is written last; while it is absent no vault opens.
//!
//! **Failures.** Any error stops the run: the report names the failing check, the marker stays
//! unwritten and the shell keeps the previous app's data as it is. Every vault is staged and
//! checked before the first one installs, so a failed run leaves no vault imported. A Step 36
//! `NotReady` stops the whole run too (Kaan, #3554 Q3). A vault whose store another vault shares is never
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

pub use self::deferred::{migrate_vault, move_vault, vault_migrator, wall_clock_ms};
pub use self::error::RunError;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Instant;

use self::marker::{Marker, MarkerVault, write_json};
use self::vault::{Staged, VaultPhase, settled_section};
use super::app_state::{AppStateInput, import_app_state};
use super::journal_replay::BulkApplyJournal;
use super::profile::locate_profile;
use super::progress::{Phase, ProgressSink, ProgressUpdate};
use super::report::{Failure, REPORT_FILE, VaultSection, VaultStatus, VerificationReport};
use super::secrets::{ChromiumKeySource, KeytarSource};
use super::secrets_import::{SecretsMode, forget_secrets_import};
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
    let Some(profile) = electron_profile(&ctx.env)? else {
        return Ok(FirstLaunch::NoProfile);
    };
    let started = Instant::now();
    let mut run = Run::load(&ctx.tauri_data_dir);
    // A failure sent the user back to the previous app (Q3), which may have changed its config
    // and secrets since: both phases run again.
    let after_failure = run.report.failure.take().is_some();
    if after_failure {
        run.report.app_state = None;
    }
    let mut counts = (0, 0);
    match phases(
        ctx,
        input,
        &profile,
        &mut run,
        &mut counts,
        started,
        after_failure,
    ) {
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

/// The Electron profile a migration reads: one with a config or a secret store.
fn electron_profile(env: &ProfileEnv) -> Result<Option<ElectronProfile>, RunError> {
    Ok(locate_profile(env)?.filter(|p| p.has_config || p.has_secure_store))
}

fn phases(
    ctx: &ImportContext<'_>,
    input: &FirstLaunchInput<'_>,
    profile: &ElectronProfile,
    run: &mut Run<'_>,
    counts: &mut (usize, usize),
    started: Instant,
    after_failure: bool,
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

    // The sync entries the failed run copied go; one this app wrote since stays.
    if after_failure && run.report.secrets.is_some() {
        forget_secrets_import(input.keyring, &ctx.tauri_data_dir).map_err(RunError::Secrets)?;
        run.report.secrets = None;
    }

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
        legacy_read_by: None,
        lock: &lock,
        now_ms: (ctx.now_ms)(),
    };
    // Every vault is staged and checked before the first install, so a failed run leaves no
    // core behind (Q3).
    let mut slots = Vec::with_capacity(plan.vaults.len());
    let checked = stage_all(ctx, run, &phase, &mut slots).and_then(|()| {
        slots.iter().try_for_each(|slot| match slot {
            Staged::Install(pending) => pending.recheck(),
            Staged::Settled(_) => Ok(()),
        })
    });
    if let Err(error) = checked {
        discard(slots);
        return Err(error);
    }
    let marked = install_all(run, slots)?;
    ctx.crash_after("vault");

    ctx.progress(Phase::Finish, 0, 1, "report");
    run.save()?;
    ctx.crash_after("finish");
    Marker {
        version: marker::MARKER_VERSION,
        completed_at: (ctx.now_ms)(),
        electron_profile: profile.dir.to_string_lossy().into_owned(),
        vaults: marked,
        legacy_store_read_by: legacy_reader(run),
        extra: serde_json::Map::new(),
    }
    .write(&ctx.tauri_data_dir)?;
    if let Err(error) = std::fs::remove_dir_all(scratch.root()) {
        tracing::warn!(%error, "could not remove the migration scratch directory");
    }
    emit(ctx, MigrationEventName::Completed, started, *counts, None);
    Ok(())
}

/// The uuid of the vault whose fold read the unclaimed legacy store, as its prep report records
/// it. The plan gives the store to one vault at most, so the first such section is the only one.
fn legacy_reader(run: &Run<'_>) -> Option<String> {
    run.report
        .vaults
        .iter()
        .find(|s| {
            s.prep
                .as_ref()
                .is_some_and(|p| p["fold"]["legacy"] == "read")
        })
        .and_then(|s| s.vault_id.clone())
}

fn stage_all(
    ctx: &ImportContext<'_>,
    run: &mut Run<'_>,
    phase: &VaultPhase<'_>,
    slots: &mut Vec<Staged>,
) -> Result<(), RunError> {
    let total = phase.plan.vaults.len();
    for (index, planned) in phase.plan.vaults.iter().enumerate() {
        let label = crate::registry::vaults::basename(&planned.path);
        ctx.progress(Phase::Vault, index + 1, total, &label);
        let slot = match &planned.disposition {
            Disposition::Import(id) => vault::stage(run, phase, planned, id)?,
            _ => Staged::Settled(Box::new(
                settled_section(phase, planned).unwrap_or_else(|| unreachable!()),
            )),
        };
        if let Staged::Settled(section) = &slot {
            run.save_section(VaultSection::clone(section))?;
        }
        slots.push(slot);
    }
    Ok(())
}

/// Installs every staged vault in plan order. A failure part way discards the rest; the
/// installed ones keep their fingerprint, which a rerun compares.
fn install_all(run: &mut Run<'_>, slots: Vec<Staged>) -> Result<Vec<MarkerVault>, RunError> {
    let mut marked = Vec::with_capacity(slots.len());
    let mut slots = slots.into_iter();
    while let Some(slot) = slots.next() {
        let section = match slot {
            Staged::Settled(section) => Ok(*section),
            Staged::Install(pending) => pending.install(),
        };
        let saved = section.and_then(|section| {
            let entry = marker_vault(&section);
            run.save_section(section).map(|()| entry)
        });
        match saved {
            Ok(entry) => marked.push(entry),
            Err(error) => {
                discard(slots);
                return Err(error);
            }
        }
    }
    Ok(marked)
}

fn discard(slots: impl IntoIterator<Item = Staged>) {
    for slot in slots {
        if let Staged::Install(pending) = slot {
            pending.discard();
        }
    }
}

fn probe(profile: &ElectronProfile) -> Result<ProfileLock, RunError> {
    ProfileLock::probe(profile).map_err(|error| match error {
        ImportError::ProfileInUse(_) => RunError::ElectronRunning,
        other => other.into(),
    })
}

/// The marker entry of a vault's final section. The fingerprint is the one the import read, so
/// an Electron write after the install shows as a change.
fn marker_vault(section: &VaultSection) -> MarkerVault {
    let imported = matches!(
        section.status,
        VaultStatus::Imported | VaultStatus::AlreadyImported | VaultStatus::Kept
    );
    MarkerVault {
        path: section.path.clone(),
        vault_uuid: section.vault_id.clone(),
        status: section.status,
        reason: section.reason.clone(),
        store: section.store.clone(),
        source_fingerprint: section.source_fingerprint.clone().filter(|_| imported),
        shared_with: section.shared_with.clone(),
        extra: serde_json::Map::new(),
    }
}

#[cfg(test)]
mod tests;
