//! A failed move's way back: everything in its staging folder goes back to its path in the
//! source, never over anything there, and what cannot go back goes into a visible folder
//! (the module doc of [`super`]). The open's sweep of an interrupted move runs the same.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::{SCOPE, Step, is_hold, names, rename_no_replace, retried};
use crate::vault::fs_atomic::is_transient;

/// How many steps of a rollback may wait out a refusal before the rest get one try each, so
/// a tree whose every file is refused costs seconds, not one retry schedule per file.
const ROLLBACK_RETRIES: u32 = 4;

/// The most conflict names tried for one entry.
const CONFLICT_NAMES: u32 = 1000;

/// What a put-back left beside the source ([`super::IncompleteRollback`]).
pub(in crate::vault) struct Left {
    pub conflict_copies: Vec<PathBuf>,
    pub kept: Vec<PathBuf>,
}

/// Puts everything in `staging` back into `from`, and moves what does not go back into a
/// visible `<from name> (incomplete move)` beside `staging`. `before_show` learns that folder
/// before anything moves into it.
pub(in crate::vault) fn put_back_staged(
    from: &Path,
    staging: &Path,
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
    before_show: &mut dyn FnMut(&Path),
) -> Left {
    let mut back = PutBack::new(hook);
    back.put(staging, from);
    let name = from.file_name().unwrap_or_default().to_string_lossy();
    let kept = back.keep_in_sight(staging, &name, before_show);
    Left {
        conflict_copies: back.conflict_copies,
        kept,
    }
}

/// Renames a staging folder whose source is unknown into a visible `<name> (incomplete move)`
/// beside it, which `before_show` learns first. Returns the folders holding its files.
pub(in crate::vault) fn show_staged(
    staging: &Path,
    name: &str,
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
    before_show: &mut dyn FnMut(&Path),
) -> Vec<PathBuf> {
    PutBack::new(hook).keep_in_sight(staging, name, before_show)
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
    fn keep_in_sight(
        &mut self,
        staging: &Path,
        name: &str,
        before_show: &mut dyn FnMut(&Path),
    ) -> Vec<PathBuf> {
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
            before_show(&visible);
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
