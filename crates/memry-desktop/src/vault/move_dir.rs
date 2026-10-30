//! Moving a folder of the vault, including one Windows will not rename whole (a port of
//! `apps/desktop/src/main/vault/move-directory.ts`).
//!
//! Windows refuses to rename a folder while something beneath it is held open (an editor, an
//! indexer, a watcher that holds every folder, #2206), and retrying does not help while the
//! holder stays. A plain rename is tried first. On Windows, when it is refused that way, the
//! tree moves entry by entry: a subfolder that renames moves whole, one that does not is made
//! again and its entries moved into it, and each emptied source folder is removed. The entries
//! go into a dot-named staging folder beside the target (`.memry-move-<hex>`), which the vault
//! watcher ignores, and the staging folder is renamed to the target last: the watcher sees the
//! moved folder appear whole, as after a plain rename, never half of it. On other systems a
//! refused rename is the answer (`EPERM`, `EACCES` or `EBUSY` there is a permission or a mount
//! point, not a hold).
//!
//! This module moves files, not notes: which note each moved file belongs to is the caller's
//! to keep. The watcher pairs a file that went with one that appeared only by content hash and
//! within its rename window (`watch::rename`), which a large or entry-wise move outlasts and a
//! row without a hash never meets. The caller re-points the notes' `note_files` rows and keeps
//! the write-back off the subtree while it moves (13h, #3530).
//!
//! - Nothing is ever replaced. Every rename of a move and of its rollback is
//!   [`rename_no_replace`], except the plain rename of a case-only move (`journal` to
//!   `Journal`), whose target names the source itself on a case-insensitive volume. An
//!   existing target and a target inside the source are refused before anything moves.
//! - All or nothing, else visible. A step that fails rolls the move back: everything in the
//!   staging folder goes back to its path in the source, and the move returns that first
//!   error. A name taken meanwhile (a save at a moved file's old path) keeps its file, and the
//!   one coming back lands beside it as `<name> (conflict copy)<ext>`. What cannot go back
//!   waits in `<source name> (incomplete move)` beside the target, never in the hidden staging
//!   folder. Either way the move returns [`IncompleteRollback`], not the first error.
//! - A source folder is removed only when empty (`remove_dir`, never recursive): a file that
//!   lands in it mid-move fails the move, which rolls back, instead of being deleted with it.
//! - Both paths are the caller's, resolved inside the vault. A source that is a symbolic link
//!   moves as a link, never through it, and so does a link inside the tree, on the way back
//!   too: a link that took a folder's name is never merged into.
//! - A crash mid-move is undone at the next open: before its staging folder exists, a move
//!   journals itself in the vault, and the open sweeps the journal ([`super::move_journal`]).

use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::fs_atomic::{RETRY_DELAYS_MS, is_transient, rename_no_replace, with_transient_retry};
use super::move_journal::{ID_LEN, Journaled, STAGING_PREFIX, vault_relative};

const SCOPE: &str = "move_dir";

/// How many steps of a rollback may wait out a refusal before the rest get one try each, so
/// a tree whose every file is refused costs seconds, not one retry schedule per file.
const ROLLBACK_RETRIES: u32 = 4;

/// The most conflict names tried for one entry.
const CONFLICT_NAMES: u32 = 1000;

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
    /// A rollback's rename of a staged entry back, to its name or a conflict name, or of what
    /// is left into the visible folder.
    PutBack {
        from: &'a Path,
        to: &'a Path,
    },
    /// A rollback makes a folder again to put its entries back one by one.
    RemakeDir(&'a Path),
    /// A rollback removes a staged folder it emptied.
    RemoveStaged(&'a Path),
    /// The move's journal record is dropped: the move is done or fully undone.
    Forget(&'a Path),
}

/// A failed move whose rollback could not put everything back under its own name. The move
/// returns it in place of its first error, inside an `io::Error` ([`IncompleteRollback::of`]).
#[derive(Debug)]
pub struct IncompleteRollback {
    /// The error that failed the move.
    pub cause: io::Error,
    /// Entries that came back beside the one that took their name meanwhile, under a
    /// conflict name.
    pub conflict_copies: Vec<PathBuf>,
    /// Folders holding what could not go back, at its path in the source: the visible
    /// `<source name> (incomplete move)` beside the target, and the hidden staging folder only
    /// when not even that rename went through (the next open's sweep puts it back).
    pub kept: Vec<PathBuf>,
}

impl IncompleteRollback {
    pub fn of(error: &io::Error) -> Option<&Self> {
        error.get_ref()?.downcast_ref()
    }
}

impl fmt::Display for IncompleteRollback {
    // The error kind and counts only: the paths are note-derived.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the folder move failed ({:?}) and was not fully undone: {} conflict copies, {} folders kept",
            self.cause.kind(),
            self.conflict_copies.len(),
            self.kept.len()
        )
    }
}

