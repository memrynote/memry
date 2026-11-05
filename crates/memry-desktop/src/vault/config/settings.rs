//! The vault settings as the app reads and changes them: `getConfig` and `updateConfig` of
//! `vault/index.ts`, behind `vault:get-config` and `vault:update-config`.
//!
//! A read gives the journal folder and date format in their canonical form, as every reader
//! parses them (`normalizeJournalSettings`). An update writes the fields it names over the
//! stored ones, the rest of the file kept ([`write_vault_config`]).
//!
//! A new journal date format renames the day files first, as Electron's `updateConfig` does
//! (`vault::journal_rename`): a day is a day only while its name is in the format, so without
//! the rename each day's next move would be a crossing and the day would be deleted. A config
//! that then cannot be written puts the files back. The rename keeps the watcher running, as
//! the pass says why; Electron stops it instead.
//!
//! Not here yet (Step 13m-7b): a change of the journal folder or the exclude patterns, each of
//! which comes with its own work in Electron (the folder followed, the watcher restarted). Such a
//! change is refused ([`SettingsError::NotPorted`]); the same value again is no change and passes.

use std::path::Path;
use std::sync::{Mutex, PoisonError};

use super::{ConfigError, VaultConfig, VaultConfigPatch, read_vault_config, write_vault_config};
use crate::vault::journal_format::{normalize_journal_date_format, normalize_journal_folder};
use crate::vault::journal_rename::{
    JournalRename, JournalVault, rename_journals_for_format_change, revert_journal_renames,
};

const SCOPE: &str = "vault_settings";

/// One update at a time, from its first read to its announcement, as Electron's main thread
/// runs them: two windows saving at once are heard in the order their writes land.
static UPDATES: Mutex<()> = Mutex::new(());

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    /// The field, by its `config.json` key, changes and that is not ported yet.
    #[error("changing {0} is not available in this build yet")]
    NotPorted(&'static str),
    #[error(transparent)]
    Config(#[from] ConfigError),
}

/// `getConfig`: the open vault's settings, or with none open the fallback Electron answers
/// (no exclude patterns, unlike a new vault's).
pub fn vault_settings(root: Option<&Path>) -> VaultConfig {
    let Some(root) = root else {
        return VaultConfig {
            exclude_patterns: Vec::new(),
            ..VaultConfig::default()
        };
    };
    normalized(read_vault_config(root))
}

fn normalized(config: VaultConfig) -> VaultConfig {
    VaultConfig {
        journal_folder: normalize_journal_folder(&config.journal_folder),
        journal_date_format: normalize_journal_date_format(&config.journal_date_format),
        ..config
    }
}

/// `updateConfig` in the open vault `at`: renames the day files for a new date format, writes
/// `patch` (its journal fields normalized), hands the settings after it to `announce` and
/// answers them. A field the patch gives its current value is left as stored; a patch with
/// nothing else writes and announces nothing.
pub fn update_vault_settings(
    at: JournalVault<'_>,
    mut patch: VaultConfigPatch,
    announce: impl FnOnce(&VaultConfig),
) -> Result<VaultConfig, SettingsError> {
    let _one_at_a_time = UPDATES.lock().unwrap_or_else(PoisonError::into_inner);
    let current = vault_settings(Some(at.root));
    let folder = patch
        .journal_folder
        .take()
        .map(|f| normalize_journal_folder(&f));
    refuse_change("journalFolder", folder, &current.journal_folder)?;
    refuse_change(
        "excludePatterns",
        patch.exclude_patterns.take(),
        &current.exclude_patterns,
    )?;
    patch.journal_date_format = patch
        .journal_date_format
        .take()
        .map(|f| normalize_journal_date_format(&f))
        .filter(|format| *format != current.journal_date_format);
    if patch == VaultConfigPatch::default() {
        return Ok(current);
    }
    let moved = match &patch.journal_date_format {
        Some(format) => renamed_for(at, &current, format),
        None => Vec::new(),
    };
    let written = write_vault_config(at.root, &patch).inspect_err(|_| {
        let left = revert_journal_renames(at, &current.journal_folder, &moved);
        if !left.is_empty() {
            tracing::error!(
                scope = SCOPE,
                left = left.len(),
                "day files kept the names of a date format that was not saved"
            );
        }
    })?;
    let settings = normalized(written);
    announce(&settings);
    Ok(settings)
}

/// The day files moved to their names in `format`. A journal folder that could not be listed
/// moves none, and the format is saved all the same, as Electron logs the failure and goes on.
fn renamed_for(at: JournalVault<'_>, current: &VaultConfig, format: &str) -> Vec<JournalRename> {
    let renamed = rename_journals_for_format_change(
        at,
        &current.journal_folder,
        &current.journal_date_format,
        format,
    );
    match renamed {
        Ok(result) => result.moved,
        Err(error) => {
            tracing::error!(
                scope = SCOPE,
                "the day files were not renamed for the new date format: {error}"
            );
            Vec::new()
        }
    }
}

fn refuse_change<T: PartialEq>(
    key: &'static str,
    wanted: Option<T>,
    current: &T,
) -> Result<(), SettingsError> {
    match wanted {
        Some(value) if value != *current => Err(SettingsError::NotPorted(key)),
        _ => Ok(()),
    }
}
