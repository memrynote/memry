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
/// Symlinks are recorded by their target and never followed, and the walk keeps its own
/// stack, so a link loop or a deep tree cannot recurse. Keys use `/` on every OS; a name that
/// is not UTF-8 reads lossily.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VaultTree(BTreeMap<String, Entry>);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Entry {
    Dir,
    File { len: u64, sha256: [u8; 32] },
    Link(PathBuf),
}

impl VaultTree {
    pub fn read(vault: &Path) -> Result<Self, ImportError> {
        let mut out = BTreeMap::new();
        let mut stack = vec![PathBuf::new()];
        while let Some(rel_dir) = stack.pop() {
            let dir = vault.join(&rel_dir);
            for entry in fs::read_dir(&dir).map_err(|e| ImportError::io(&dir, e))? {
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
                } else {
                    file_entry(&path).map_err(|e| ImportError::io(&path, e))?
                };
                out.insert(key(&rel), digest);
            }
        }
        Ok(Self(out))
    }

    /// Paths added, removed or changed since `before`, minus those in `expected`, sorted.
    pub fn changed_since(&self, before: &Self, expected: &BTreeSet<String>) -> Vec<String> {
        let paths: BTreeSet<&String> = before.0.keys().chain(self.0.keys()).collect();
        paths
            .into_iter()
            .filter(|path| before.0.get(*path) != self.0.get(*path) && !expected.contains(*path))
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

fn file_entry(path: &Path) -> io::Result<Entry> {
    let mut file = fs::File::open(path)?;
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
