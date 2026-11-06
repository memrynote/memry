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
//! Stricter than Electron, a format is saved only when every day takes it, since a day left at
//! its old name is a note under the new format, deleted as a day by its next move. A format
//! that cannot name every date, a journal folder that cannot be listed, or a day that could not
//! be renamed (its new name taken, or the move failed) refuses the change, the renamed days put
//! back; Electron logs these and saves. So does a config that cannot be read, whose format and
//! folder the update would otherwise take from the defaults.
//!
//! The journal folder moved in the app with a folder that holds it takes the setting along
//! ([`JournalFollow`], `notes::folder_move`), as Electron's `followJournalFolderMove` does.
//!
//! Not here yet (Step 13m-7b): a change of the journal folder or the exclude patterns in
//! Settings, each of which comes with its own work in Electron (the days moved, the watcher
//! restarted). Such a change is refused ([`SettingsError::NotPorted`]); the same value again is
//! no change and passes.

use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard};

use memry_core::api::vault::Vault;

use super::{
    ConfigError, VaultConfig, VaultConfigPatch, read_vault_config, read_vault_config_strict,
    unreadable, write_vault_config,
};
use crate::locks::Refused;
use crate::vault::consumer::VaultTier;
use crate::vault::journal_format::{normalize_journal_date_format, normalize_journal_folder};
use crate::vault::journal_rename::{
    JournalRename, JournalVault, RenameError, is_complete_journal_format,
    rename_journals_for_format_change_checked, revert_journal_renames,
};

const SCOPE: &str = "vault_settings";

/// One update at a time, from its first read to its announcement, as Electron's main thread
/// runs them: two windows saving at once are heard in the order their writes land.
static UPDATES: Mutex<()> = Mutex::new(());

/// The date format a new day file is named in. A format change holds it alone from its
/// renames to its save; a day create holds it shared from naming its file to writing it
/// ([`day_names`]). A day made during the renames would otherwise take the old format's name
/// after the folder was listed, and stay a note under the new format.
static DAY_NAMES: RwLock<()> = RwLock::new(());

/// Held by a day create while it names and writes its file (`journal::write`). Lock order:
/// this, then the rows' lane.
pub(crate) fn day_names() -> RwLockReadGuard<'static, ()> {
    DAY_NAMES.read().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    /// The field, by its `config.json` key, changes and that is not ported yet.
    #[error("changing {0} is not available in this build yet")]
    NotPorted(&'static str),
    /// The new date format cannot name every date, so no day could keep its name in it.
    #[error("the date format cannot name every date")]
    IncompleteFormat,
    #[error("the journal folder could not be listed: {0}")]
    JournalUnlisted(io::Error),
    /// A lock covers a day the new format would rename, or the name it would take: nothing was
    /// renamed (`journal-format-migration.ts`).
    #[error("{}", Refused::Note.message())]
    Locked,
    /// `left` days could not take their names in the new format; the others went back.
    #[error("{left} journal days could not be renamed to the new date format")]
    DaysNotRenamed { left: usize },
    /// A date format change in a vault whose tier did not start, through which the days move.
    #[error("the vault's tier is not running")]
    NoTier,
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

/// `updateConfig` in the vault at `root`: renames the day files for a new date format through
/// the open vault's core and tier (`days`), writes `patch` (its journal fields normalized),
/// hands the settings after it to `announce` and answers them. A field the patch gives its
/// current value is left as stored; a patch with nothing else writes and announces nothing.
pub fn update_vault_settings(
    root: &Path,
    days: Option<(&Arc<Vault>, &VaultTier)>,
    patch: VaultConfigPatch,
    announce: impl FnOnce(&VaultConfig),
) -> Result<VaultConfig, SettingsError> {
    update_vault_settings_checked(root, days, patch, announce, &mut || {})
}

/// [`update_vault_settings`] with a hook between the two steps of each day's rename
/// (`rename_journals_for_format_change_checked`), so a test can act there.
#[doc(hidden)]
pub fn update_vault_settings_checked(
    root: &Path,
    days: Option<(&Arc<Vault>, &VaultTier)>,
    mut patch: VaultConfigPatch,
    announce: impl FnOnce(&VaultConfig),
    between: &mut dyn FnMut(),
) -> Result<VaultConfig, SettingsError> {
    let _one_at_a_time = UPDATES.lock().unwrap_or_else(PoisonError::into_inner);
    let current =
        normalized(read_vault_config_strict(root).map_err(|message| unreadable(root, message))?);
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
    let _no_day_made = patch
        .journal_date_format
        .is_some()
        .then(|| DAY_NAMES.write().unwrap_or_else(PoisonError::into_inner));
    let renamed = match &patch.journal_date_format {
        Some(format) => {
            let (vault, tier) = days.ok_or(SettingsError::NoTier)?;
            let at = JournalVault { root, vault, tier };
            Some((at, renamed_for(at, &current, format, between)?))
        }
        None => None,
    };
    let written = write_vault_config(root, &patch).inspect_err(|_| {
        if let Some((at, moved)) = &renamed {
            put_back(*at, &current, moved);
        }
    })?;
    let settings = normalized(written);
    announce(&settings);
    Ok(settings)
}

/// The day files moved to their names in `format`, every one of them, or the change refused
/// with the moved ones put back (the module's doc).
fn renamed_for(
    at: JournalVault<'_>,
    current: &VaultConfig,
    format: &str,
    between: &mut dyn FnMut(),
) -> Result<Vec<JournalRename>, SettingsError> {
    if !is_complete_journal_format(format) {
        return Err(SettingsError::IncompleteFormat);
    }
    let renamed = rename_journals_for_format_change_checked(
        at,
        &current.journal_folder,
        &current.journal_date_format,
        format,
        between,
    )
    .map_err(|error| match error {
        RenameError::Unlisted(error) => SettingsError::JournalUnlisted(error),
        RenameError::Locked => SettingsError::Locked,
    })?;
    let left = renamed.skipped + renamed.failed;
    if left > 0 {
        put_back(at, current, &renamed.moved);
        return Err(SettingsError::DaysNotRenamed { left });
    }
    Ok(renamed.moved)
}

/// Takes back the renames of a format that is not saved, so each day file is named in the
/// format it is read with.
fn put_back(at: JournalVault<'_>, current: &VaultConfig, moved: &[JournalRename]) {
    let left = revert_journal_renames(at, &current.journal_folder, moved);
    if !left.is_empty() {
        tracing::error!(
            scope = SCOPE,
            left = left.len(),
            "day files kept the names of a date format that was not saved"
        );
    }
}

/// The settings' update lock as a move of the journal folder in the app holds it, from before
/// the rows' lane until the setting follows the folder (`notes::folder_move`, and the open that
/// finishes such a move, `vault::app_move`): one update at a time. A day create names its file
/// under the lane (`journal::write`), so the lane orders it after the save.
pub(crate) struct JournalFollow {
    _updates: MutexGuard<'static, ()>,
}

impl JournalFollow {
    pub(crate) fn hold() -> Self {
        Self {
            _updates: UPDATES.lock().unwrap_or_else(PoisonError::into_inner),
        }
    }

    /// Saves `folder` as the journal folder (`followJournalFolder`) and answers the settings
    /// after it.
    pub(crate) fn save(&self, root: &Path, folder: &str) -> Result<VaultConfig, ConfigError> {
        let patch = VaultConfigPatch {
            journal_folder: Some(folder.to_owned()),
            ..VaultConfigPatch::default()
        };
        write_vault_config(root, &patch).map(normalized)
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
