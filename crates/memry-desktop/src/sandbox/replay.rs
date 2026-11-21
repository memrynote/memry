//! Replays the sandbox template into a vault folder (Electron: `generateSandboxAt`,
//! `apps/cli/src/sandbox/generate.ts:100-118`).
//!
//! The replay builds the vault in a staging folder beside the target, then renames it over the
//! target, so a failure or a crash never leaves a half-made vault and never touches the previous
//! one:
//! 1. The template's files are copied with their dates moved to today ([`super::rebase`]) and
//!    every note id the template minted replaced by one the core minted. Two template files that
//!    land on one path (two past-year journal days on Feb 28) keep the later note row's file,
//!    as the generator's later write won.
//! 2. Each markdown note that is not a journal day is created in the core under its new id,
//!    with the body its file gives it ([`notes`]). The open walk claims each note for its file
//!    by folder, title and body (`identity::adopt`), so the ids in other notes' links hold. The
//!    walk makes notes of journal days and other files, which no template text names by id.
//! 3. The vault icon, then the rename. A previous sandbox is moved aside first and deleted only
//!    once the new one is in place; a failed rename puts it back. An empty folder moved aside is
//!    removed only while still empty, so a file added during the build stops the replay.
//!
//! Only an earlier sandbox (one with [`SANDBOX_VAULT_ICON`]) is ever replaced. A crash leaves a
//! `.<name>.sandbox-*` staging folder or a `.<name>.replaced-*` previous folder beside the
//! target. Both are this module's: a previous folder whose target is missing is renamed back,
//! then the next replay deletes the rest, so a rerun converges on one vault. The caller writes the marker ([`super::marker`]) after the replay,
//! and runs one replay of a target at a time, as `ensureSandboxVault` does
//! (`apps/desktop/src/main/vault/sandbox.ts:62-69`): two would sweep each other's staging.

mod notes;
mod plan;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Local, Utc};
use memry_core::api::notes_write::NotesWriter;
use memry_core::seams::secure_store::SecureStore;

use super::{Manifest, Rebase, SandboxError, device_zone_name};
use crate::registry::{config_lock, vault_icon};
use crate::vault::config as vault_config;

pub use plan::{MAX_DEPTH, MAX_FILE_BYTES, MAX_FILES};

/// `SANDBOX_VAULT_ICON` (`packages/contracts/src/vault-api.ts:127`).
pub const SANDBOX_VAULT_ICON: &str = "icon:CodesandboxIcon";

const STAGING_MARK: &str = ".sandbox-";
const REPLACED_MARK: &str = ".replaced-";

/// A template on disk: `seed.json` parsed, its `vault/` folder and the bundled assets folder.
#[derive(Debug, Clone)]
pub struct Template {
    pub manifest: Manifest,
    pub vault: PathBuf,
    pub assets: PathBuf,
}

impl Template {
    /// The template in `dir` (`seed.json`, `vault/`), with its assets in `assets`.
    pub fn load(dir: &Path, assets: &Path) -> Result<Self, SandboxError> {
        let seed = dir.join("seed.json");
        let bytes = fs::read(&seed).map_err(|error| io_error(&seed, &error))?;
        Ok(Self {
            manifest: Manifest::parse(&bytes)?,
            vault: dir.join("vault"),
            assets: assets.to_owned(),
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ReplayOptions {
    /// Move the template's dates to `now`'s local date; `false` keeps the template's dates.
    pub rebase_dates: bool,
    pub now: DateTime<Utc>,
    /// Replace a target folder that holds an earlier sandbox. Without it, or for any other
    /// non-empty folder, the target is refused before anything is written, so a replay never
    /// deletes a folder that is not a sandbox or that it was not told it may.
    pub replace: bool,
}

/// What a replay wrote, in the generator's terms (`generate.ts:38-59`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SeedCounts {
    /// Markdown notes that are not journal days, each created in the core.
    pub notes: usize,
    /// Journal day files.
    pub journal_entries: usize,
    /// Non-markdown files the template lists as notes.
    pub files: usize,
    /// `.excalidraw` canvas files.
    pub canvases: usize,
}

/// Replays `template` into `target`, which is created or (with `replace`) replaced. The
/// core databases are written with `store`'s device identity.
pub fn replay(
    template: &Template,
    target: &Path,
    options: &ReplayOptions,
    store: Arc<dyn SecureStore>,
) -> Result<SeedCounts, SandboxError> {
    let (parent, name) = parent_and_name(target)?;
    restore_replaced(target, parent, name)?;
    let previous = check_target(target, options.replace)?;
    fs::create_dir_all(parent).map_err(|error| io_error(parent, &error))?;
    sweep(parent, name);
    let staging = parent.join(format!(".{name}{STAGING_MARK}{}", unique()));
    fs::create_dir(&staging).map_err(|error| io_error(&staging, &error))?;
    let built = build(template, &staging, options, store);
    let swapped =
        built.and_then(|counts| swap(&staging, target, parent, name, previous).map(|()| counts));
    if swapped.is_err() {
        remove_ours(&staging);
    }
    swapped
}

fn build(
    template: &Template,
    staging: &Path,
    options: &ReplayOptions,
    store: Arc<dyn SecureStore>,
) -> Result<SeedCounts, SandboxError> {
    let mut manifest = template.manifest.clone();
    let rebase = options
        .rebase_dates
        .then(|| Rebase::for_manifest(&manifest, options.now, Local, device_zone_name()));
    if let Some(rebase) = &rebase {
        rebase.manifest(&mut manifest);
    }
    let plan = plan::plan(template, &manifest, rebase.as_ref(), |_| {
        NotesWriter::new_note_id()
    })?;
    plan.write(staging)?;
    notes::create(staging, store, &plan.notes)?;
    vault_icon::adopt(
        staging,
        Some(SANDBOX_VAULT_ICON),
        options.now.timestamp_millis(),
    )
    .map_err(|error| SandboxError::Io {
        path: staging.display().to_string(),
        message: error.to_string(),
    })?;
    // Writing the icon left the config's lock file. The staging folder is ours alone, and the
    // generator's vault (the template's paths) has no lock file: the next write makes one.
    let lock = config_lock::lock_path(&vault_config::config_path(staging));
    match fs::remove_file(&lock) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(&lock, &error)),
    }
    Ok(plan.counts)
}

fn parent_and_name(target: &Path) -> Result<(&Path, &str), SandboxError> {
    let unsafe_target = || SandboxError::UnsafeTarget(target.display().to_string());
    let parent = target.parent().filter(|p| !p.as_os_str().is_empty());
    let name = target.file_name().and_then(|name| name.to_str());
    match (parent, name) {
        (Some(parent), Some(name)) if !name.starts_with('.') => Ok((parent, name)),
        _ => Err(unsafe_target()),
    }
}

/// What the target held when the replay checked it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Previous {
    /// Missing or empty: whatever is there at the swap must still be empty.
    Nothing,
    /// An earlier sandbox, replaced as a whole.
    Sandbox,
}

