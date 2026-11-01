//! One move of a vault file that the app makes (the journal renames of a date format change,
//! Step 12g, and a note's rename or move, Step 13g): never over another file, respelling a name
//! in place only when the new name is that very file, and told to the own-write record so the
//! watcher never takes the old name's going for a delete.

use std::fs;
use std::io;
use std::path::Path;
use std::time::Duration;

use super::fs_atomic::{RETRY_DELAYS_MS, rename_no_replace, sync_dir, with_transient_retry};
use super::watch::EchoGuard;
use crate::shell::file_open::file_identity;

/// One file move, without replacing anything.
pub(crate) struct FileMove<'a> {
    pub source: &'a Path,
    pub target: &'a Path,
    /// The source, relative to the vault: the name the watcher is told goes.
    pub source_rel: &'a str,
    /// The new name differs from the old only in case. On a volume that folds case it names
    /// the source itself, and that respelling is a plain rename.
    pub case_only: bool,
}

impl FileMove<'_> {
    /// Creates the target's folders and moves the file, retrying a transient error
    /// ([`RETRY_DELAYS_MS`], under a second). The record that the source's name goes is made
    /// with each try and stays only after the one that moved the file
    /// ([`EchoGuard::removing`]): between tries a delete or move by another program is that
    /// program's, and the watcher reports it.
    ///
    /// On disk before it returns, so a record written after it never names a move a power cut
    /// undoes: each folder it creates is synced into its parent before the move, and the
    /// target's and the source's folders after it (Unix; Windows moves with
    /// `MOVEFILE_WRITE_THROUGH`, but for a case-only respelling and a volume without an
    /// exclusive rename, which take a plain rename). A folder that cannot be synced is logged
    /// ([`sync_dir`]).
    pub(crate) fn run(&self, echo: &EchoGuard) -> io::Result<()> {
        if let Some(parent) = self.target.parent() {
            create_folders(parent)?;
        }
        let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
        let attempt = |rename: fn(&Path, &Path) -> io::Result<()>| {
            with_transient_retry(&delays, || {
                echo.removing(self.source_rel, || rename(self.source, self.target))
            })
        };
        let moved = match attempt(rename_no_replace) {
            Err(error)
                if error.kind() == io::ErrorKind::AlreadyExists
                    && self.case_only
                    && is_respelling(self.source, self.target) =>
            {
                attempt(|source, target| fs::rename(source, target))
            }
            other => other,
        };
        if moved.is_ok() {
            let (to, from) = (self.target.parent(), self.source.parent());
            to.into_iter().for_each(sync_dir);
            from.filter(|from| Some(*from) != to)
                .into_iter()
                .for_each(sync_dir);
        }
        moved
    }
}

/// Creates `folder` and the folders above it that are missing, each synced into its parent.
fn create_folders(folder: &Path) -> io::Result<()> {
    let missing: Vec<&Path> = folder
        .ancestors()
        .take_while(|at| fs::symlink_metadata(at).is_err())
        .collect();
    fs::create_dir_all(folder)?;
    for created in missing.iter().rev() {
        created.parent().into_iter().for_each(sync_dir);
    }
    Ok(())
}

/// Whether `target` is `source` itself under another spelling: one regular file with a single
/// link. A symbolic link there would be replaced, and a rename between two hard links of one
/// file does nothing and leaves both.
pub(crate) fn is_respelling(source: &Path, target: &Path) -> bool {
    let id = |path: &Path| {
        if !fs::symlink_metadata(path)?.is_file() {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        fs::File::open(path).and_then(|file| file_identity(&file))
    };
    matches!((id(source), id(target)), (Ok((a, 1)), Ok((b, 1))) if a == b)
}
