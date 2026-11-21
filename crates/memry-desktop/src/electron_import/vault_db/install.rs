//! Moving a staged pair into `<vault>/.memry/core/`.
//!
//! Order: fsync both staged files, refuse a native core, move a `core/index.db` into staging,
//! rename `index.db`, fsync `core/`, rename `data.db`, fsync `core/`. Every rename stays inside
//! `<vault>/.memry/`, so each is atomic. The `data.db` rename is the commit point:
//! - a crash before it leaves no `core/data.db`, so the next run stages again and replaces the
//!   `core/index.db` it may have left;
//! - a crash after it reads as `AlreadyImported`, with `index.db` already complete.
//!
//! A `core/data.db`, its sidecars or a recovery marker that appeared after staging (the vault
//! opened natively meanwhile) is refused after the fsyncs and before anything under `core/`
//! moves, so the native pair is left byte for byte. A native open that races the renames
//! themselves makes the `data.db` rename fail ([`rename_no_replace`]); the install then takes
//! its `index.db` out of `core/` and puts back the one it moved aside.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use memry_core::storage::import::{DATA_FILE, INDEX_FILE};
use memry_core::storage::recovery::marker_path;

use super::{ImportError, Paths, StagedVault, crash, remove_staging};
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

/// Where install keeps the `core/index.db` it replaces until `data.db` is in place.
const REPLACED_INDEX_DIR: &str = "replaced-index";

/// Moves each file of the `index.db` in `from_dir` that exists into `to_dir`. Out of `core/`
/// the sidecars go first and `index.db` last, into it `index.db` goes first: a move that fails
/// part way never leaves a WAL in `core/` without the database it belongs to.
fn move_index(from_dir: &Path, to_dir: &Path, core: &Path) -> Result<(), ImportError> {
    let index = from_dir.join(INDEX_FILE);
    let mut files = vec![index.clone()];
    files.extend(sidecars(&index));
    if from_dir == core {
        files.rotate_left(1);
    }
    for from in files {
        let Some(name) = from.file_name() else {
            continue;
        };
        match rename_no_replace(&from, &to_dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(ImportError::io(&from, e)),
        }
    }
    Ok(())
}

/// Puts the `index.db` moved aside back into `core/`. A failure is logged and leaves it in
/// staging, which the next run deletes: with no `core/data.db` beside it, it is rebuildable.
fn restore_index(paths: &Paths, aside: &Path) {
    if let Err(error) = move_index(aside, &paths.core, &paths.core) {
        tracing::warn!(%error, "could not put the replaced core/index.db back");
    }
    sync_dir(&paths.core);
}

/// A run cut off between the two renames left the imported `index.db` in `core/` and the one it
/// replaced in staging, and the vault then opened natively (`NativeFirst`): the imported index
/// leaves `core/` with its sidecars and the replaced one goes back, before staging is removed.
pub(super) fn restore_replaced_index(paths: &Paths) -> Result<(), ImportError> {
    let aside = paths.staging.join(REPLACED_INDEX_DIR);
    if !aside.join(INDEX_FILE).exists() {
        return Ok(());
    }
    // A rerun cut off below left the imported index here; a native open may have created
    // another `core/index.db` since, which must find the directory empty.
    let imported = paths.staging.join("imported-index");
    match fs::remove_dir_all(&imported) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(ImportError::io(&imported, e)),
    }
    fs::create_dir_all(&imported).map_err(|e| ImportError::io(&imported, e))?;
    move_index(&paths.core, &imported, &paths.core)?;
    crash::point("native-first:index-taken-out");
    move_index(&aside, &paths.core, &paths.core)?;
    sync_dir(&paths.core);
    Ok(())
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

        refuse_if_present(&data)?;
        for path in sidecars(&data) {
            refuse_if_present(&path)?;
        }
        refuse_if_present(&marker_path(&data))?;

        // A `core/index.db` with no `core/data.db` is an earlier run's, cut off between the two
        // renames, or a rebuildable index; the staged one replaces it once `data.db` follows.
        let index = paths.core.join(INDEX_FILE);
        let aside = paths.staging.join(REPLACED_INDEX_DIR);
        fs::create_dir_all(&aside).map_err(|e| ImportError::io(&aside, e))?;
        if let Err(error) = move_index(&paths.core, &aside, &paths.core)
            .and_then(|()| rename(&paths.staging.join(INDEX_FILE), &index))
        {
            restore_index(&paths, &aside);
            return Err(error);
        }
        sync_dir(&paths.core);
        crash::point("install:index-renamed");

        if let Err(error) = rename(&paths.staging.join(DATA_FILE), &data) {
            // A native open raced the renames: the staged index leaves `core/` again, with any
            // WAL the native open wrote beside it, so none is replayed into the restored index.
            match move_index(&paths.core, &paths.staging, &paths.core) {
                Ok(()) => restore_index(&paths, &aside),
                Err(e) => tracing::warn!(%e, "could not take the staged index.db back"),
            }
            return Err(error);
        }
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
