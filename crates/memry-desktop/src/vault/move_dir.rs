//! Moving a folder of the vault, including one Windows will not rename whole (a port of
//! `apps/desktop/src/main/vault/move-directory.ts`).
//!
//! Windows refuses to rename a folder while something beneath it is held open (an editor, an
//! indexer, a watcher that holds every folder, #2206), and retrying does not help while the
//! holder stays. A plain rename is tried first. When it is refused that way, the tree moves
//! entry by entry: a subfolder that renames moves whole, one that does not is made again and
//! its entries moved into it, and each emptied source folder is removed. The entries go into a
//! dot-named staging folder beside the target (`.memry-move-<hex>`), which the vault watcher
//! ignores, and the staging folder is renamed to the target last: the watcher sees the folder
//! appear whole, as after a plain rename, and pairs each note with its move.
//!
//! - All or nothing: a step that fails undoes every step before it, last first, and the move
//!   returns that first error. A failed move never leaves a folder split in two.
//! - The move never merges into a folder that is there: an existing target is refused before
//!   anything moves. A case-only rename (`journal` to `Journal`) names the source itself on a
//!   case-insensitive volume, so it is not a merge.
//! - A source folder is removed only when empty (`remove_dir`, never recursive): a file that
//!   lands in it mid-move fails the move, which rolls back, instead of being deleted with it.
//! - Both paths are the caller's, resolved inside the vault. A source that is a symbolic link
//!   moves as a link, never through it, and so does a link inside the tree.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::fs_atomic::{RETRY_DELAYS_MS, is_transient, with_transient_retry};

const SCOPE: &str = "move_dir";

/// One step of a move, as [`move_dir_checked`]'s hook sees it right before it runs.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step<'a> {
    /// The plain rename of the whole folder.
    Whole {
        from: &'a Path,
        to: &'a Path,
    },
    /// The rename of one entry: a file, a link, a subfolder whole, or the staging folder.
    Entry {
        from: &'a Path,
        to: &'a Path,
    },
    MakeDir(&'a Path),
    RemoveDir(&'a Path),
}

/// Moves the folder `from` to `to`, where nothing is yet (module doc).
pub fn move_dir(from: &Path, to: &Path) -> io::Result<()> {
    move_dir_checked(from, to, &mut |_| Ok(()))
}

/// [`move_dir`] with a hook that runs before every step and can fail it, so a test can make
/// a step fail as Windows does.
#[doc(hidden)]
pub fn move_dir_checked(
    from: &Path,
    to: &Path,
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
) -> io::Result<()> {
    if fs::symlink_metadata(to).is_ok() && !same_folder(from, to) {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "the target folder exists",
        ));
    }
    let refused = match hook(Step::Whole { from, to }).and_then(|()| fs::rename(from, to)) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    if !is_transient(&refused) || fs::symlink_metadata(from)?.file_type().is_symlink() {
        return Err(refused);
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let staging = to.with_file_name(format!(".memry-move-{}", &id[..12]));
    let mut undo = Vec::new();
    let moved = move_entries(from, &staging, &mut undo, hook).and_then(|()| {
        retried(|| {
            hook(Step::Entry { from: &staging, to })?;
            fs::rename(&staging, to)
        })
    });
    if moved.is_err() {
        roll_back(undo);
    }
    moved
}

/// `to` is `from` under another spelling: a folder, not a link, and the same one.
fn same_folder(from: &Path, to: &Path) -> bool {
    let (Ok(source), Ok(target)) = (fs::symlink_metadata(from), fs::symlink_metadata(to)) else {
        return false;
    };
    if !source.is_dir() || !target.is_dir() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        source.dev() == target.dev() && source.ino() == target.ino()
    }
    #[cfg(not(unix))]
    {
        matches!(
            (fs::canonicalize(from), fs::canonicalize(to)),
            (Ok(a), Ok(b)) if a == b
        )
    }
}

fn retried(operation: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    with_transient_retry(&RETRY_DELAYS_MS.map(Duration::from_millis), operation)
}

/// What undoes one step that ran.
enum Undo {
    RemoveDir(PathBuf),
    Rename { from: PathBuf, to: PathBuf },
    MakeDir(PathBuf),
}

/// A folder being moved entry by entry: its entries, read before any moved, and where they go.
struct Level {
    from: PathBuf,
    to: PathBuf,
    entries: std::vec::IntoIter<(OsString, bool)>,
}

/// Makes `to` and lists `from`, whose handle is closed again before its entries move.
fn open_level(
    from: PathBuf,
    to: PathBuf,
    undo: &mut Vec<Undo>,
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
) -> io::Result<Level> {
    hook(Step::MakeDir(&to))?;
    fs::create_dir(&to)?;
    undo.push(Undo::RemoveDir(to.clone()));
    let mut entries = Vec::new();
    for entry in fs::read_dir(&from)? {
        let entry = entry?;
        entries.push((entry.file_name(), entry.file_type()?.is_dir()));
    }
    Ok(Level {
        from,
        to,
        entries: entries.into_iter(),
    })
}

/// Moves the tree under `from` into the new folder `to`, depth first with a stack of its own,
/// so a deep tree costs heap, not thread stack.
fn move_entries(
    from: &Path,
    to: &Path,
    undo: &mut Vec<Undo>,
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
) -> io::Result<()> {
    let mut stack = vec![open_level(from.to_owned(), to.to_owned(), undo, hook)?];
    while let Some(level) = stack.last_mut() {
        let Some((name, is_dir)) = level.entries.next() else {
            let source = stack.pop().map(|level| level.from).unwrap_or_default();
            retried(|| {
                hook(Step::RemoveDir(&source))?;
                fs::remove_dir(&source)
            })?;
            undo.push(Undo::MakeDir(source));
            continue;
        };
        let (source, target) = (level.from.join(&name), level.to.join(&name));
        if is_dir {
            let whole = hook(Step::Entry {
                from: &source,
                to: &target,
            })
            .and_then(|()| fs::rename(&source, &target));
            match whole {
                Ok(()) => undo.push(Undo::Rename {
                    from: target,
                    to: source,
                }),
                Err(error) if !is_transient(&error) => return Err(error),
                Err(_) => stack.push(open_level(source, target, undo, hook)?),
            }
            continue;
        }
        retried(|| {
            hook(Step::Entry {
                from: &source,
                to: &target,
            })?;
            fs::rename(&source, &target)
        })?;
        undo.push(Undo::Rename {
            from: target,
            to: source,
        });
    }
    Ok(())
}

/// Undoes the steps that ran, last first. A step that cannot be undone is logged and the rest
/// still run, so as much as can go back does.
fn roll_back(undo: Vec<Undo>) {
    for step in undo.into_iter().rev() {
        let undone = match &step {
            Undo::RemoveDir(path) => fs::remove_dir(path),
            Undo::Rename { from, to } => retried(|| fs::rename(from, to)),
            Undo::MakeDir(path) => fs::create_dir(path),
        };
        if let Err(error) = undone {
            // The error kind only: the path is note-derived.
            tracing::error!(
                scope = SCOPE,
                kind = ?error.kind(),
                "a step of a failed folder move was not undone"
            );
        }
    }
}
