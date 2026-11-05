//! `removeFolderIfEmpty` (`apps/desktop/src/main/vault/folders.ts`): a folder another device
//! deleted leaves this disk only when nothing in it is worth keeping, which is subfolders, the
//! OS view caches and a `.folder.md` holding only the settings a build writes. A note still there
//! (edited here after the other device deleted the folder, or one whose own delete has not been
//! pulled yet) keeps the folder, and so does a `.folder.md` with text or keys no build models,
//! which Electron removed.
//!
//! Nothing goes when the scan finds a kept entry or the caller no longer wants the folder gone
//! once the wait is over, and folders go with `rmdir`, which refuses a folder that is not empty:
//! a file written after the scan stays with its folder, and the folders already removed below it
//! are reported. A file or folder already gone (another prune, the watcher, a file manager)
//! counts as removed. A link, which the scan does not follow, is kept.

use std::fs;
use std::io::{self, ErrorKind, Read as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use super::app_move::on_disk;
use super::folder_file::{self, FOLDER_FILE, MAX_FOLDER_FILE_BYTES};

/// What the OS writes into a folder it showed.
const OS_CACHES: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];

/// What [`remove_if_empty`] did with the folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Removal {
    Removed,
    /// The folder is not there (or is not a folder).
    Missing,
    /// The first entry that keeps it, vault-relative, and the folders below it that went
    /// before a file written meanwhile kept the rest, deepest first.
    HoldsFiles {
        file: String,
        removed: Vec<String>,
    },
    /// Something in it changed within the quiet window until the wait ran out.
    Busy,
    /// The caller no longer wanted it gone once the wait was over.
    Declined,
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
/// in it changed for `quiet.window` and `confirm` still says it may go. `after_wait` runs once
/// the wait is over, before `confirm`, where a test acts as another writer would. Blocks: call
/// it on a blocking thread.
pub fn remove_if_empty<E: From<io::Error>>(
    root: &Path,
    rel: &str,
    quiet: Quiet,
    confirm: &mut dyn FnMut() -> Result<bool, E>,
    after_wait: &mut dyn FnMut(),
) -> Result<Removal, E> {
    let dir = on_disk(root, rel);
    let started = Instant::now();
    let scan = loop {
        let scan = match scan(&dir) {
            Ok(scan) => scan,
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) =>
            {
                return Ok(Removal::Missing);
            }
            Err(error) => return Err(error.into()),
        };
        if let Some(kept) = &scan.kept {
            return Ok(Removal::HoldsFiles {
                file: relative(root, kept),
                removed: Vec::new(),
            });
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
    after_wait();
    if !confirm()? {
        return Ok(Removal::Declined);
    }
    for file in &scan.disposable {
        gone_is_fine(fs::remove_file(file)).map_err(E::from)?;
    }
    let mut removed = Vec::new();
    for dir in &scan.dirs {
        match fs::remove_dir(dir) {
            Err(error) if error.kind() == ErrorKind::DirectoryNotEmpty => {
                return Ok(Removal::HoldsFiles {
                    file: relative(root, dir),
                    removed,
                });
            }
            other => gone_is_fine(other).map_err(E::from)?,
        }
        removed.push(relative(root, dir));
    }
    Ok(Removal::Removed)
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
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
        let name = entry.file_name();
        if meta.is_dir() {
            visit(root, &path, scan)?;
        } else if meta.is_file()
            && (OS_CACHES.iter().any(|cache| name == *cache)
                || (name == FOLDER_FILE && only_settings(&path)))
        {
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

/// Whether the `.folder.md` at `path` holds only settings; one that cannot be read is kept.
fn only_settings(path: &Path) -> bool {
    let mut raw = String::new();
    let read = fs::File::open(path).and_then(|file| {
        file.take(MAX_FOLDER_FILE_BYTES + 1)
            .read_to_string(&mut raw)
    });
    matches!(read, Ok(len) if (len as u64) <= MAX_FOLDER_FILE_BYTES)
        && folder_file::parse(&raw).is_ok_and(|file| file.holds_only_settings())
}

fn note_change(scan: &mut Scan, meta: Option<fs::Metadata>) {
    if let Some(at) = meta.and_then(|meta| meta.modified().ok()) {
        scan.newest = Some(scan.newest.map_or(at, |newest| newest.max(at)));
    }
}
