//! The Electron NSIS install left beside this app (#3555 38d2, bridge plan Windows step 3).
//!
//! Electron builds `v2026-09-12` to `v2026-10-25`, and the ones from before the hand-off existed,
//! update into this app by running `latest.yml`'s installer, a byte copy of Velopack's Setup.
//! Setup installs this app beside the NSIS install, and nothing removes the old one: its
//! directory, its two registry keys and its entry in Settings > Apps stay.
//!
//! The app removes the directory and the two keys itself and never runs the NSIS uninstaller.
//! Under `/S` that uninstaller stops every running `Memrynote.exe` when its PowerShell probe fails
//! (`taskkill /IM`, app-builder-lib `allowOnlyOneInstallerInstance.nsh`), and this app's exe has
//! that name. It would also delete the Start menu and Desktop shortcuts, which are Velopack's
//! now. Nothing else it does applies: `memry://` and the login item already point at this app,
//! and the Electron profile is never touched.
//!
//! Safety, in order:
//! - A leftover is removed no sooner than [`GRACE_MS`] after the first launch that found it, so
//!   the old app stays as a way back for a day.
//! - The directory must look exactly like an Electron install: its anchors, only allowlisted
//!   entries, no links anywhere on its path. It must sit apart from this install and must not be
//!   or hold one of the user's roots. No process may run from it.
//! - It is renamed to a tombstone recorded first (the rename fails while any file is open),
//!   checked again, deleted, and only then are the keys deleted. A removal cut short resumes from
//!   the recorded tombstone and never touches one it did not record.

mod layout;
mod state;
#[cfg(test)]
pub(crate) mod tests;

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

pub use state::{LeftoverState, STATE_FILENAME};

/// UUIDv5 of the app id `com.memrynote.memry` in electron-builder's namespace
/// (`NsisTarget.js`: `UUID.v5(appInfo.id, ELECTRON_BUILDER_NS_UUID)`). Both NSIS keys are named
/// by it, so neither can be Velopack's key (`MemryNote`).
pub const NSIS_APP_GUID: &str = "ddabaefe-4f06-5be8-b883-26938e9d11a8";
/// `INSTALL_REGISTRY_KEY` under `HKCU`, which holds `InstallLocation`.
pub const INSTALL_KEY: &str = r"Software\ddabaefe-4f06-5be8-b883-26938e9d11a8";
/// `UNINSTALL_REGISTRY_KEY` under `HKCU`: the Settings > Apps entry, with `UninstallString`.
pub const UNINSTALL_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Uninstall\ddabaefe-4f06-5be8-b883-26938e9d11a8";

/// How long a found leftover stays before it is removed.
pub const GRACE_MS: u64 = 24 * 60 * 60 * 1000;
/// How long the removal waits for a process running from the directory to exit.
pub const EXIT_WAIT: Duration = Duration::from_secs(30);

const APP_EXE: &str = "Memrynote.exe";
/// The uninstaller as the shipped builds name it.
const UNINSTALLER: &str = "Uninstall Memrynote.exe";
const TOMBSTONE_SUFFIX: &str = ".memry-retired";
/// The NSIS update path moves the install here and arms a `RunOnce` restore (Electron's
/// `build/installer.nsh`); while it exists a restore may still be pending.
const BACKUP_SUFFIX: &str = ".update-backup";

/// The NSIS install's registry values.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Registration {
    /// `InstallLocation` of [`INSTALL_KEY`].
    pub install_location: Option<String>,
    /// `UninstallString` of [`UNINSTALL_KEY`]: `"<dir>\Uninstall Memrynote.exe" /currentuser`.
    pub uninstall_string: Option<String>,
}

impl Registration {
    fn uninstaller(&self) -> Option<PathBuf> {
        let quoted = self.uninstall_string.as_deref()?.trim().strip_prefix('"')?;
        let path = &quoted[..quoted.find('"')?];
        (!path.is_empty()).then(|| PathBuf::from(path))
    }

    /// `InstallLocation`, else the uninstaller's directory.
    fn location(&self) -> Option<PathBuf> {
        match self.install_location.as_deref().map(str::trim) {
            Some(location) if !location.is_empty() => Some(PathBuf::from(location)),
            _ => self.uninstaller()?.parent().map(Path::to_owned),
        }
    }
}

