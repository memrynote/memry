//! The vault settings as the app reads and changes them: `getConfig` and `updateConfig` of
//! `vault/index.ts`, behind `vault:get-config` and `vault:update-config`.
//!
//! A read gives the journal folder and date format in their canonical form, as every reader
//! parses them (`normalizeJournalSettings`). An update writes the fields it names over the
//! stored ones, the rest of the file kept ([`write_vault_config`]).
//!
//! Not here yet (Step 13m-7b): a change of the journal folder, the journal date format or the
//! exclude patterns. In Electron each one comes with its work: the journal files renamed to the
//! new format, the watcher restarted, the index rebuilt. The tier here reads the config at
//! every file event, so the setting alone would make each day's next move a crossing, and the
//! day would be deleted. Such a change is refused ([`SettingsError::NotPorted`]); the same value
//! again is no change and passes.

use std::path::Path;
use std::sync::{Mutex, PoisonError};

use super::{ConfigError, VaultConfig, VaultConfigPatch, read_vault_config, write_vault_config};
use crate::vault::journal_format::{normalize_journal_date_format, normalize_journal_folder};

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

/// `updateConfig`: writes `patch` (its journal fields normalized), hands the settings after it
/// to `announce` and answers them. A field the patch gives its current value is left as stored;
/// a patch with nothing else writes and announces nothing.
pub fn update_vault_settings(
    root: &Path,
    mut patch: VaultConfigPatch,
    announce: impl FnOnce(&VaultConfig),
) -> Result<VaultConfig, SettingsError> {
    let _one_at_a_time = UPDATES.lock().unwrap_or_else(PoisonError::into_inner);
    let current = vault_settings(Some(root));
    let folder = patch
        .journal_folder
        .take()
        .map(|f| normalize_journal_folder(&f));
    let format = patch
        .journal_date_format
        .take()
        .map(|f| normalize_journal_date_format(&f));
    refuse_change("journalFolder", folder, &current.journal_folder)?;
    refuse_change("journalDateFormat", format, &current.journal_date_format)?;
    refuse_change(
        "excludePatterns",
        patch.exclude_patterns.take(),
        &current.exclude_patterns,
    )?;
    if patch == VaultConfigPatch::default() {
        return Ok(current);
    }
    let settings = normalized(write_vault_config(root, &patch)?);
    announce(&settings);
    Ok(settings)
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
