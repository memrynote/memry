//! A digest of a vault's tree for verification check 7: the vault's files are byte equal
//! before the journal replay and after install, except the paths the import itself writes.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Read as _};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::electron_import::ImportError;
use crate::electron_import::journal_replay::is_memry_dir;

/// `vault-relative path -> entry` of everything in a vault but its top-level `.memry/`.
/// Only regular files are opened and hashed. Symlinks are recorded by their target and never
/// followed; other file types (FIFO, socket, device) and folders that cannot be listed are
/// opaque entries, never opened. The walk keeps its own stack, so a deep tree cannot recurse.
/// Keys use `/` on every OS; a name that is not UTF-8 reads lossily.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VaultTree(BTreeMap<String, Entry>);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Entry {
    Dir,
    /// A folder whose listing failed: its content is unknown, so it compares as itself.
    UnreadableDir,
    File {
        len: u64,
        sha256: [u8; 32],
    },
    Link(PathBuf),
    /// Neither file, folder nor link.
    Other,
}

/// The changes check 7 expects: any change at `files`, and at `folders` only a folder that
/// appeared or stayed a folder.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExpectedChanges {
    pub files: BTreeSet<String>,
    pub folders: BTreeSet<String>,
}

impl VaultTree {
    pub fn read(vault: &Path) -> Result<Self, ImportError> {
        let mut out = BTreeMap::new();
        let mut stack = vec![PathBuf::new()];
        while let Some(rel_dir) = stack.pop() {
            let dir = vault.join(&rel_dir);
            let listing = match fs::read_dir(&dir) {
                Ok(listing) => listing,
                Err(_) if !rel_dir.as_os_str().is_empty() => {
                    out.insert(key(&rel_dir), Entry::UnreadableDir);
                    continue;
                }
                Err(e) => return Err(ImportError::io(&dir, e)),
            };
            for entry in listing {
                let entry = entry.map_err(|e| ImportError::io(&dir, e))?;
                let name = entry.file_name();
                if rel_dir.as_os_str().is_empty() && is_memry_dir(&name) {
                    continue;
                }
                let rel = rel_dir.join(&name);
                let path = vault.join(&rel);
                let kind = entry.file_type().map_err(|e| ImportError::io(&path, e))?;
                let digest = if kind.is_symlink() {
                    Entry::Link(fs::read_link(&path).map_err(|e| ImportError::io(&path, e))?)
                } else if kind.is_dir() {
                    stack.push(rel.clone());
                    Entry::Dir
                } else if kind.is_file() {
                    file_entry(&path).map_err(|e| ImportError::io(&path, e))?
                } else {
                    Entry::Other
                };
                out.insert(key(&rel), digest);
            }
        }
        Ok(Self(out))
    }

    /// Paths added, removed or changed since `before` that `expected` does not cover, sorted.
    pub fn changed_since(&self, before: &Self, expected: &ExpectedChanges) -> Vec<String> {
        let paths: BTreeSet<&String> = before.0.keys().chain(self.0.keys()).collect();
        paths
            .into_iter()
            .filter(|path| {
                let (was, is) = (before.0.get(*path), self.0.get(*path));
                let folder = matches!(was, None | Some(Entry::Dir))
                    && is == Some(&Entry::Dir)
                    && expected.folders.contains(*path);
                was != is && !folder && !expected.files.contains(*path)
            })
            .cloned()
            .collect()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Hashes a regular file. Opened non-blocking on Unix and checked again once open, so a file
/// swapped for a FIFO after the listing cannot block the read.
fn file_entry(path: &Path) -> io::Result<Entry> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NONBLOCK);
    let mut file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Ok(Entry::Other);
    }
    let mut hasher = Sha256::new();
    let mut buf = vec![0; 64 * 1024];
    let mut len = 0;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        len += n as u64;
    }
    Ok(Entry::File {
        len,
        sha256: hasher.finalize().into(),
    })
}

/// A vault-relative path as a tree key: its components joined by `/`.
pub(super) fn key(rel: &Path) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}
