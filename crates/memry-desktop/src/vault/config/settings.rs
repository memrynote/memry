//! The vault settings as the app reads and changes them: `getConfig` and `updateConfig` of
//! `vault/index.ts`, behind `vault:get-config` and `vault:update-config`.
//!
//! A read gives the journal folder and date format in their canonical form, as every reader
//! parses them (`normalizeJournalSettings`). An update writes the fields it names over the
//! stored ones, the rest of the file kept ([`write_vault_config`]).
//!
//! A new journal date format or folder moves the day files first, as Electron's `updateConfig`
//! renames them for a format (`vault::journal_rename`): a day is a day only while its path is
//! in the configured folder and format, so without the move each day's next move would be a
//! crossing and the day would be deleted. A config that then cannot be written puts the files
//! back. The pass keeps the watcher running, as it says why; Electron stops it instead.
//!
//! Stricter than Electron, a setting is saved only when every day takes it, since a day left at
//! its old path is a note under the new setting, deleted as a day by its next move. A format
//! that cannot name every date, a folder the days cannot live in ([`holds_journal_days`], or a
//! respelling of the current one in case only), a journal folder that cannot be listed, or a
//! day that could not be moved (its new path taken, or the move failed) refuses the change, the
//! moved days put back; Electron logs these and saves. So does a config that cannot be read,
//! whose format and folder the update would otherwise take from the defaults.
//!
//! A new journal folder moves the days only, the files of the old folder that its format reads
//! as dates; Electron moves nothing and rebuilds its index, which reads the days left behind as
//! notes. Here a day left behind would stay a day at a path no setting reads, so it is moved.
//!
//! The journal folder moved in the app with a folder that holds it takes the setting along
//! ([`JournalFollow`], `notes::folder_move`), as Electron's `followJournalFolderMove` does.
//!
//! Not here yet (Step 13m-7b-3): a change of the exclude patterns, which comes with its own work
//! in Electron (the watcher restarted). Such a change is refused ([`SettingsError::NotPorted`]);
//! the same value again is no change and passes.

use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

use memry_core::api::vault::Vault;

use super::{
    ConfigError, VaultConfig, VaultConfigPatch, read_vault_config, read_vault_config_strict,
    unreadable, write_vault_config,
};
use crate::notes::folders::holds_journal_days;
use crate::vault::consumer::VaultTier;
use crate::vault::journal_format::{normalize_journal_date_format, normalize_journal_folder};
use crate::vault::journal_rename::{
    JournalPlace, JournalRenameResult, JournalVault, is_complete_journal_format,
    move_journal_days_checked, revert_journal_moves,
};
use crate::vault::path_key::folded_key;

const SCOPE: &str = "vault_settings";

/// One update at a time, from its first read to its announcement, as Electron's main thread
/// runs them: two windows saving at once are heard in the order their writes land.
static UPDATES: Mutex<()> = Mutex::new(());

/// The folder and date format a new day file is named in. A change of either, and a move of the
/// journal folder in the app ([`JournalFollow`]), holds it alone from its moves to its save; a
/// day create holds it shared from naming its file to writing it ([`day_names`]). A day made
/// during the moves would otherwise take the old setting's path after the folder was listed,
/// and stay a note under the new one.
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
    /// The new journal folder is one the days cannot live in (the module's doc).
    #[error("the journal days cannot live in that folder")]
    InvalidJournalFolder,
    #[error("the journal folder could not be listed: {0}")]
    JournalUnlisted(io::Error),
    /// `left` days could not take their paths in the new setting; the others went back.
    #[error("{left} journal days could not be moved to the new journal setting")]
    DaysNotRenamed { left: usize },
    /// A journal setting change in a vault whose tier did not start, through which the days move.
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

/// `updateConfig` in the vault at `root`: moves the day files for a new date format or journal
/// folder through the open vault's core and tier (`days`), writes `patch` (its journal fields
/// normalized), hands the settings after it to `announce` and answers them. A field the patch
/// gives its current value is left as stored; a patch with nothing else writes and announces
/// nothing.
pub fn update_vault_settings(
    root: &Path,
    days: Option<(&Arc<Vault>, &VaultTier)>,
    patch: VaultConfigPatch,
    announce: impl FnOnce(&VaultConfig),
) -> Result<VaultConfig, SettingsError> {
    update_vault_settings_checked(root, days, patch, announce, &mut || {})
}

