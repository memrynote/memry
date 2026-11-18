//! The vault a command runs on (`createMemryApp` of `apps/cli/src/app-core/memry-app.ts`), and
//! the migration guard in front of it (#3552 Design, "Opening a vault").
//!
//! The command line never creates core databases beside Electron data the import has not
//! brought over. App level: the app has no `memry-config.json` yet, an Electron profile is
//! there and the import has not written its marker. Vault level: the vault has Electron's
//! `.memry/data.db` and no core, or a core without the import's proof row
//! ([`memry_desktop::session::open_headless`] decides). Either fails every command but the four
//! registry ones with [`NOT_MIGRATED`].

use std::path::Path;

use memry_core::api::vault::Vault;
use memry_desktop::electron_import::profile::locate_profile;
use memry_desktop::registry::CONFIG_FILE;
use memry_desktop::session::{HeadlessOpen, open_headless};

use crate::registry::normalize;
use crate::{CliDeps, CliError};

pub const NOT_MIGRATED: &str = "MemryNote has not finished updating your data. Open MemryNote once, then run this command again.";

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
    if dir.join(CONFIG_FILE).exists() || dir.join(IMPORT_MARKER).exists() {
        return Ok(());
    }
    match locate_profile(profile) {
        Ok(None) => Ok(()),
        Ok(Some(_)) | Err(_) => Err(NOT_MIGRATED.into()),
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
    }
}

fn create_dir(root: &Path) -> Result<(), CliError> {
    std::fs::create_dir_all(root).map_err(|error| CliError(format!("{}: {error}", root.display())))
}
