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
//!   the old app stays as a way back for a day. The wait reads the wall clock: one set back
//!   restarts it, one set forward shortens it.
//! - Nothing happens while the NSIS update path may still restore the install from its backup.
//! - The directory must look exactly like an Electron install: its anchors, only allowlisted
//!   entries in it, `resources\` and `locales\`, no links anywhere on its path. It must sit
//!   apart from this install and must not be or hold one of the user's roots. No process may run
//!   from it. Whatever cannot be shown safe is skipped (`checks`).
//! - It is renamed to a tombstone recorded first (the rename fails while any file is open),
//!   checked again, deleted, and only then are the keys deleted. A removal cut short resumes from
//!   the recorded tombstone after the same checks, and never touches one it did not record.
//!
//! Known limits: builds before `v2026-06-10` named their exe otherwise, so their installs stay
//! (`layout`). Taskbar pins into the directory go stale; the report counts them.

mod checks;
mod layout;
mod state;
#[cfg(test)]
pub(crate) mod tests;

use std::path::{Path, PathBuf};
use std::time::Duration;

use checks::exists;
pub use checks::lies_within;
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

/// `HKCU` key and value of the restore the NSIS update path arms (Electron's
/// `build/installer.nsh`: `MEMRY_RUNONCE_NAME` is `${APP_ID}.update-restore`).
pub const RESTORE_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\RunOnce";
pub const RESTORE_VALUE: &str = "com.memrynote.memry.update-restore";

/// How long a found leftover stays before it is removed.
pub const GRACE_MS: u64 = 24 * 60 * 60 * 1000;
/// How long the removal waits for a process running from the directory to exit.
pub const EXIT_WAIT: Duration = Duration::from_secs(30);

const APP_EXE: &str = "Memrynote.exe";
/// The uninstaller as the shipped builds name it.
const UNINSTALLER: &str = "Uninstall Memrynote.exe";

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
    /// [`RESTORE_VALUE`] is set under [`RESTORE_KEY`]: the next sign-in may restore the install.
    fn restore_pending(&self) -> bool;
}

pub struct Context<'a> {
    /// Where [`STATE_FILENAME`] lives.
    pub data_dir: &'a Path,
    /// This install: the Velopack root and the running exe's directory. The leftover may not be,
    /// hold or lie inside any of them.
    pub own_install: &'a [PathBuf],
    /// The user's home and app data roots, this app's data directory and the Electron profile.
    /// The leftover may lie inside one, never be or hold one.
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
    /// `InstallLocation` is no absolute path.
    Relative,
    DriveRoot,
    /// A network share, a device path, or a path that climbs with `..`, on the directory or on a
    /// root it is compared with.
    Uncomparable,
    OwnInstall,
    UserRoot,
    /// The directory and its parent are missing: a drive that is not attached.
    Offline,
    Reparse,
    ExtraEntry,
    BackupPending,
    StaleTombstone,
    InUse,
    AccessDenied,
    RenameFailed,
    PartialDelete,
    Registry,
}

impl Keep {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PerMachine => "per_machine",
            Self::NotElectron => "not_electron",
            Self::Relative => "relative",
            Self::DriveRoot => "drive_root",
            Self::Uncomparable => "uncomparable_path",
            Self::OwnInstall => "own_install",
            Self::UserRoot => "user_root",
            Self::Offline => "offline",
            Self::Reparse => "reparse",
            Self::ExtraEntry => "extra_entry",
            Self::BackupPending => "backup_pending",
            Self::StaleTombstone => "stale_tombstone",
            Self::InUse => "in_use",
            Self::AccessDenied => "access_denied",
            Self::RenameFailed => "rename_failed",
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
    /// Removed, with the count of taskbar pins that pointed into it. `files` is false when only
    /// the keys were left, the directory already gone.
    Retired { stale_pins: usize, files: bool },
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
    if !dir.is_absolute() {
        return keep(ctx, &mut state, Keep::Relative);
    }
    // The directory may be about to come back from its backup, or be half restored.
    if host.restore_pending() || checks::backup_of(&dir).is_some_and(|backup| exists(&backup)) {
        return keep(ctx, &mut state, Keep::BackupPending);
    }
    let location = layout::display(&dir);
    if !exists(&dir) {
        // A drive that is not attached: the files may come back with it.
        if !dir.parent().is_some_and(exists) {
            return keep(ctx, &mut state, Keep::Offline);
        }
        // Removed by hand: only the dead Settings > Apps entry is left.
        if registration.uninstaller().is_some_and(|path| exists(&path)) {
            return keep(ctx, &mut state, Keep::NotElectron);
        }
        return delete_keys(host, ctx, &mut state, &location, false);
    }
    let first_seen = state
        .first_seen_at
        .filter(|&at| at <= ctx.now_ms && state.install_location.as_deref() == Some(&location));
    let Some(first_seen) = first_seen else {
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
    };
    if ctx.now_ms - first_seen < GRACE_MS {
        return Outcome::Waiting;
    }
    let dir = match checks::validate(&dir, &registration, ctx) {
        Ok(dir) => dir,
        Err(reason) => return keep(ctx, &mut state, reason),
    };
    if !host.wait_until_unused(&dir, EXIT_WAIT) {
        return keep(ctx, &mut state, Keep::InUse);
    }
    let Some(tombstone) = checks::tombstone_of(&dir) else {
        return keep(ctx, &mut state, Keep::DriveRoot);
    };
    if exists(&tombstone) {
        return keep(ctx, &mut state, Keep::StaleTombstone);
    }
    state.origin = Some(dir.to_string_lossy().into_owned());
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
            "could not rename the NSIS install ({error}); trying again at the next launch"
        );
        state.origin = None;
        state.tombstone = None;
        return keep(ctx, &mut state, rename_failure(&error));
    }
    // A file that appeared between the check and the rename: put the directory back.
    if let Err(reason) = checks::check_entries(&tombstone) {
        if std::fs::rename(&tombstone, &dir).is_ok() {
            state.origin = None;
            state.tombstone = None;
        }
        return keep(ctx, &mut state, reason);
    }
    finish(host, ctx, &mut state, &tombstone, &dir)
}

