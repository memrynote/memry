//! [`migrate_vault`]: the import of a vault the first-launch run deferred, when the session
//! first opens it.

use std::path::Path;
use std::sync::PoisonError;
use std::time::Instant;

use super::marker::Marker;
use super::vault::{self, VaultPhase, settled_section, store_name};
use super::{
    IMPORT_LOCK, ImportContext, MigrationEventName, Run, RunError, SCRATCH_DIR, emit, marker_vault,
    preflight, probe,
};
use crate::electron_import::profile::locate_profile;
use crate::electron_import::report::{VaultSection, VaultStatus};
use crate::electron_import::vault_prep::{DeferReason, Disposition, plan_vaults};
use crate::electron_import::{ElectronConfig, ImportError, Scratch};

/// Imports a vault the first-launch run deferred. Reads only the marker when there is nothing
/// to do: no marker (no migration on this install), a path the marker does not list, or a
/// vault already settled.
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