/// [`update_vault_settings`] with a hook between the two steps of each day's move
/// (`move_journal_days_checked`), so a test can act there.
#[doc(hidden)]
pub fn update_vault_settings_checked(
    root: &Path,
    days: Option<(&Arc<Vault>, &VaultTier)>,
    mut patch: VaultConfigPatch,
    announce: impl FnOnce(&VaultConfig),
    between: &mut dyn FnMut(),
) -> Result<VaultConfig, SettingsError> {
    let _one_at_a_time = UPDATES.lock().unwrap_or_else(PoisonError::into_inner);
    let current = strict(root)?;
    patch.journal_folder = patch
        .journal_folder
        .take()
        .map(|f| normalize_journal_folder(&f))
        .filter(|folder| *folder != current.journal_folder);
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
    let moves_days = patch.journal_folder.is_some() || patch.journal_date_format.is_some();
    let _no_day_made =
        moves_days.then(|| DAY_NAMES.write().unwrap_or_else(PoisonError::into_inner));
    let to = JournalPlace {
        folder: patch
            .journal_folder
            .as_deref()
            .unwrap_or(&current.journal_folder),
        format: (patch.journal_date_format.as_deref()).unwrap_or(&current.journal_date_format),
    };
    let moved = if moves_days {
        let (vault, tier) = days.ok_or(SettingsError::NoTier)?;
        let at = JournalVault { root, vault, tier };
        Some((at, moved_for(at, &current, to, between)?))
    } else {
        None
    };
    let written = write_vault_config(root, &patch).inspect_err(|_| {
        if let Some((at, moved)) = &moved {
            put_back(*at, &current, to.folder, moved);
        }
    })?;
    let settings = normalized(written);
    announce(&settings);
    Ok(settings)
}

/// The settings as stored, read strictly: one that cannot be read names no folder or format
/// to move days from.
fn strict(root: &Path) -> Result<VaultConfig, SettingsError> {
    Ok(normalized(
        read_vault_config_strict(root).map_err(|message| unreadable(root, message))?,
    ))
}

/// The day files moved to their paths in `to`, every one of them, or the change refused with
/// the moved ones put back (the module's doc).
fn moved_for(
    at: JournalVault<'_>,
    current: &VaultConfig,
    to: JournalPlace<'_>,
    between: &mut dyn FnMut(),
) -> Result<JournalRenameResult, SettingsError> {
    if to.format != current.journal_date_format && !is_complete_journal_format(to.format) {
        return Err(SettingsError::IncompleteFormat);
    }
    if to.folder != current.journal_folder {
        let respelled = folded_key(to.folder) == folded_key(&current.journal_folder);
        let holds = holds_journal_days(at.root, to.folder, current.exclude_patterns.clone())
            .map_err(SettingsError::JournalUnlisted)?;
        if respelled || !holds {
            return Err(SettingsError::InvalidJournalFolder);
        }
    }
    let from = JournalPlace {
        folder: &current.journal_folder,
        format: &current.journal_date_format,
    };
    let moved =
        move_journal_days_checked(at, from, to, between).map_err(SettingsError::JournalUnlisted)?;
    let left = moved.skipped + moved.failed;
    if left > 0 {
        put_back(at, current, to.folder, &moved);
        return Err(SettingsError::DaysNotRenamed { left });
    }
    Ok(moved)
}

/// Takes back the moves of a setting that is not saved, so each day file is at a path the
/// setting it is read with names.
fn put_back(at: JournalVault<'_>, current: &VaultConfig, to: &str, moved: &JournalRenameResult) {
    let left = revert_journal_moves(at, (&current.journal_folder, to), moved);
    if !left.is_empty() {
        tracing::error!(
            scope = SCOPE,
            left = left.len(),
            "day files kept the paths of a journal setting that was not saved"
        );
    }
}

/// The settings' locks as a move of the journal folder in the app holds them, from before the
/// rows' lane until the setting follows the folder (`notes::folder_move`): one update at a
/// time, and no day named meanwhile ([`DAY_NAMES`]).
pub(crate) struct JournalFollow {
    _updates: MutexGuard<'static, ()>,
    _day_names: RwLockWriteGuard<'static, ()>,
}

impl JournalFollow {
    pub(crate) fn hold() -> Self {
        let updates = UPDATES.lock().unwrap_or_else(PoisonError::into_inner);
        let day_names = DAY_NAMES.write().unwrap_or_else(PoisonError::into_inner);
        Self {
            _updates: updates,
            _day_names: day_names,
        }
    }

    /// The settings as stored, read strictly.
    pub(crate) fn current(&self, root: &Path) -> Result<VaultConfig, SettingsError> {
        strict(root)
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
