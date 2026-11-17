//! Moving a staged pair into `<vault>/.memry/core/`.
//!
//! Order: fsync both staged files, rename `index.db`, fsync `core/`, rename `data.db`, fsync
//! `core/`. Both renames stay inside `<vault>/.memry/`, so they are atomic. The `data.db` rename
//! is the commit point:
//! - a crash before it leaves no `core/data.db`, so the next run stages again and replaces the
//!   `core/index.db` it may have left;
//! - a crash after it reads as `AlreadyImported`, with `index.db` already complete.
//!
//! A `core/data.db` or sidecar that appeared after staging (the vault opened natively meanwhile)
//! is refused before anything under `core/` is removed or renamed, so the native pair is left
//! byte for byte. Both renames still refuse to replace a file ([`rename_no_replace`]), which
//! covers a native open that races the install itself.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use memry_core::storage::import::{DATA_FILE, INDEX_FILE};

use super::{ImportError, StagedVault, crash, remove_staging};
use crate::vault::fs_atomic::{rename_no_replace, sync_dir};

/// `-wal`, `-shm` and `-journal` beside `db`.
pub(super) fn sidecars(db: &Path) -> [PathBuf; 3] {
    ["-wal", "-shm", "-journal"].map(|suffix| {
        let mut name = OsString::from(db.as_os_str());
        name.push(suffix);
        PathBuf::from(name)
    })
}

/// [`ImportError::CoreFileExists`] when anything is at `path`, a dangling symlink included;
/// every error other than `NotFound` is passed on.
pub(super) fn refuse_if_present(path: &Path) -> Result<(), ImportError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(ImportError::CoreFileExists(path.to_owned())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ImportError::io(path, e)),
    }
}

fn remove_file(path: &Path) -> Result<(), ImportError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ImportError::io(path, e)),
    }
}

fn rename(from: &Path, to: &Path) -> Result<(), ImportError> {
    rename_no_replace(from, to).map_err(|e| match e.kind() {
        io::ErrorKind::AlreadyExists => ImportError::CoreFileExists(to.to_owned()),
        _ => ImportError::io(to, e),
    })
}

impl StagedVault {
    /// Installs the staged pair. On an error nothing is committed unless `core/data.db` is in
    /// place, and a rerun of [`super::stage_vault_import`] repeats the import or reports it done.
    pub fn install(self) -> Result<(), ImportError> {
        let paths = self.paths;
        let data = paths.core.join(DATA_FILE);
        refuse_if_present(&data)?;
        for path in sidecars(&data) {
            refuse_if_present(&path)?;
        }
        for name in [DATA_FILE, INDEX_FILE] {
            let path = paths.staging.join(name);
            // Opened for writing: Windows refuses `FlushFileBuffers` on a read-only handle.
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .and_then(|file| file.sync_all())
                .map_err(|e| ImportError::io(&path, e))?;
        }
        fs::create_dir_all(&paths.core).map_err(|e| ImportError::io(&paths.core, e))?;
        sync_dir(&paths.memry);
        crash::point("install:synced");

        // A `core/index.db` with no `core/data.db` is an earlier run's, cut off between the two
        // renames, or a rebuildable index; either way the staged one replaces it.
        let index = paths.core.join(INDEX_FILE);
        for path in sidecars(&index) {
            remove_file(&path)?;
        }
        remove_file(&index)?;
        rename(&paths.staging.join(INDEX_FILE), &index)?;
        sync_dir(&paths.core);
        crash::point("install:index-renamed");

        rename(&paths.staging.join(DATA_FILE), &data)?;
        sync_dir(&paths.core);
        crash::point("install:data-renamed");

        // Committed. A staging directory left here is removed by the next run.
        if let Err(error) = remove_staging(&paths) {
            tracing::warn!(%error, "could not remove the import staging directory");
        }
        Ok(())
    }

    /// Drops the staged pair; the Electron files and `core/` are untouched.
    pub fn discard(self) -> Result<(), ImportError> {
        remove_staging(&self.paths)
    }
}