/// The rename's error as a reason: a file open in the directory, no right to rename it, or else.
fn rename_failure(error: &std::io::Error) -> Keep {
    // ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION.
    const IN_USE: [i32; 2] = [32, 33];
    if cfg!(windows)
        && error
            .raw_os_error()
            .is_some_and(|code| IN_USE.contains(&code))
    {
        Keep::InUse
    } else if error.kind() == std::io::ErrorKind::PermissionDenied {
        Keep::AccessDenied
    } else {
        Keep::RenameFailed
    }
}

/// A removal an earlier launch recorded. `None` when it never renamed the directory, so this
/// pass starts over.
fn resume(
    host: &dyn LeftoverHost,
    ctx: &Context<'_>,
    state: &mut LeftoverState,
    tombstone: &Path,
) -> Option<Outcome> {
    // Only the name this app derives from the directory it took.
    let Some(origin) = state
        .origin
        .as_deref()
        .map(PathBuf::from)
        .filter(|origin| checks::tombstone_of(origin).as_deref() == Some(tombstone))
    else {
        return Some(keep(ctx, state, Keep::StaleTombstone));
    };
    if exists(tombstone) {
        let checked = checks::check_location(tombstone, ctx)
            .and_then(|canonical| checks::check_entries(&canonical));
        if let Err(reason) = checked {
            return Some(keep(ctx, state, reason));
        }
    } else if exists(&origin) {
        // Recorded, never renamed.
        state.origin = None;
        state.tombstone = None;
        save(ctx, state);
        return None;
    }
    Some(finish(host, ctx, state, tombstone, &origin))
}

fn finish(
    host: &dyn LeftoverHost,
    ctx: &Context<'_>,
    state: &mut LeftoverState,
    tombstone: &Path,
    origin: &Path,
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
    let location = state
        .install_location
        .clone()
        .unwrap_or_else(|| layout::display(origin));
    // The keys go only while they still name the directory this removal took, and nothing was
    // installed there again.
    let names_origin = !exists(origin)
        && host.per_user().is_some_and(|registration| {
            registration.location().is_some_and(|named| {
                checks::same_path(&named, origin) || checks::same_path(&named, Path::new(&location))
            })
        });
    if !names_origin {
        return retired(ctx, &location, true);
    }
    delete_keys(host, ctx, state, &location, true)
}

fn delete_keys(
    host: &dyn LeftoverHost,
    ctx: &Context<'_>,
    state: &mut LeftoverState,
    location: &str,
    files: bool,
) -> Outcome {
    if let Err(error) = host.delete_registration() {
        tracing::warn!(
            scope = "NsisLeftover",
            "could not delete the NSIS install's registry keys: {error}"
        );
        return keep(ctx, state, Keep::Registry);
    }
    retired(ctx, location, files)
}

fn retired(ctx: &Context<'_>, location: &str, files: bool) -> Outcome {
    save(ctx, &LeftoverState::default());
    let stale_pins = ctx
        .pins_dir
        .map_or(0, |pins| layout::count_links_into(pins, location));
    Outcome::Retired { stale_pins, files }
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
