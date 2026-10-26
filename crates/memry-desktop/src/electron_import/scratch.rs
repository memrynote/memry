//! Scratch copies of LevelDB directories and the in-use probe.
//!
//! LevelDB writes on open (a new log, a manifest, compactions), so the profile's own stores are
//! never opened. A store is copied without its `LOCK` file into a temp dir and the copy is
//! opened. Copying a directory that a running Electron writes can tear, so callers run
//! [`ProfileLock::probe`] first.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusty_leveldb::{DB, LdbIterator, Options};
use tempfile::TempDir;

use super::leveldb_log::{TornTail, read_records};
use super::profile::ElectronProfile;
use super::{ImportError, leveldb_manifest, leveldb_table};

const LOCK_FILE: &str = "LOCK";

/// One key and value.
pub type Entry = (Vec<u8>, Vec<u8>);

/// Where scratch copies live: a directory under the app's own data dir, never the system temp
/// dir, because a copy of a CRDT store holds decrypted note history. Stale copies a crashed run
/// left behind are removed when the directory is opened.
#[derive(Debug, Clone)]
pub struct Scratch {
    root: PathBuf,
    max_bytes: u64,
}

/// A copy bigger than this is refused: a store this large is not an Electron profile's.
pub const DEFAULT_MAX_COPY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const STALE_AFTER: Duration = Duration::from_secs(60 * 60);
const SCRATCH_PREFIX: &str = "electron-import-";

impl Scratch {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, ImportError> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|e| ImportError::io(&root, e))?;
        let scratch = Self {
            root,
            max_bytes: DEFAULT_MAX_COPY_BYTES,
        };
        scratch.sweep_stale();
        Ok(scratch)
    }

    pub fn with_max_bytes(mut self, max_bytes: u64) -> Self {
        self.max_bytes = max_bytes;
        self
    }

    /// Removes this module's own directories older than an hour. A failure is logged and
    /// skipped: a leftover copy is a disk-space cost, never a reason to stop the import.
    fn sweep_stale(&self) {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let is_ours = entry
                .file_name()
                .to_string_lossy()
                .starts_with(SCRATCH_PREFIX);
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > STALE_AFTER);
            if is_ours
                && stale
                && let Err(error) = fs::remove_dir_all(entry.path())
            {
                tracing::warn!(%error, "could not remove a stale import scratch directory");
            }
        }
    }

    fn new_dir(&self) -> Result<TempDir, ImportError> {
        tempfile::Builder::new()
            .prefix(SCRATCH_PREFIX)
            .tempdir_in(&self.root)
            .map_err(|e| ImportError::io(&self.root, e))
    }
}

/// A LevelDB opened on a throw-away copy of `source`. The database closes before the copy is
/// deleted (field order matters on Windows, which cannot delete open files).
pub struct ScratchDb {
    db: DB,
    torn_tails: Vec<TornFile>,
    _dir: TempDir,
}

/// A log or manifest that ends in a record cut short. LevelDB drops that record and, for a
/// corrupt length field, every record after it, so the reader reports it instead of hiding it.
/// A crash leaves the same shape, which is why it is not an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TornFile {
    pub file: String,
    pub offset: usize,
    pub dropped_bytes: usize,
}

impl ScratchDb {
    /// Refuses a store a running Electron holds ([`ProfileLock::probe_dir`]) before copying, and
    /// a store whose live log, manifest or table blocks fail their checksums after.
    pub fn open(scratch: &Scratch, source: &Path) -> Result<Self, ImportError> {
        ProfileLock::probe_dir(source)?;
        let dir = scratch.new_dir()?;
        copy_leveldb_dir(source, dir.path(), scratch.max_bytes)?;
        let torn_tails = verify_store(dir.path())?;
        let options = Options {
            create_if_missing: false,
            ..Options::default()
        };
        let db = DB::open(dir.path(), options).map_err(|e| ImportError::LevelDb(e.to_string()))?;
        Ok(Self {
            db,
            torn_tails,
            _dir: dir,
        })
    }