impl std::error::Error for IncompleteRollback {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}

/// A hold a test makes a step fail with, taken for the refusal Windows gives a folder
/// something beneath holds open, on every system.
#[doc(hidden)]
pub fn simulated_hold() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, SimulatedHold)
}

#[derive(Debug)]
struct SimulatedHold;

impl fmt::Display for SimulatedHold {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("held open beneath (simulated)")
    }
}

impl std::error::Error for SimulatedHold {}

/// The refusal Windows gives a folder something beneath holds open: access denied (5), which
/// a real denial by the folder's ACL also gives (that move goes entry by entry, is refused
/// again and rolls back), or a sharing or lock violation.
fn is_hold(error: &io::Error) -> bool {
    (cfg!(windows) && is_transient(error))
        || error
            .get_ref()
            .is_some_and(|inner| inner.is::<SimulatedHold>())
}

/// Moves the folder `from` to `to`, where nothing is yet (module doc). Both are folders of
/// `vault` (`InvalidInput` otherwise), whose `.memry/moves/` journals an entry-wise move.
pub fn move_dir(vault: &Path, from: &Path, to: &Path) -> io::Result<()> {
    move_dir_checked(vault, from, to, &mut |_| Ok(()))
}

/// [`move_dir`] with a hook that runs before every step and can fail it, so a test can make
/// a step fail as Windows does.
#[doc(hidden)]
pub fn move_dir_checked(
    vault: &Path,
    from: &Path,
    to: &Path,
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
) -> io::Result<()> {
    let source = fs::symlink_metadata(from)?;
    let from_rel = vault_relative(vault, from)?;
    vault_relative(vault, to)?;
    let itself = same_folder(from, to);
    if !itself && (to.starts_with(from) || to.ancestors().skip(1).any(|a| same_folder(from, a))) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the target is inside the folder",
        ));
    }
    if !itself && fs::symlink_metadata(to).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "the target folder exists",
        ));
    }
    let whole = hook(Step::Whole { from, to }).and_then(|()| {
        if itself {
            // The target is the source under another spelling: nothing else can be replaced.
            fs::rename(from, to)
        } else {
            rename_no_replace(from, to)
        }
    });
    let refused = match whole {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    if !is_hold(&refused) || source.file_type().is_symlink() {
        return Err(refused);
    }
    let id = uuid::Uuid::new_v4().simple().to_string()[..ID_LEN].to_owned();
    let staging = to.with_file_name(format!("{STAGING_PREFIX}{id}"));
    let record = Journaled::write(vault, &id, &from_rel, &vault_relative(vault, &staging)?)?;
    // Only a staging folder this move made is ever rolled back: one that was there fails the
    // move before anything moved.
    if let Err(error) = hook(Step::MakeDir(&staging)).and_then(|()| fs::create_dir(&staging)) {
        record.forget(hook);
        return Err(error);
    }
    let moved = move_entries(from, &staging, hook).and_then(|()| {
        retried(|| {
            hook(Step::Entry { from: &staging, to })?;
            rename_no_replace(&staging, to)
        })
    });
    let result = match moved {
        Ok(()) => Ok(()),
        Err(cause) => roll_back(cause, from, &staging, hook),
    };
    // Files still staged wait, with the record, for the next open's sweep.
    if fs::symlink_metadata(&staging).is_err() {
        record.forget(hook);
    }
    result
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

/// The names in `folder`, read whole before any of them moves, so its handle is closed again.
fn names(folder: &Path) -> io::Result<Vec<(OsString, bool)>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        names.push((entry.file_name(), entry.file_type()?.is_dir()));
    }
    Ok(names)
}

/// A folder being moved entry by entry: its entries, and where they go.
struct Level {
    from: PathBuf,
    to: PathBuf,
    entries: std::vec::IntoIter<(OsString, bool)>,
}

fn open_level(
    from: PathBuf,
    to: PathBuf,
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
) -> io::Result<Level> {
    hook(Step::MakeDir(&to))?;
    fs::create_dir(&to)?;
    let entries = names(&from)?.into_iter();
    Ok(Level { from, to, entries })
}