/// The OS side: the registry and the processes. The Tauri crate implements it on Windows.
pub trait LeftoverHost {
    /// The per-user install's values, when either key exists under `HKCU`.
    fn per_user(&self) -> Option<Registration>;
    /// A per-machine install's keys exist under `HKLM`. Removing it needs elevation.
    fn per_machine(&self) -> bool;
    /// Waits up to `bound` for every process whose image lies in `dir` to exit. True once none
    /// runs.
    fn wait_until_unused(&self, dir: &Path, bound: Duration) -> bool;
    /// Deletes both keys under `HKCU`. A missing key is no error.
    fn delete_registration(&self) -> std::io::Result<()>;
}

pub struct Context<'a> {
    /// Where [`STATE_FILENAME`] lives.
    pub data_dir: &'a Path,
    /// This install: the Velopack root and the running exe's directory. The leftover may not be,
    /// hold or lie inside any of them.
    pub own_install: &'a [PathBuf],
    /// The user's home and app data roots. The leftover may lie inside one, never be or hold one.
    pub user_roots: &'a [PathBuf],
    /// Where taskbar pins keep their shortcuts.
    pub pins_dir: Option<&'a Path>,
    pub now_ms: u64,
}

/// Why the leftover stays this launch. Telemetry carries [`Keep::as_str`], never a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keep {
    PerMachine,
    NotElectron,
    UnsafeLocation,
    Reparse,
    ExtraEntry,
    BackupPending,
    StaleTombstone,
    InUse,
    PartialDelete,
    Registry,
}

impl Keep {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PerMachine => "per_machine",
            Self::NotElectron => "not_electron",
            Self::UnsafeLocation => "unsafe_location",
            Self::Reparse => "reparse",
            Self::ExtraEntry => "extra_entry",
            Self::BackupPending => "backup_pending",
            Self::StaleTombstone => "stale_tombstone",
            Self::InUse => "in_use",
            Self::PartialDelete => "partial_delete",
            Self::Registry => "registry",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No leftover.
    None,
    /// A leftover waits for [`GRACE_MS`] to pass.
    Waiting,
    /// Removed, directory and keys, with the count of taskbar pins that pointed into it.
    Retired { stale_pins: usize },
    /// Kept this launch. `first_report` is false when the last launch kept it for this reason.
    Kept { reason: Keep, first_report: bool },
}

/// One pass, on a blocking thread: finds the leftover and removes it once that is safe.
pub fn retire(host: &dyn LeftoverHost, ctx: &Context<'_>) -> Outcome {
    let mut state = state::read(ctx.data_dir);
    if let Some(tombstone) = state.tombstone.clone()
        && let Some(outcome) = resume(host, ctx, &mut state, Path::new(&tombstone))
    {
        return outcome;
    }
    let Some(registration) = host.per_user() else {
        if host.per_machine() {
            return keep(ctx, &mut state, Keep::PerMachine);
        }
        save(ctx, &LeftoverState::default());
        return Outcome::None;
    };
    let Some(dir) = registration.location() else {
        return keep(ctx, &mut state, Keep::NotElectron);
    };
    let location = layout::display(&dir);
    if !exists(&dir) {
        // A drive that is not attached: the files may come back with it.
        if !dir.parent().is_some_and(exists) {
            return keep(ctx, &mut state, Keep::UnsafeLocation);
        }
        // Removed by hand: only the dead Settings > Apps entry is left.
        if registration.uninstaller().is_some_and(|path| exists(&path)) {
            return keep(ctx, &mut state, Keep::NotElectron);
        }
        return delete_keys(host, ctx, &mut state, &location);
    }
    let first_seen = match state.first_seen_at {
        Some(at) if state.install_location.as_deref() == Some(location.as_str()) => at,
        _ => {
            tracing::info!(
                scope = "NsisLeftover",
                "found the NSIS install an Electron build left; it is removed on a launch a day from now"
            );
            state = LeftoverState {
                first_seen_at: Some(ctx.now_ms),
                install_location: Some(location),
                ..LeftoverState::default()
            };
            save(ctx, &state);
            return Outcome::Waiting;
        }
    };
    if ctx.now_ms.saturating_sub(first_seen) < GRACE_MS {
        return Outcome::Waiting;
    }
    let dir = match validate(&dir, &registration, ctx) {
        Ok(dir) => dir,
        Err(reason) => return keep(ctx, &mut state, reason),
    };
    if !host.wait_until_unused(&dir, EXIT_WAIT) {
        return keep(ctx, &mut state, Keep::InUse);
    }
    let Some(tombstone) = tombstone_of(&dir) else {
        return keep(ctx, &mut state, Keep::UnsafeLocation);
    };
    if exists(&tombstone) {
        return keep(ctx, &mut state, Keep::StaleTombstone);
    }
    state.tombstone = Some(tombstone.to_string_lossy().into_owned());
    if let Err(error) = state::write(ctx.data_dir, &state) {
        tracing::warn!(
            scope = "NsisLeftover",
            "could not record the removal, so nothing is removed: {error}"
        );
        return Outcome::Waiting;
    }
    if let Err(error) = std::fs::rename(&dir, &tombstone) {
        tracing::info!(
            scope = "NsisLeftover",
            "the NSIS install is in use ({error}); trying again at the next launch"
        );
        state.tombstone = None;
        return keep(ctx, &mut state, Keep::InUse);
    }
    // A file that appeared between the check and the rename: put the directory back.
    if let Err(reason) = check_entries(&tombstone) {
        if std::fs::rename(&tombstone, &dir).is_ok() {
            state.tombstone = None;
        }
        return keep(ctx, &mut state, reason);
    }
    finish(host, ctx, &mut state, &tombstone)
}

