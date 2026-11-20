//! [`migrate_vault`]: the import of a vault the first-launch run deferred, when the session
//! first opens it.

use std::path::Path;
use std::sync::PoisonError;
use std::time::Instant;

use super::marker::{Marker, MarkerVault};
use super::vault::{self, VaultPhase, settled_section, store_name};
use super::{
    IMPORT_LOCK, ImportContext, MigrationEventName, Run, RunError, SCRATCH_DIR, electron_profile,
    emit, marker_vault, preflight, probe,
};
use crate::electron_import::report::{VaultSection, VaultStatus};
use crate::electron_import::vault_db::CORE_DIR;
use crate::electron_import::vault_prep::{DeferReason, Disposition, folder_id, plan_folder};
use crate::electron_import::{ElectronConfig, ImportError, Scratch};

/// Imports a vault the first-launch run deferred, before the session opens it. Reads only the
/// marker for a vault already settled, and `Ok` with nothing to do when there is no Electron
/// profile. Refuses while the first-launch run has not finished (a vault opened now would get a
/// native core over Electron's data, which then never moves), and refuses a folder holding
/// Electron data that the marker does not list.
pub fn migrate_vault(ctx: &ImportContext<'_>, vault: &Path) -> Result<(), RunError> {
    if let Some(marker) = Marker::read(&ctx.tauri_data_dir)?
        && matches!(lookup(&marker, vault), Lookup::Settled)
    {
        return Ok(());
    }
    let _one = IMPORT_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    // Read again under the lock: a run or another open may have finished meanwhile.
    let Some(mut marker) = Marker::read(&ctx.tauri_data_dir)? else {
        return match electron_profile(&ctx.env)? {
            Some(_) => Err(RunError::NotMigrated),
            None => Ok(()),
        };
    };
    let entry = match lookup(&marker, vault) {
        Lookup::Settled => return Ok(()),
        Lookup::Unlisted => {
            return Err(RunError::NotMoved {
                vault: vault.to_string_lossy().into_owned(),
            });
        }
        Lookup::Pending(entry) => entry,
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

/// "Move this vault now" on a folder [`migrate_vault`] refuses as [`RunError::NotMoved`]
/// (Kaan, 20 Nov, #5140): one the first-launch run never listed, such as a deferred vault back at
/// another path, a vault added in the previous app afterwards, or a copied-in folder. Adds it to
/// the marker as deferred, then imports it as [`migrate_vault`] imports any deferred vault, so
/// the shell opens it once this returns `Ok`. On an error the vault stays refused and its folder
/// as it was: the import installs nothing until every check passed. The deferred entry stays,
/// so a run cut off anywhere is finished by the next call or open.
pub fn move_vault(ctx: &ImportContext<'_>, vault: &Path) -> Result<(), RunError> {
    {
        let _one = IMPORT_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(mut marker) = Marker::read(&ctx.tauri_data_dir)?
            && matches!(lookup(&marker, vault), Lookup::Unlisted)
        {
            let path = vault.to_string_lossy();
            marker.vaults.push(marker_vault(&VaultSection::new(
                &path,
                VaultStatus::Deferred,
            )));
            marker.write(&ctx.tauri_data_dir)?;
        }
    }
    migrate_vault(ctx, vault)
}

enum Lookup {
    /// Nothing to import: a settled vault, or a folder without Electron data or with a core.
    Settled,
    /// The marker's deferred (or unreadable) entry for the folder.
    Pending(Box<MarkerVault>),
    /// Electron data the marker has no entry for.
    Unlisted,
}

/// The marker entry of `vault`: by the path as written, else, for a folder with an Electron
/// `data.db`, by folder identity, which a trailing slash, another Unicode normalization or case,
/// or a symlink does not change. A core there does not end the search: a deferred import cut off
/// before its marker entry leaves one, and the entry must still say `Pending`.
fn lookup(marker: &Marker, vault: &Path) -> Lookup {
    let path = vault.to_string_lossy();
    let memry = vault.join(".memry");
    let electron = memry.join("data.db").is_file();
    let entry = marker.vaults.iter().find(|v| v.path == path).or_else(|| {
        if !electron {
            return None;
        }
        let id = folder_id(vault)?;
        marker
            .vaults
            .iter()
            .find(|v| folder_id(Path::new(&v.path)).as_ref() == Some(&id))
    });
    match entry {
        Some(entry)
            if matches!(
                entry.status,
                VaultStatus::Deferred | VaultStatus::Unreadable
            ) =>
        {
            Lookup::Pending(Box::new(entry.clone()))
        }
        Some(_) => Lookup::Settled,
        None if electron && !memry.join(CORE_DIR).join("data.db").exists() => Lookup::Unlisted,
        None => Lookup::Settled,
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
    let profile = electron_profile(&ctx.env)?.ok_or(ImportError::ProfileNotFound)?;
    let lock = probe(&profile)?;
    let config = ElectronConfig::read(&profile)?;
    let scratch = Scratch::new(ctx.tauri_data_dir.join(SCRATCH_DIR))?;
    // Planned from its folder even when the config no longer names it.
    let plan = plan_folder(&profile, config.as_ref(), &scratch, path);
    let planned = plan
        .vaults
        .iter()
        .find(|v| v.path == path)
        .unwrap_or_else(|| unreachable!());
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
    let entry = marker_vault(&section);
    run.save_section(section)?;
    match marker.vault_mut(&entry.path) {
        Some(slot) => *slot = entry,
        None => marker.vaults.push(entry),
    }
    Ok(marker.write(&ctx.tauri_data_dir)?)
}