    /// Files that end in a cut-short record; empty for a store that was closed cleanly.
    pub fn torn_tails(&self) -> &[TornFile] {
        &self.torn_tails
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

/// Copies every regular file of `src` except `LOCK`, refusing more than `max_bytes` in total. A
/// LevelDB directory is flat; a subdirectory is not part of the store and is skipped.
pub fn copy_leveldb_dir(src: &Path, dst: &Path, max_bytes: u64) -> Result<(), ImportError> {
    let entries = fs::read_dir(src).map_err(|e| ImportError::io(src, e))?;
    let mut total = 0_u64;
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
        total += entry
            .metadata()
            .map_err(|e| ImportError::io(entry.path(), e))?
            .len();
        if total > max_bytes {
            return Err(ImportError::LevelDb(format!(
                "store is larger than the {max_bytes} byte copy limit"
            )));
        }
        fs::copy(entry.path(), dst.join(&name)).map_err(|e| ImportError::io(entry.path(), e))?;
    }
    Ok(())
}

/// The number in `000123.log`, `000123.ldb` or `MANIFEST-000123`.
fn file_number(name: &str) -> Option<u64> {
    let digits = name
        .strip_prefix("MANIFEST-")
        .or_else(|| name.split('.').next())?;
    digits.parse().ok()
}

/// Verifies what LevelDB will read: the manifest `CURRENT` names, every live table block, and the
/// logs the manifest has not retired. rusty-leveldb skips a corrupt table block and drops a log
/// record with a bad checksum without an error, so a flipped byte would otherwise open as a store
/// with rows missing. Files the manifest does not name are leftovers LevelDB ignores too.
fn verify_store(dir: &Path) -> Result<Vec<TornFile>, ImportError> {
    let corrupt = |name: &str, why: String| ImportError::LevelDb(format!("{name}: {why}"));
    let read =
        |name: &str| fs::read(dir.join(name)).map_err(|e| ImportError::io(dir.join(name), e));
    let mut torn = Vec::new();
    let mut note = |file: &str, tail: Option<TornTail>| {
        if let Some(tail) = tail {
            torn.push(TornFile {
                file: file.to_owned(),
                offset: tail.offset,
                dropped_bytes: tail.dropped_bytes,
            });
        }
    };

    let current = read("CURRENT")?;
    let manifest_name = String::from_utf8_lossy(&current).trim().to_owned();
    if file_number(&manifest_name).is_none() || !manifest_name.starts_with("MANIFEST-") {
        return Err(corrupt("CURRENT", "does not name a manifest".into()));
    }
    let live = leveldb_manifest::live_files(&read(&manifest_name)?)
        .map_err(|why| corrupt(&manifest_name, why))?;
    note(&manifest_name, live.torn_tail);

    for number in &live.tables {
        let found = [format!("{number:06}.ldb"), format!("{number:06}.sst")]
            .into_iter()
            .find(|name| dir.join(name).is_file());
        let Some(name) = found else {
            return Err(corrupt(
                &manifest_name,
                format!("names table {number:06} but the file is missing"),
            ));
        };
        leveldb_table::verify(&read(&name)?).map_err(|why| corrupt(&name, why))?;
    }

    let mut logs: Vec<String> = fs::read_dir(dir)
        .map_err(|e| ImportError::io(dir, e))?
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".log"))
        .collect();
    logs.sort();
    for name in logs {
        let live_log =
            file_number(&name).is_some_and(|n| n >= live.log_number || n == live.prev_log_number);
        if !live_log {
            continue;
        }
        let records = read_records(&read(&name)?)
            .map_err(|offset| corrupt(&name, format!("fails its checksum at byte {offset}")))?;
        note(&name, records.torn_tail);
    }
    Ok(torn)
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

// `flock.l_type` and `F_UNLCK` are `i16` on Linux and differ in width on other Unixes, so the
// widening is needed on some targets and a no-op on others.
#[cfg(unix)]
#[allow(clippy::useless_conversion)]
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
