//! Staging of files dropped from the OS. The webview's own drag-and-drop handler is disabled
//! (HTML5 drops work in the page on every OS), so a drop arrives as DOM `File` objects with no
//! path. The renderer streams each file here in chunks; the finished copy has an absolute path
//! the import commands take, and the renderer releases it once the import settles.
//!
//! Layout: `<root>/<id>/<sanitized name>`, where `id` is 32 lowercase hex characters. Only ids
//! this service issued name a directory (a caller cannot reach outside `root` through `release`),
//! and files are written strictly in order, so a chunk can neither overwrite nor skip bytes.
//! On WebKitGTK the page gets no file; the shell stages the files of the OS drag it recorded
//! (`os_drag.rs`). Staged copies held at once are capped in count and bytes, and on Unix the
//! staging directories are private to the user (0700, files 0600).

mod name;
mod os_drag;

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use uuid::Uuid;

pub use name::sanitize_file_name;
pub use os_drag::{OS_DROP_TTL, file_uri_path};

/// A staged file larger than this is refused at `begin`.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Files being written at once. Sequential drops hold one; the cap bounds a runaway caller.
pub const MAX_OPEN: usize = 16;
/// A transfer that has not moved for this long was abandoned (the page reloaded mid-drop), and
/// its slot and directory are reclaimed by the next `begin`.
pub const IDLE_LIMIT: Duration = Duration::from_secs(10 * 60);
/// Staged copies (open or finished, not yet released) held at once, and their declared bytes.
/// A drop is released as soon as its import settles, so only a runaway caller reaches these.
pub const MAX_HELD_FILES: usize = 4096;
pub const MAX_HELD_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// A staging directory this old is a leftover of an earlier run.
pub const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, thiserror::Error)]
pub enum StageError {
    #[error("the file is larger than {MAX_FILE_BYTES} bytes")]
    TooLarge,
    #[error("too many files are being staged")]
    TooManyOpen,
    #[error("too many dropped files are waiting for their import")]
    TooMuchHeld,
    #[error("no such staged file")]
    UnknownId,
    #[error("the chunk does not continue the file")]
    OutOfOrder,
    #[error("the chunk runs past the declared size")]
    Overrun,
    #[error("the file is not complete")]
    Incomplete,
    #[error("the file was not dropped on the window")]
    NotDropped,
    #[error("the dropped item is not a file")]
    NotAFile,
    #[error("{0}")]
    Io(#[from] io::Error),
}

struct Transfer {
    file: File,
    path: PathBuf,
    size: u64,
    written: u64,
    touched: Instant,
}

/// The staging area under one root directory.
pub struct DropStaging {
    root: PathBuf,
    open: Mutex<HashMap<String, Arc<Mutex<Transfer>>>>,
    /// Declared size of every copy not yet released, by id. Locked after `open` when both are.
    held: Mutex<HashMap<String, u64>>,
    /// The OS drag over the window (`os_drag.rs`).
    os_drag: Mutex<Option<os_drag::OsDrag>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Whether `id` has the shape of one this service issues.
fn is_stage_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl DropStaging {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            open: Mutex::new(HashMap::new()),
            held: Mutex::new(HashMap::new()),
            os_drag: Mutex::new(None),
        }
    }