/// Moves the tree under `from` into the folder `to` the move just made, depth first with a
/// stack of its own, so a deep tree costs heap, not thread stack.
fn move_entries(
    from: &Path,
    to: &Path,
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
) -> io::Result<()> {
    let mut stack = vec![Level {
        from: from.to_owned(),
        to: to.to_owned(),
        entries: names(from)?.into_iter(),
    }];
    while let Some(level) = stack.last_mut() {
        let Some((name, is_dir)) = level.entries.next() else {
            let source = stack.pop().map(|level| level.from).unwrap_or_default();
            retried(|| {
                hook(Step::RemoveDir(&source))?;
                fs::remove_dir(&source)
            })?;
            continue;
        };
        let (source, target) = (level.from.join(&name), level.to.join(&name));
        if is_dir {
            let whole = hook(Step::Entry {
                from: &source,
                to: &target,
            })
            .and_then(|()| rename_no_replace(&source, &target));
            match whole {
                Ok(()) => {}
                Err(error) if !is_hold(&error) => return Err(error),
                Err(_) => stack.push(open_level(source, target, hook)?),
            }
            continue;
        }
        retried(|| {
            hook(Step::Entry {
                from: &source,
                to: &target,
            })?;
            rename_no_replace(&source, &target)
        })?;
    }
    Ok(())
}

/// Puts everything in the staging folder this move made back into `from` after the move failed
/// with `cause`, and moves what does not go back into a visible folder.
fn roll_back(
    cause: io::Error,
    from: &Path,
    staging: &Path,
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
) -> io::Result<()> {
    let left = put_back_staged(from, staging, hook);
    if left.kept.is_empty() && left.conflict_copies.is_empty() {
        return Err(cause);
    }
    Err(io::Error::other(IncompleteRollback {
        cause,
        conflict_copies: left.conflict_copies,
        kept: left.kept,
    }))
}

/// What a put-back left beside the source ([`IncompleteRollback`]).
pub(super) struct Left {
    pub conflict_copies: Vec<PathBuf>,
    pub kept: Vec<PathBuf>,
}

/// Puts everything in `staging` back into `from`, and moves what does not go back into a
/// visible `<from name> (incomplete move)` beside `staging`.
pub(super) fn put_back_staged(
    from: &Path,
    staging: &Path,
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
) -> Left {
    let mut back = PutBack::new(hook);
    back.put(staging, from);
    let name = from.file_name().unwrap_or_default().to_string_lossy();
    let kept = back.keep_in_sight(staging, &name);
    Left {
        conflict_copies: back.conflict_copies,
        kept,
    }
}

/// Renames a staging folder whose source is unknown into a visible `<name> (incomplete move)`
/// beside it. Returns the folders holding its files.
pub(super) fn show_staged(
    staging: &Path,
    name: &str,
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
) -> Vec<PathBuf> {
    PutBack::new(hook).keep_in_sight(staging, name)
}

impl<'h> PutBack<'h> {
    fn new(hook: &'h mut dyn FnMut(Step<'_>) -> io::Result<()>) -> Self {
        PutBack {
            hook,
            budget: Budget(ROLLBACK_RETRIES),
            conflict_copies: Vec::new(),
        }
    }

    /// Moves what is left in `staging` into the first free visible `<name> (incomplete move)`
    /// beside it. Returns the folders that hold it: that one, and `staging` itself when not
    /// even that rename went through.
    fn keep_in_sight(&mut self, staging: &Path, name: &str) -> Vec<PathBuf> {
        let mut kept = Vec::new();
        if fs::symlink_metadata(staging).is_err() {
            return kept;
        }
        let visible = (1..=CONFLICT_NAMES)
            .map(|n| match n {
                1 => format!("{name} (incomplete move)"),
                n => format!("{name} (incomplete move {n})"),
            })
            .map(|candidate| staging.with_file_name(candidate))
            .find(|candidate| fs::symlink_metadata(candidate).is_err());
        if let Some(visible) = visible {
            self.put(staging, &visible);
            if fs::symlink_metadata(&visible).is_ok() {
                kept.push(visible);
            }
        }
        if fs::symlink_metadata(staging).is_ok() {
            tracing::error!(
                scope = SCOPE,
                "a failed folder move left files in its hidden staging folder"
            );
            kept.push(staging.to_owned());
        }
        kept
    }
}

/// One staged entry on its way back: where it goes, and whether that is a conflict name.
enum Job {
    Put {
        from: PathBuf,
        to: PathBuf,
        conflict: bool,
    },
    /// A staged folder whose entries were all put back before this runs.
    Remove(PathBuf),
}

/// A rollback's put-back: never replaces, never stops at the first failure (what fails stays
/// in the staging folder, and the rest still goes back).
struct PutBack<'h> {
    hook: &'h mut dyn FnMut(Step<'_>) -> io::Result<()>,
    budget: Budget,
    conflict_copies: Vec<PathBuf>,
}

/// How many more rollback steps may wait out a refusal ([`ROLLBACK_RETRIES`]).
struct Budget(u32);

