//! `removeFolderIfEmpty` (`apps/desktop/src/main/vault/folders.ts`): a folder another device
//! deleted leaves this disk only when nothing in it is worth keeping, which is subfolders,
//! `.folder.md` and the OS view caches. A note still there (edited here after the other device
//! deleted the folder, or one whose own delete has not been pulled yet) keeps the folder.
//!
//! Nothing goes when the scan finds a kept entry, and folders go with `rmdir`, which refuses a
//! folder that is not empty, so a file written between the scan and the removal stays with its
//! folder. A file or folder already gone (another prune, the watcher, a file manager) counts as
//! removed. A link, which the scan does not follow, is kept.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::app_move::on_disk;
use super::folder_file::FOLDER_FILE;

/// What may go with a folder: the folder's own settings and what the OS writes into a folder
/// it showed.
const DISPOSABLE: [&str; 4] = [FOLDER_FILE, ".DS_Store", "Thumbs.db", "desktop.ini"];

/// What [`remove_if_empty`] did with the folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Removal {
    Removed,
    /// The folder is not there (or is not a folder).
    Missing,
    /// The first entry that keeps it, vault-relative.
    HoldsFiles(String),
    /// Something in it changed within the quiet window until the wait ran out.
    Busy,
}

/// How long the folder must have been left alone before it goes, and how long to wait for
/// that (the pull page that deletes its notes lands its files in a burst).
#[derive(Debug, Clone, Copy)]
pub struct Quiet {
    pub window: Duration,
    pub timeout: Duration,
}

impl Default for Quiet {
    fn default() -> Self {
        Self {
            window: Duration::from_secs(2),
            timeout: Duration::from_secs(60),
        }
    }
}

struct Scan {
    /// Folders, deepest first, so they go in order.
    dirs: Vec<PathBuf>,
    disposable: Vec<PathBuf>,
    kept: Option<PathBuf>,
    /// The latest change seen on any entry.
    newest: Option<SystemTime>,
}

/// Removes the folder at `rel` when it holds only subfolders and disposable files, once nothing
/// in it changed for `quiet.window`. Blocks: call it on a blocking thread.
pub fn remove_if_empty(root: &Path, rel: &str, quiet: Quiet) -> io::Result<Removal> {
    let dir = on_disk(root, rel);
    let started = std::time::Instant::now();
    let scan = loop {
        let scan = match scan(&dir) {
            Ok(scan) => scan,
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) =>
            {
                return Ok(Removal::Missing);
            }
            Err(error) => return Err(error),
        };
        if let Some(kept) = &scan.kept {
            let at = kept.strip_prefix(root).unwrap_or(kept);
            let rel = at
                .components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            return Ok(Removal::HoldsFiles(rel));
        }
        let settled = scan
            .newest
            .is_none_or(|newest| newest.elapsed().unwrap_or_default() >= quiet.window);
        if settled {
            break scan;
        }
        if started.elapsed() >= quiet.timeout {
            return Ok(Removal::Busy);
        }
        std::thread::sleep(Duration::from_millis(100).min(quiet.window));
    };
    for file in &scan.disposable {
        gone_is_fine(fs::remove_file(file))?;
    }
    for dir in &scan.dirs {
        gone_is_fine(fs::remove_dir(dir))?;
    }
    Ok(Removal::Removed)
}

fn gone_is_fine(result: io::Result<()>) -> io::Result<()> {
    match result {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn scan(root: &Path) -> io::Result<Scan> {
    if !fs::symlink_metadata(root)?.is_dir() {
        return Err(ErrorKind::NotADirectory.into());
    }
    let mut scan = Scan {
        dirs: Vec::new(),
        disposable: Vec::new(),
        kept: None,
        newest: None,
    };
    visit(root, root, &mut scan)?;
    Ok(scan)
}

fn visit(root: &Path, dir: &Path, scan: &mut Scan) -> io::Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // A subfolder removed since its parent was read is already gone.
        Err(error) if dir != root && error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    note_change(scan, fs::symlink_metadata(dir).ok());
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        note_change(scan, Some(meta.clone()));
        if meta.is_dir() {
            visit(root, &path, scan)?;
        } else if meta.is_file() && DISPOSABLE.iter().any(|name| entry.file_name() == *name) {
            scan.disposable.push(path);
        } else {
            scan.kept = Some(path);
        }
        if scan.kept.is_some() {
            return Ok(());
        }
    }
    scan.dirs.push(dir.to_path_buf());
    Ok(())
}

fn note_change(scan: &mut Scan, meta: Option<fs::Metadata>) {
    if let Some(at) = meta.and_then(|meta| meta.modified().ok()) {
        scan.newest = Some(scan.newest.map_or(at, |newest| newest.max(at)));
    }
}