/// A removal an earlier launch started. `None` when it never renamed the directory, so this pass
/// starts over.
fn resume(
    host: &dyn LeftoverHost,
    ctx: &Context<'_>,
    state: &mut LeftoverState,
    tombstone: &Path,
) -> Option<Outcome> {
    let renamed = state
        .install_location
        .as_deref()
        .is_some_and(|origin| !exists(Path::new(origin)));
    if !renamed {
        state.tombstone = None;
        save(ctx, state);
        return None;
    }
    if exists(tombstone)
        && let Err(reason) = check_entries(tombstone)
    {
        return Some(keep(ctx, state, reason));
    }
    Some(finish(host, ctx, state, tombstone))
}

fn finish(
    host: &dyn LeftoverHost,
    ctx: &Context<'_>,
    state: &mut LeftoverState,
    tombstone: &Path,
) -> Outcome {
    if exists(tombstone)
        && let Err(error) = std::fs::remove_dir_all(tombstone)
    {
        tracing::warn!(
            scope = "NsisLeftover",
            "could not finish removing the NSIS install: {error}"
        );
        return keep(ctx, state, Keep::PartialDelete);
    }
    let origin = state.install_location.clone().unwrap_or_default();
    // The keys go only while they still name the directory this removal took.
    let names_origin = host.per_user().is_some_and(|registration| {
        registration
            .location()
            .is_some_and(|location| same_path(&location, Path::new(&origin)))
    });
    if !names_origin {
        return retired(ctx, &origin);
    }
    delete_keys(host, ctx, state, &origin)
}

fn delete_keys(
    host: &dyn LeftoverHost,
    ctx: &Context<'_>,
    state: &mut LeftoverState,
    location: &str,
) -> Outcome {
    if let Err(error) = host.delete_registration() {
        tracing::warn!(
            scope = "NsisLeftover",
            "could not delete the NSIS install's registry keys: {error}"
        );
        return keep(ctx, state, Keep::Registry);
    }
    retired(ctx, location)
}

fn retired(ctx: &Context<'_>, location: &str) -> Outcome {
    save(ctx, &LeftoverState::default());
    let stale_pins = ctx
        .pins_dir
        .map_or(0, |pins| layout::count_links_into(pins, location));
    Outcome::Retired { stale_pins }
}

fn keep(ctx: &Context<'_>, state: &mut LeftoverState, reason: Keep) -> Outcome {
    let first_report = state.reported.as_deref() != Some(reason.as_str());
    state.reported = Some(reason.as_str().to_owned());
    save(ctx, state);
    Outcome::Kept {
        reason,
        first_report,
    }
}