impl Budget {
    /// [`retried`] while the budget lasts, then one try. A step still refused after every
    /// retry uses up one.
    fn retried(&mut self, mut operation: impl FnMut() -> io::Result<()>) -> io::Result<()> {
        if self.0 == 0 {
            return operation();
        }
        let result = retried(operation);
        if result.as_ref().is_err_and(is_transient) {
            self.0 -= 1;
        }
        result
    }
}

impl PutBack<'_> {
    /// Puts the tree at `staged` back at `original`, merging into a folder that is there.
    fn put(&mut self, staged: &Path, original: &Path) {
        let mut jobs = vec![Job::Put {
            from: staged.to_owned(),
            to: original.to_owned(),
            conflict: false,
        }];
        while let Some(job) = jobs.pop() {
            match job {
                Job::Remove(folder) => {
                    let hook = &mut *self.hook;
                    let removed = self.budget.retried(|| {
                        hook(Step::RemoveStaged(&folder))?;
                        fs::remove_dir(&folder)
                    });
                    failed(removed);
                }
                Job::Put { from, to, conflict } => {
                    self.put_one(&mut jobs, from, to, conflict);
                }
            }
        }
    }

    fn put_one(&mut self, jobs: &mut Vec<Job>, from: PathBuf, to: PathBuf, conflict: bool) {
        let Ok(meta) = fs::symlink_metadata(&from) else {
            return; // gone from the staging folder: nothing left to put back
        };
        let is_dir = meta.is_dir();
        let hook = &mut *self.hook;
        let mut once = || {
            hook(Step::PutBack {
                from: &from,
                to: &to,
            })?;
            rename_no_replace(&from, &to)
        };
        // A folder is tried once: when Windows holds it, its entries go back one by one.
        let put = if is_dir {
            once()
        } else {
            self.budget.retried(once)
        };
        let error = match put {
            Ok(()) => {
                if conflict {
                    self.conflict_copies.push(to);
                }
                return;
            }
            Err(error) => error,
        };
        let taken = error.kind() == io::ErrorKind::AlreadyExists;
        if !taken && !(is_dir && is_hold(&error)) {
            return failed(Err(error));
        }
        let there = fs::symlink_metadata(&to);
        if is_dir && there.as_ref().is_ok_and(fs::Metadata::is_dir) {
            return queue_into(jobs, from, to);
        }
        if there.is_ok() {
            // A file, a link or a folder took the name: keep both.
            match conflict_name(&to, is_dir) {
                Some(free) => jobs.push(Job::Put {
                    from,
                    to: free,
                    conflict: true,
                }),
                None => failed(Err(error)),
            }
            return;
        }
        let hook = &mut *self.hook;
        let made = self.budget.retried(|| {
            hook(Step::RemakeDir(&to))?;
            fs::create_dir(&to)
        });
        match made {
            Ok(()) => queue_into(jobs, from, to),
            // Taken since the look: put it back again, which decides once more.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                jobs.push(Job::Put { from, to, conflict })
            }
            Err(error) => failed(Err(error)),
        }
    }
}

/// Queues the entries of the staged folder `from` for the folder `to`, then its removal.
fn queue_into(jobs: &mut Vec<Job>, from: PathBuf, to: PathBuf) {
    match names(&from) {
        Ok(names) => {
            jobs.push(Job::Remove(from.clone()));
            jobs.extend(names.into_iter().map(|(name, _)| Job::Put {
                from: from.join(&name),
                to: to.join(&name),
                conflict: false,
            }));
        }
        Err(error) => failed(Err(error)),
    }
}

/// The first free `<name> (conflict copy)<ext>`, then `<name> (conflict copy 2)<ext>` ...,
/// beside `taken`. A folder's name keeps its dots.
fn conflict_name(taken: &Path, is_dir: bool) -> Option<PathBuf> {
    let file_name = taken.file_name()?.to_string_lossy().into_owned();
    let (name, ext) = match file_name.rfind('.') {
        Some(dot) if dot > 0 && !is_dir => file_name.split_at(dot),
        _ => (file_name.as_str(), ""),
    };
    (1..=CONFLICT_NAMES)
        .map(|n| match n {
            1 => format!("{name} (conflict copy){ext}"),
            n => format!("{name} (conflict copy {n}){ext}"),
        })
        .map(|candidate| taken.with_file_name(candidate))
        .find(|candidate| fs::symlink_metadata(candidate).is_err())
}

/// Logs a rollback step that failed; what it would have moved stays in the staging folder.
fn failed(result: io::Result<()>) {
    if let Err(error) = result {
        // The error kind only: the path is note-derived.
        tracing::error!(
            scope = SCOPE,
            kind = ?error.kind(),
            "a step of a failed folder move was not undone"
        );
    }
}
