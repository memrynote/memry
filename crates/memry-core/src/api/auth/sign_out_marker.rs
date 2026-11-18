//! "The user signed out", kept across a restart (#4767).
//!
//! A sign-out whose keychain refused a delete leaves the refresh token behind, and the next
//! launch's [`AuthSession::restore`](super::AuthSession::restore) would sign the user back in.
//! The file is written before the store is cleared, so a clear that fails or a crash halfway
//! through it leaves the file behind. It is removed once the clear succeeds (nothing is left to
//! restore) and when a device registers, which every sign-in reaches.
//!
//! The same file tells the next sign-in that the store may still hold the last account's
//! secrets, which it deletes first (#4766, [`AuthSession::forget_last_account`](super::AuthSession::forget_last_account)).
//!
//! Persisted format, read by every later build: a file at the path the shell passes. Only its
//! presence is read; its contents are ignored. A build that predates the marker ignores the file
//! and restores as before. No file (a fresh install, an install from before this build, an
//! Electron import) restores as before. A sign-in on a build that predates the marker never
//! removes the file, so the next launch on this build refuses that live session once.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) struct SignOutMarker {
    /// `None` keeps the marker in memory only, for tests and tools with no app directory.
    path: Option<PathBuf>,
    /// This process signed out; holds even when the file could not be written.
    latched: AtomicBool,
    /// This process's last sign-out could not clear the store.
    secrets_kept: AtomicBool,
    /// The last file operation that failed, until the shell takes it to log or report.
    fault: Mutex<Option<String>>,
}

impl SignOutMarker {
    pub(super) fn new(path: Option<String>) -> Self {
        Self {
            path: path.map(PathBuf::from),
            latched: AtomicBool::new(false),
            secrets_kept: AtomicBool::new(false),
            fault: Mutex::new(None),
        }
    }

    /// Set at sign-out. A failed write still latches this process, and it matters across a
    /// restart only when the clear that follows fails too; the caller then reports the entries
    /// that stayed and [`Self::take_fault`] names the write.
    pub(super) fn set(&self) {
        self.latched.store(true, Ordering::SeqCst);
        if let Some(path) = &self.path
            && let Err(error) = write(path)
        {
            self.record("could not be written", &error);
        }
    }

    /// The store was cleared: no secret is left for a restart to restore, so the file goes and
    /// this process stays latched.
    pub(super) fn store_cleared(&self) {
        self.secrets_kept.store(false, Ordering::SeqCst);
        self.remove_file();
    }

    /// The clear failed: the store may still hold the signed-out account's secrets.
    pub(super) fn store_kept(&self) {
        self.secrets_kept.store(true, Ordering::SeqCst);
    }

    /// A device registered: the sign-out is over.
    pub(super) fn clear(&self) {
        self.latched.store(false, Ordering::SeqCst);
        self.store_cleared();
    }

    /// A file that stays makes the next launch ask for a sign-in instead of restoring, the
    /// fail-closed side.
    fn remove_file(&self) {
        if let Some(path) = &self.path
            && let Err(error) = fs::remove_file(path)
            && error.kind() != io::ErrorKind::NotFound
        {
            self.record("could not be removed", &error);
        }
    }

    /// Set in this process or on disk. A path whose existence cannot be read counts as set.
    pub(super) fn is_set(&self) -> bool {
        self.latched.load(Ordering::SeqCst) || self.file_present()
    }

    /// A sign-out may have left secrets in the store: this process's clear failed, or a file
    /// says a sign-out's clear never finished.
    pub(super) fn secrets_may_remain(&self) -> bool {
        self.secrets_kept.load(Ordering::SeqCst) || self.file_present()
    }

    fn file_present(&self) -> bool {
        self.path
            .as_ref()
            .is_some_and(|path| match path.try_exists() {
                Ok(present) => present,
                Err(error) => {
                    self.record("could not be read", &error);
                    true
                }
            })
    }

    fn record(&self, what: &str, error: &io::Error) {
        *self.fault.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(format!("the sign-out marker {what}: {error}"));
    }

    /// The last failed file operation, once.
    pub(super) fn take_fault(&self) -> Option<String> {
        self.fault.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

fn write(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::File::create(path)?.sync_all()
}
