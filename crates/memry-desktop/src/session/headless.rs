//! The open of a process that is not the app: the command line (Step 35, #3552).
//!
//! The app's open ([`super::Session`]) is the vault's one owner in its process: it sweeps
//! interrupted folder moves, shows kept copies, records the open in the registry, opens the
//! index (rebuilding a damaged one) and starts the watcher and the open hooks. A second process
//! doing any of that would act under a running app (put back a folder the app is moving, rebuild
//! the index it searches), so this open does only what reading and writing the core needs: the
//! core databases, migrated, and the vault's origin. It never creates the core next to an
//! Electron database the import has not brought over.

use std::path::Path;

use memry_core::api::vault::Vault;
use memry_core::storage::OpenOptions;

use super::SessionError;
use super::open::{core_dir, prepare_core_dir, record_origin};

/// What [`open_headless`] found.
pub enum HeadlessOpen {
    Opened(Vault),
    /// Electron's `.memry/data.db` is there and the import has not brought it into the core
    /// (no core, or no `electron_import.v1` row). Nothing was created.
    NotMigrated,
}

/// Opens the vault at `path` (an existing folder) for the command line. A folder with no
/// `.memry` is initialised as the app initialises it. `data.db` is opened without the integrity
/// probe: only the app offers the way out of a damaged database, so the command line reports
/// the error a read reaches instead of refusing every command.
pub fn open_headless(path: &Path) -> Result<HeadlessOpen, SessionError> {
    let over_electron = path.join(".memry").join("data.db").is_file();
    if over_electron && !core_dir(path).join("data.db").is_file() {
        return Ok(HeadlessOpen::NotMigrated);
    }
    let core = prepare_core_dir(path)?;
    let vault = Vault::open_with(
        core.to_string_lossy().into_owned(),
        OpenOptions {
            verify_integrity: false,
        },
    )?;
    if over_electron && !vault.electron_imported()? {
        return Ok(HeadlessOpen::NotMigrated);
    }
    record_origin(path, &vault);
    Ok(HeadlessOpen::Opened(vault))
}