fn save(ctx: &Context<'_>, state: &LeftoverState) {
    if let Err(error) = state::write(ctx.data_dir, state) {
        tracing::warn!(
            scope = "NsisLeftover",
            "could not write {STATE_FILENAME}: {error}"
        );
    }
}

/// The directory, canonical, when every rule holds.
fn validate(dir: &Path, registration: &Registration, ctx: &Context<'_>) -> Result<PathBuf, Keep> {
    if !dir.is_absolute() {
        return Err(Keep::UnsafeLocation);
    }
    if dir
        .ancestors()
        .any(|path| path.symlink_metadata().is_ok_and(|meta| is_link(&meta)))
    {
        return Err(Keep::Reparse);
    }
    let canonical = std::fs::canonicalize(dir).map_err(|_| Keep::UnsafeLocation)?;
    let parts = layout::components(&canonical).ok_or(Keep::UnsafeLocation)?;
    let depth = canonical
        .components()
        .filter(|part| matches!(part, Component::Normal(_)))
        .count();
    if depth < 2 {
        return Err(Keep::UnsafeLocation);
    }
    if ctx
        .own_install
        .iter()
        .filter_map(|path| comparable(path))
        .any(|own| layout::within(&parts, &own) || layout::within(&own, &parts))
    {
        return Err(Keep::UnsafeLocation);
    }
    if ctx
        .user_roots
        .iter()
        .filter_map(|path| comparable(path))
        .any(|root| layout::within(&root, &parts))
    {
        return Err(Keep::UnsafeLocation);
    }
    let uninstaller = canonical.join(UNINSTALLER);
    let anchors = [
        canonical.join(APP_EXE),
        canonical.join("resources").join("app.asar"),
        uninstaller.clone(),
    ];
    if !anchors.iter().all(|path| path.is_file()) {
        return Err(Keep::NotElectron);
    }
    if registration.uninstall_string.is_some()
        && !registration
            .uninstaller()
            .is_some_and(|named| same_path(&named, &uninstaller))
    {
        return Err(Keep::NotElectron);
    }
    check_entries(&canonical)?;
    let backup = canonical
        .file_name()
        .map(|name| canonical.with_file_name(format!("{}{BACKUP_SUFFIX}", name.to_string_lossy())));
    if backup.is_some_and(|path| exists(&path)) {
        return Err(Keep::BackupPending);
    }
    Ok(canonical)
}

/// Every top-level entry is one an Electron install has, and none is a link.
fn check_entries(dir: &Path) -> Result<(), Keep> {
    let entries = std::fs::read_dir(dir).map_err(|_| Keep::NotElectron)?;
    for entry in entries {
        let entry = entry.map_err(|_| Keep::NotElectron)?;
        let meta = entry
            .path()
            .symlink_metadata()
            .map_err(|_| Keep::NotElectron)?;
        if is_link(&meta) {
            return Err(Keep::Reparse);
        }
        if !layout::allowed_entry(&entry.file_name().to_string_lossy(), meta.is_dir()) {
            return Err(Keep::ExtraEntry);
        }
    }
    Ok(())
}

fn tombstone_of(dir: &Path) -> Option<PathBuf> {
    let name = dir.file_name()?.to_string_lossy();
    Some(dir.with_file_name(format!("{name}{TOMBSTONE_SUFFIX}")))
}

/// The path's comparable form: canonical when it exists, as given otherwise.
fn comparable(path: &Path) -> Option<Vec<String>> {
    layout::components(&std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned()))
}

/// `path` is `dir` or lies below it, compared as Windows compares paths (a process image against
/// the directory, for [`LeftoverHost::wait_until_unused`]).
pub fn lies_within(path: &Path, dir: &Path) -> bool {
    matches!(
        (layout::components(path), layout::components(dir)),
        (Some(path), Some(dir)) if layout::within(&path, &dir)
    )
}

fn same_path(a: &Path, b: &Path) -> bool {
    matches!((comparable(a), comparable(b)), (Some(a), Some(b)) if a == b)
}

fn exists(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

/// A symlink, or on Windows any reparse point (a junction is not a symlink to std).
fn is_link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}
