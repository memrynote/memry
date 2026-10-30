//! The rules a directory meets before this app removes it, and how its paths compare. Each rule
//! refuses what it cannot prove: a removal that is not shown safe is skipped, never attempted.

use std::path::{Component, Path, PathBuf};

use super::layout::{self, Level};
use super::{APP_EXE, Context, Keep, Registration, UNINSTALLER};

/// The NSIS update path moves the install here and arms a `RunOnce` restore (Electron's
/// `build/installer.nsh`); while it exists a restore may still be pending.
const BACKUP_SUFFIX: &str = ".update-backup";
const TOMBSTONE_SUFFIX: &str = ".memry-retired";

/// The directory, canonical, when every rule holds.
pub(super) fn validate(
    dir: &Path,
    registration: &Registration,
    ctx: &Context<'_>,
) -> Result<PathBuf, Keep> {
    let canonical = check_location(dir, ctx)?;
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
    Ok(canonical)
}

/// `path`, canonical, when no link lies on it, it is no drive root, it neither holds nor lies in
/// this install, and it is not and does not hold one of the user's roots. Run on the NSIS
/// directory and again on a recorded tombstone before anything in it is deleted.
pub(super) fn check_location(path: &Path, ctx: &Context<'_>) -> Result<PathBuf, Keep> {
    if path
        .ancestors()
        .any(|part| part.symlink_metadata().is_ok_and(|meta| is_link(&meta)))
    {
        return Err(Keep::Reparse);
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| Keep::NotElectron)?;
    let parts = layout::components(&canonical).ok_or(Keep::Uncomparable)?;
    if !canonical
        .components()
        .any(|part| matches!(part, Component::Normal(_)))
    {
        return Err(Keep::DriveRoot);
    }
    if roots(ctx.own_install)?
        .iter()
        .any(|own| layout::within(&parts, own) || layout::within(own, &parts))
    {
        return Err(Keep::OwnInstall);
    }
    if roots(ctx.user_roots)?
        .iter()
        .any(|root| layout::within(root, &parts))
    {
        return Err(Keep::UserRoot);
    }
    Ok(canonical)
}

/// Every path in comparable form. One that cannot be compared refuses the removal, since the
/// directory might be it.
fn roots(paths: &[PathBuf]) -> Result<Vec<Vec<String>>, Keep> {
    paths
        .iter()
        .map(|path| comparable(path).ok_or(Keep::Uncomparable))
        .collect()
}

/// Every entry is one an Electron install has, `resources\` and `locales\` included, and none is
/// a link.
pub(super) fn check_entries(dir: &Path) -> Result<(), Keep> {
    check_level(dir, Level::Top)
}

fn check_level(dir: &Path, level: Level) -> Result<(), Keep> {
    let entries = std::fs::read_dir(dir).map_err(|_| Keep::NotElectron)?;
    for entry in entries {
        let entry = entry.map_err(|_| Keep::NotElectron)?;
        let path = entry.path();
        let meta = path.symlink_metadata().map_err(|_| Keep::NotElectron)?;
        if is_link(&meta) {
            return Err(Keep::Reparse);
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !layout::allowed(level, &name, meta.is_dir()) {
            return Err(Keep::ExtraEntry);
        }
        if level == Level::Top
            && meta.is_dir()
            && let Some(inner) = layout::subdir(&name)
        {
            check_level(&path, inner)?;
        }
    }
    Ok(())
}

pub(super) fn tombstone_of(dir: &Path) -> Option<PathBuf> {
    sibling(dir, TOMBSTONE_SUFFIX)
}

pub(super) fn backup_of(dir: &Path) -> Option<PathBuf> {
    sibling(dir, BACKUP_SUFFIX)
}

fn sibling(dir: &Path, suffix: &str) -> Option<PathBuf> {
    let name = dir.file_name()?.to_string_lossy();
    Some(dir.with_file_name(format!("{name}{suffix}")))
}

/// The path's comparable form: canonical when it exists, as given otherwise.
fn comparable(path: &Path) -> Option<Vec<String>> {
    layout::components(&std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned()))
}

/// `path` is `dir` or lies below it, compared as Windows compares paths (a process image against
/// the directory, for [`super::LeftoverHost::wait_until_unused`]).
pub fn lies_within(path: &Path, dir: &Path) -> bool {
    matches!(
        (layout::components(path), layout::components(dir)),
        (Some(path), Some(dir)) if layout::within(&path, &dir)
    )
}

pub(super) fn same_path(a: &Path, b: &Path) -> bool {
    matches!((comparable(a), comparable(b)), (Some(a), Some(b)) if a == b)
}

pub(super) fn exists(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

/// A link: on Windows any reparse point (a junction, a symlink, a cloud placeholder), elsewhere
/// a symlink.
fn is_link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    meta.file_type().is_symlink()
}
