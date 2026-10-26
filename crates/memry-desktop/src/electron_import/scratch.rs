//! Scratch copies of LevelDB directories and the in-use probe.
//!
//! LevelDB writes on open (a new log, a manifest, compactions), so the profile's own stores are
//! never opened. A store is copied without its `LOCK` file into a temp dir and the copy is
//! opened. Copying a directory that a running Electron writes can tear, so callers run
//! [`ProfileLock::probe`] first.

use std::fs;
use std::path::{Path, PathBuf};

use rusty_leveldb::{DB, LdbIterator, Options};
use tempfile::TempDir;

use super::ImportError;
use super::profile::ElectronProfile;

const LOCK_FILE: &str = "LOCK";

/// One key and value.
pub type Entry = (Vec<u8>, Vec<u8>);

/// A LevelDB opened on a throw-away copy of `source`.
pub struct ScratchDb {
    _dir: TempDir,
    db: DB,
}

impl ScratchDb {
    /// Refuses a store a running Electron holds ([`ProfileLock::probe_dir`]) before copying.
    pub fn open(source: &Path) -> Result<Self, ImportError> {
        ProfileLock::probe_dir(source)?;
        let dir = tempfile::tempdir().map_err(|e| ImportError::io(source, e))?;
        copy_leveldb_dir(source, dir.path())?;
        let options = Options {
            create_if_missing: false,
            ..Options::default()
        };
        let db = DB::open(dir.path(), options).map_err(|e| ImportError::LevelDb(e.to_string()))?;
        Ok(Self { _dir: dir, db })
    }

    /// Every entry whose key starts with `prefix`, in key order.
    pub fn scan_prefix(&mut self, prefix: &[u8]) -> Result<Vec<Entry>, ImportError> {
        let mut iter = self
            .db
            .new_iter()
            .map_err(|e| ImportError::LevelDb(e.to_string()))?;
        iter.seek(prefix);
        let mut out = Vec::new();
        // `seek` leaves the iterator on the first entry at or after `prefix`.
        while let Some((key, value)) = iter.current() {
            if !key.starts_with(prefix) {
                break;
            }
            out.push((key.to_vec(), value.to_vec()));
            if !iter.advance() {
                break;
            }
        }
        Ok(out)
    }

    pub fn get(&mut self, key: &[u8]) -> Option<Vec<u8>> {
        self.db.get(key).map(|bytes| bytes.to_vec())
    }
}

/// Copies every regular file of `src` except `LOCK`. A LevelDB directory is flat; a
/// subdirectory is not part of the store and is skipped.
pub fn copy_leveldb_dir(src: &Path, dst: &Path) -> Result<(), ImportError> {
    let entries = fs::read_dir(src).map_err(|e| ImportError::io(src, e))?;
    for entry in entries {
        let entry = entry.map_err(|e| ImportError::io(src, e))?;
        let name = entry.file_name();
        if name == LOCK_FILE {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|e| ImportError::io(entry.path(), e))?;
        if !file_type.is_file() {
            continue;
        }
        fs::copy(entry.path(), dst.join(&name)).map_err(|e| ImportError::io(entry.path(), e))?;
    }
    Ok(())
}

/// The probe for a running Electron. Zero-sized: nothing is held after [`ProfileLock::probe`].
pub struct ProfileLock;

impl ProfileLock {
    /// Fails with [`ImportError::ProfileInUse`] when another process holds the LOCK file of the
    /// localStorage store or of any CRDT store. The file is opened read-only and released at once.
    pub fn probe(profile: &ElectronProfile) -> Result<(), ImportError> {
        profile
            .leveldb_dirs()
            .iter()
            .try_for_each(|dir| Self::probe_dir(dir))
    }

    pub fn probe_dir(dir: &Path) -> Result<(), ImportError> {
        let lock = dir.join(LOCK_FILE);
        if lock.is_file() && is_held(&lock)? {
            return Err(ImportError::ProfileInUse(dir.to_owned()));
        }
        Ok(())
    }
}

#[cfg(unix)]
fn is_held(lock: &Path) -> Result<bool, ImportError> {
    use std::os::fd::AsRawFd;

    let file = fs::File::open(lock).map_err(|e| ImportError::io(lock, e))?;
    // LevelDB takes a POSIX record lock (fcntl), which `flock` does not see. F_GETLK asks the
    // kernel who would block a write lock without taking one.
    // SAFETY: `flock` is plain data, zeroed is a valid value, and the fd is open for the call.
    let held = unsafe {
        let mut query: libc::flock = std::mem::zeroed();
        query.l_type = libc::F_WRLCK as _;
        query.l_whence = libc::SEEK_SET as _;
        if libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &mut query) != 0 {
            return Err(ImportError::io(lock, std::io::Error::last_os_error()));
        }
        i32::from(query.l_type) != i32::from(libc::F_UNLCK)
    };
    Ok(held)
}

#[cfg(windows)]
fn is_held(lock: &Path) -> Result<bool, ImportError> {
    // LevelDB opens its LOCK with share mode 0 on Windows, so any open fails while it is held
    // (ERROR_SHARING_VIOLATION, 32) and ERROR_LOCK_VIOLATION (33) covers a byte-range lock.
    match fs::File::open(lock) {
        Ok(_) => Ok(false),
        Err(e) if matches!(e.raw_os_error(), Some(32 | 33)) => Ok(true),
        Err(e) => Err(ImportError::io(lock, e)),
    }
}

impl ElectronProfile {
    /// Every LevelDB directory a reader may open, whether it exists or not.
    pub fn leveldb_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = vec![self.local_storage_dir()];
        dirs.extend(self.crdt_store_dirs.iter().cloned());
        dirs.push(self.legacy_crdt_store_dir());
        dirs
    }
}
