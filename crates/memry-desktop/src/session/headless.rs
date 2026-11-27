//! The open of a process that is not the app: the command line (Step 35, #3552).
//!
//! The app's open ([`super::Session`]) is the vault's one owner in its process: it sweeps
//! interrupted folder moves, shows kept copies, records the open in the registry, opens the
//! index (rebuilding a damaged one), recovers a damaged `data.db` and starts the watcher and the
//! open hooks. A second process doing any of that would act under a running app (put back a
//! folder the app is moving, rebuild the index it searches, salvage a database it is
//! salvaging), so this open does only what reading and writing the core needs: the core
//! databases, migrated, and the vault's origin. A damaged `data.db` it leaves as found for the
//! app's Repair.
//!
//! Beside Electron's `.memry/data.db` it opens the core only where the core may mint note ids
//! ([`mints_beside_electron`]: the import brought Electron's data over, or the core was created
//! for a vault that was not Electron's), the rule `Session::open` and the note identity follow.
//! It decides that over a read-only connection before any migration runs, and never creates
//! the core there.

use std::path::Path;

use memry_core::api::errors::StorageError;
use memry_core::api::vault::Vault;
use memry_core::domain::notes::identity::{VAULT_ORIGIN_META_KEY, mints_beside_electron};
use memry_core::storage::OpenOptions;
use memry_core::storage::recovery::marker_path;
use rusqlite::{Connection, OpenFlags, OptionalExtension as _};

use super::SessionError;
use super::open::{core_dir, prepare_core_dir, record_origin};

/// What [`open_headless`] found. Every variant but `Opened` created and changed nothing.
pub enum HeadlessOpen {
    Opened(Vault),
    /// Electron's `.memry/data.db` is there and the import has not brought it into the core:
    /// no core yet, or a core with nothing recorded. The app's next open imports it.
    NotMigrated,
    /// The app created the core over Electron's `data.db` and the import left it there
    /// (`vault.origin.v1` is `electron`): the core mints no note id, and opening the app does
    /// not change that.
    OverElectron,
    /// A recovery of the core's `data.db` is under way or was interrupted: the app finishes it.
    Recovering,
    /// `data.db` is damaged: it is left as found, and the app's Repair is the way out.
    Damaged,
}

/// Opens the vault at `path` (an existing folder) for the command line. A folder with no
/// `.memry` is initialised as the app initialises it. `data.db` is opened as the app opens it,
/// behind the integrity probe (one `quick_check(1)`): a damaged file, or one an unfinished
/// recovery left, is [`HeadlessOpen::Damaged`] before anything writes to it, so the app's
/// Repair salvages it as it was found. The verified open never runs that rescue, which also
/// covers a Repair the app starts after the marker check below.
pub fn open_headless(path: &Path) -> Result<HeadlessOpen, SessionError> {
    let data_db = core_dir(path).join("data.db");
    if marker_path(&data_db).exists() {
        return Ok(HeadlessOpen::Recovering);
    }
    if path.join(".memry").join("data.db").is_file() {
        if !data_db.is_file() {
            return Ok(HeadlessOpen::NotMigrated);
        }
        match beside_electron(&data_db)? {
            Beside::Mints => {}
            Beside::Unrecorded => return Ok(HeadlessOpen::NotMigrated),
            Beside::OverElectron => return Ok(HeadlessOpen::OverElectron),
        }
    }
    let core = prepare_core_dir(path)?;
    let vault = match Vault::open_with(
        core.to_string_lossy().into_owned(),
        OpenOptions {
            verify_integrity: true,
        },
    ) {
        Err(StorageError::Corrupt { .. }) => return Ok(HeadlessOpen::Damaged),
        opened => opened?,
    };
    record_origin(path, &vault);
    Ok(HeadlessOpen::Opened(vault))
}

enum Beside {
    Mints,
    Unrecorded,
    OverElectron,
}

/// What the core beside Electron's database records, read over a read-only connection: no
/// migration, recovery or write runs before the answer.
fn beside_electron(data_db: &Path) -> Result<Beside, StorageError> {
    let failed = |error: rusqlite::Error| StorageError::Failed {
        what: format!("could not read {}: {error}", data_db.display()),
    };
    let conn = Connection::open_with_flags(
        data_db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(failed)?;
    if mints_beside_electron(&conn)? {
        return Ok(Beside::Mints);
    }
    let origin: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [VAULT_ORIGIN_META_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(match origin.as_deref() {
        Some("electron") => Beside::OverElectron,
        _ => Beside::Unrecorded,
    })
}
