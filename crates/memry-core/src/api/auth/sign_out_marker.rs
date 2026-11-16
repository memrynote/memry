//! "The user signed out", kept across a restart (#4767).
//!
//! A sign-out whose keychain refused a delete leaves the refresh token behind, and the next
//! launch's [`AuthSession::restore`](super::AuthSession::restore) would sign the user back in.
//! The file is written before the store is cleared, so a clear that fails or a crash halfway
//! through it leaves the file behind. It is removed once the clear succeeds (nothing is left to
//! restore) and when a device registers, which every sign-in reaches.
//!
//! Persisted format, read by every later build: a file at the path the shell passes. Only its
//! presence is read; its contents are ignored. A build that predates the marker ignores the file
//! and restores as before. No file (a fresh install, an install from before this build, an
//! Electron import) restores as before.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) struct SignOutMarker {
    /// `None` keeps the marker in memory only, for tests and tools with no app directory.
    path: Option<PathBuf>,
    /// This process signed out; holds even when the file could not be written.
    latched: AtomicBool,
}

impl SignOutMarker {
    pub(super) fn new(path: Option<String>) -> Self {
        Self {
            path: path.map(PathBuf::from),
            latched: AtomicBool::new(false),
        }
    }

    /// Set at sign-out. A failed write still latches this process, and it matters across a
    /// restart only when the clear that follows fails too; the caller then reports the entries
    /// that stayed.
    pub(super) fn set(&self) {
        self.latched.store(true, Ordering::SeqCst);
        if let Some(path) = &self.path {
            let _ = write(path);
        }
    }

    /// The store was cleared: no secret is left for a restart to restore, so the file goes and
    /// this process stays latched.
    pub(super) fn store_cleared(&self) {
        self.remove_file();
    }

    /// A device registered: the sign-out is over.
    pub(super) fn clear(&self) {
        self.latched.store(false, Ordering::SeqCst);
        self.remove_file();
    }

    /// A file that stays makes the next launch ask for a sign-in instead of restoring, the
    /// fail-closed side.
    fn remove_file(&self) {
        if let Some(path) = &self.path {
            let _ = fs::remove_file(path);
        }
    }

    /// Set in this process or on disk. A path whose existence cannot be read counts as set.
    pub(super) fn is_set(&self) -> bool {
        self.latched.load(Ordering::SeqCst)
            || self
                .path
                .as_ref()
                .is_some_and(|path| path.try_exists().unwrap_or(true))
    }
}

fn write(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::File::create(path)?.sync_all()
}