/// A missing or empty folder is free; an earlier sandbox needs `replace`; anything else, a
/// link or a file included, is never replaced.
fn check_target(target: &Path, replace: bool) -> Result<Previous, SandboxError> {
    let meta = match fs::symlink_metadata(target) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Previous::Nothing),
        Err(error) => return Err(io_error(target, &error)),
    };
    if !meta.is_dir() {
        return Err(SandboxError::UnsafeTarget(target.display().to_string()));
    }
    let empty = fs::read_dir(target)
        .map_err(|error| io_error(target, &error))?
        .next()
        .is_none();
    let sandbox = || {
        vault_icon::read(target)
            .and_then(|icon| icon.value)
            .as_deref()
            == Some(SANDBOX_VAULT_ICON)
    };
    if empty {
        Ok(Previous::Nothing)
    } else if replace && sandbox() {
        Ok(Previous::Sandbox)
    } else {
        Err(SandboxError::TargetNotEmpty(target.display().to_string()))
    }
}

/// A replay killed between its two renames left the previous sandbox aside and no target:
/// rename it back, so the sweep never deletes the only copy.
fn restore_replaced(target: &Path, parent: &Path, name: &str) -> Result<(), SandboxError> {
    match fs::symlink_metadata(target) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Ok(_) => return Ok(()),
        Err(error) => return Err(io_error(target, &error)),
    }
    let Ok(entries) = fs::read_dir(parent) else {
        return Ok(());
    };
    let replaced = format!(".{name}{REPLACED_MARK}");
    let found = entries.flatten().find(|entry| {
        entry
            .file_name()
            .to_str()
            .is_some_and(|file_name| file_name.starts_with(&replaced))
    });
    if let Some(entry) = found {
        tracing::warn!(
            folder = ?entry.file_name(),
            "restoring the sandbox an interrupted replay moved aside"
        );
        fs::rename(entry.path(), target).map_err(|error| io_error(target, &error))?;
    }
    Ok(())
}

/// Deletes what an interrupted replay of `name` left beside it.
fn sweep(parent: &Path, name: &str) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let staging = format!(".{name}{STAGING_MARK}");
    let replaced = format!(".{name}{REPLACED_MARK}");
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if file_name.starts_with(&staging) || file_name.starts_with(&replaced) {
            tracing::warn!(
                folder = file_name,
                "removing what an interrupted sandbox replay left"
            );
            remove_ours(&entry.path());
        }
    }
}

fn swap(
    staging: &Path,
    target: &Path,
    parent: &Path,
    name: &str,
    previous: Previous,
) -> Result<(), SandboxError> {
    let aside = match fs::symlink_metadata(target) {
        Ok(_) => {
            let aside = parent.join(format!(".{name}{REPLACED_MARK}{}", unique()));
            fs::rename(target, &aside).map_err(|error| io_error(target, &error))?;
            Some(aside)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(io_error(target, &error)),
    };
    // A folder that was empty or missing at the check is removed only while empty: a file
    // added during the build puts it back and stops the replay.
    let aside = match aside {
        Some(aside) if previous == Previous::Nothing => {
            if let Err(error) = fs::remove_dir(&aside) {
                put_back(&aside, target);
                return Err(match error.kind() {
                    io::ErrorKind::DirectoryNotEmpty => {
                        SandboxError::TargetNotEmpty(target.display().to_string())
                    }
                    _ => io_error(target, &error),
                });
            }
            None
        }
        aside => aside,
    };
    if let Err(error) = fs::rename(staging, target) {
        if let Some(aside) = &aside {
            put_back(aside, target);
        }
        return Err(io_error(target, &error));
    }
    if let Some(aside) = aside {
        remove_ours(&aside);
    }
    Ok(())
}

fn put_back(aside: &Path, target: &Path) {
    if let Err(error) = fs::rename(aside, target) {
        tracing::error!(
            aside = %aside.display(),
            %error,
            "the previous folder could not be put back; the next replay renames it back"
        );
    }
}

/// Removes a folder this module made; a failure is left for the next replay's sweep.
fn remove_ours(path: &Path) {
    if let Err(error) = fs::remove_dir_all(path)
        && error.kind() != io::ErrorKind::NotFound
    {
        tracing::warn!(path = %path.display(), %error, "could not remove a sandbox replay folder");
    }
}

fn unique() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub(super) fn io_error(path: &Path, error: &io::Error) -> SandboxError {
    SandboxError::Io {
        path: path.display().to_string(),
        message: error.to_string(),
    }
}
