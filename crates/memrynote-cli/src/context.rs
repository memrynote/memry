//! The vault a command runs on (`createMemryApp` of `apps/cli/src/app-core/memry-app.ts`), and
//! the migration guard in front of it (#3552 Design, "Opening a vault", as amended on #3552).
//!
//! The command line never creates core databases beside Electron data the import has not
//! brought over, and never runs the app's recovery. App level, Step 37's trigger: the import
//! has not written its marker and the Electron profile holds `memry-config.json` or
//! `secure-secrets.json`. Vault level: [`memry_desktop::session::open_headless`] decides.
//! Either fails every command but the four registry ones.

use std::path::Path;

use memry_core::api::vault::Vault;
use memry_desktop::electron_import::profile::locate_profile;
use memry_desktop::session::{HeadlessOpen, open_headless};

use crate::registry::normalize;
use crate::{CliDeps, CliError};

pub const NOT_MIGRATED: &str = "MemryNote has not finished updating your data. Open MemryNote once, then run this command again.";
pub const OVER_ELECTRON: &str = "This vault still holds data of the previous MemryNote that was never brought over, so the command line cannot use it. Use this vault in MemryNote.";
pub const RECOVERING: &str = "MemryNote is repairing this vault's database. Open MemryNote and let it finish, then run this command again.";

/// Written last by the app's Electron import (Step 37, #3554) into its data folder.
pub const IMPORT_MARKER: &str = "electron-import.json";

/// An open vault. `path` is the vault as the command line named it (`vaultPath`).
pub struct VaultContext {
    pub path: String,
    #[expect(
        dead_code,
        reason = "held open for the command; the groups of stages C to E read it"
    )]
    pub vault: Vault,
}

/// The app-level guard. A profile search that fails blocks: the data it could not look at may
/// be the user's.
pub fn check_app(deps: &CliDeps) -> Result<(), CliError> {
    let (Some(dir), Some(profile)) = (&deps.data_dir, &deps.electron_profile) else {
        return Ok(());
    };
    if dir.join(IMPORT_MARKER).exists() {
        return Ok(());
    }
    match locate_profile(profile) {
        Ok(Some(found)) if found.has_config || found.has_secure_store => Err(NOT_MIGRATED.into()),
        Ok(_) => Ok(()),
        Err(_) => Err(NOT_MIGRATED.into()),
    }
}

/// Opens the vault: creates the folder as `ensureVaultLayout`'s recursive `mkdir` does, then
/// the headless open.
pub fn open(vault: &str, deps: &CliDeps) -> Result<VaultContext, CliError> {
    let root = normalize(&deps.cwd.join(vault));
    create_dir(&root)?;
    match open_headless(&root).map_err(|error| CliError(error.to_string()))? {
        HeadlessOpen::Opened(opened) => Ok(VaultContext {
            path: vault.to_owned(),
            vault: opened,
        }),
        HeadlessOpen::NotMigrated => Err(NOT_MIGRATED.into()),
        HeadlessOpen::OverElectron => Err(OVER_ELECTRON.into()),
        HeadlessOpen::Recovering => Err(RECOVERING.into()),
    }
}

fn create_dir(root: &Path) -> Result<(), CliError> {
    std::fs::create_dir_all(root).map_err(|error| CliError(format!("{}: {error}", root.display())))
}