    /// Starts a staged copy of a file called `name` that will be `size` bytes. Returns its id.
    pub fn begin(&self, name: &str, size: u64) -> Result<String, StageError> {
        if size > MAX_FILE_BYTES {
            return Err(StageError::TooLarge);
        }
        let mut open = lock(&self.open);
        let abandoned: Vec<String> = open
            .iter()
            .filter(|(_, transfer)| lock(transfer).touched.elapsed() >= IDLE_LIMIT)
            .map(|(id, _)| id.clone())
            .collect();
        let mut held = lock(&self.held);
        for id in abandoned {
            open.remove(&id);
            held.remove(&id);
            self.remove_dir(&id)?;
        }
        if open.len() >= MAX_OPEN {
            return Err(StageError::TooManyOpen);
        }
        if held.len() >= MAX_HELD_FILES || held.values().sum::<u64>() + size > MAX_HELD_BYTES {
            return Err(StageError::TooMuchHeld);
        }
        let id = Uuid::new_v4().simple().to_string();
        let dir = self.root.join(&id);
        create_private_dir(&dir)?;
        let path = dir.join(sanitize_file_name(name));
        let file = match private_file_options().open(&path) {
            Ok(file) => file,
            Err(error) => {
                // The directory is this call's own, so nothing else is lost with it.
                let _ = fs::remove_dir(&dir);
                return Err(error.into());
            }
        };
        open.insert(
            id.clone(),
            Arc::new(Mutex::new(Transfer {
                file,
                path,
                size,
                written: 0,
                touched: Instant::now(),
            })),
        );
        held.insert(id.clone(), size);
        Ok(id)
    }

    /// Appends `bytes` at `offset`, which must be the number of bytes written so far.
    pub fn write_chunk(&self, id: &str, offset: u64, bytes: &[u8]) -> Result<(), StageError> {
        let transfer = lock(&self.open)
            .get(id)
            .cloned()
            .ok_or(StageError::UnknownId)?;
        let mut transfer = lock(&transfer);
        if offset != transfer.written {
            return Err(StageError::OutOfOrder);
        }
        let end = offset
            .checked_add(bytes.len() as u64)
            .filter(|end| *end <= transfer.size)
            .ok_or(StageError::Overrun)?;
        transfer.file.write_all(bytes)?;
        transfer.written = end;
        transfer.touched = Instant::now();
        Ok(())
    }

    /// Closes the file once every declared byte arrived, and returns its absolute path.
    pub fn finish(&self, id: &str) -> Result<PathBuf, StageError> {
        let transfer = lock(&self.open)
            .get(id)
            .cloned()
            .ok_or(StageError::UnknownId)?;
        let path = {
            let transfer = lock(&transfer);
            if transfer.written != transfer.size {
                return Err(StageError::Incomplete);
            }
            transfer.file.sync_all()?;
            transfer.path.clone()
        };
        lock(&self.open).remove(id);
        Ok(path)
    }

    /// Deletes the staged copies named by `ids`, finished or not. A name this service did not
    /// issue is skipped. Every id is tried; the first failure is returned.
    pub fn release(&self, ids: &[String]) -> io::Result<()> {
        let mut first_error = None;
        for id in ids.iter().filter(|id| is_stage_id(id)) {
            lock(&self.open).remove(id.as_str());
            lock(&self.held).remove(id.as_str());
            if let Err(error) = self.remove_dir(id) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    /// Deletes staging directories last touched `stale_after` before `now`: copies a closed
    /// window or a crash never released. An entry that cannot be read or removed is logged and
    /// skipped. Returns how many it removed.
    pub fn sweep(&self, now: SystemTime, stale_after: Duration) -> io::Result<usize> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error),
        };
        let mut removed = 0;
        for entry in entries {
            let outcome = entry.and_then(|entry| {
                let old = entry
                    .metadata()?
                    .modified()
                    .ok()
                    .and_then(|modified| now.duration_since(modified).ok())
                    .is_some_and(|age| age >= stale_after);
                if old && entry.file_type()?.is_dir() {
                    fs::remove_dir_all(entry.path())?;
                    return Ok(true);
                }
                Ok(false)
            });
            match outcome {
                Ok(true) => removed += 1,
                Ok(false) => {}
                Err(error) => {
                    tracing::warn!(scope = "DropStage", %error, "skipped a staging entry in the sweep");
                }
            }
        }
        Ok(removed)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn remove_dir(&self, id: &str) -> io::Result<()> {
        match fs::remove_dir_all(self.root.join(id)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }
}

/// Creates `dir` and any missing parent; on Unix only the user can list or enter them.
fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// A new file that must not exist yet; on Unix only the user can read it.
fn private_file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

#[cfg(test)]
mod tests;
