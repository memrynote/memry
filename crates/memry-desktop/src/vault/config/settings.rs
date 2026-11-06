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
//! that cannot name every date, a folder the days cannot live in ([`holds_journal_days`], one
//! the vault cannot hold, or a drive `D:`), a respelling of the current folder in case only
//! (the sidebar rename does that), a journal folder that cannot be listed, or a day that could
//! not be moved (its new path taken, or the move failed) refuses the change, the moved days put
//! back; Electron logs these and saves. So does a config that cannot be read, whose format and
//! folder the update would otherwise take from the defaults.
//!
//! A new journal folder moves the days only, the files of the old folder that its format reads
//! as dates and whose records are days; Electron moves nothing and rebuilds its index, which
//! reads the days left behind as notes. Here a day left behind would stay a day at a path no
//! setting reads, so it is moved.
//!
//! The change is recorded before the first day moves and forgotten once the setting is saved
//! or every day went back (`journal_rename::finish_journal_change`): a crash between leaves the
//! record, and the next open puts the days back. A change an open could not finish is finished
//! first by the next update, which records no other change while it waits. Nor while a note
//! move waits for an open that can finish it (`vault::app_move`), a folder move's notes
//! included ([`SettingsError::MovesWait`]): a day's file may be on disk where the saved setting
//! does not read it yet, so the day would not be listed, and the open after the save would
//! settle its move under the new setting, as a crossing that deletes it. A folder move records
//! a move for each note it carries, so one that carries no note waits on nothing here. A journal
//! folder moved outside the app has its setting follow it first (`journal::folder_follow`), so
//! its held days move from where they are; saved over them, the next open would cross each into
//! a note. While held days wait for the setting to follow (it cannot), no change that moves
//! days is made ([`SettingsError::JournalFolderHeld`]).
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

use memry_core::api::notes_write::NotesWriter;
use memry_core::api::vault::Vault;
use memry_core::domain::notes::app_move::BeginError;
use memry_core::domain::notes::journal_change::{JournalSetting, PendingJournalChange};

use super::{
    ConfigError, VaultConfig, VaultConfigPatch, read_vault_config, read_vault_config_strict,
    unreadable, write_vault_config,
};
use crate::journal::folder_follow::{Follow, follow_moved_journal};
use crate::notes::folders::holds_journal_days;
use crate::vault::consumer::VaultTier;
use crate::vault::journal_format::{normalize_journal_date_format, normalize_journal_folder};
use crate::vault::journal_rename::{
    ChangeStep, JournalPlace, JournalRenameResult, JournalVault, finish_journal_change,
    forget_change, is_complete_journal_format, missing_folders, move_journal_days_checked,
    revert_journal_moves_checked,
};
use crate::vault::path_key::folded_key;
use crate::vault::paths::safe_join;

const SCOPE: &str = "vault_settings";

/// One update at a time, from its first read to its announcement, as Electron's main thread
/// runs them: two windows saving at once are heard in the order their writes land.
static UPDATES: Mutex<()> = Mutex::new(());

/// The folder and date format a new day file is named in. A change of either holds it alone
/// from its moves to its save, and so does the finish of one a crash cut short; a day create
/// holds it shared from naming its file to writing it ([`day_names`]). A day made during the
/// moves would otherwise take the old setting's path after the folder was listed, and stay a
/// note under the new one.
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
    /// The new journal folder is the current one in another case.
    #[error("the journal folder differs from the current one in case only")]
    RespelledJournalFolder,
    #[error("the journal folder could not be listed: {0}")]
    JournalUnlisted(io::Error),
    /// `left` days could not take their paths in the new setting; the others went back.
    #[error("{left} journal days could not be moved to the new journal setting")]
    DaysNotRenamed { left: usize },
    /// An earlier change's days still wait to go back (`journal_rename::finish_journal_change`),
    /// or another version of the app recorded a change this one cannot finish.
    #[error("an earlier journal setting change did not finish")]
    ChangeWaits,
    /// A note move waits for an open that can finish it (the module's doc).
    #[error("a note move did not finish")]
    MovesWait,
    /// Journal days a journal folder moved outside the app carried wait for the setting to
    /// follow them (`journal::folder_follow::Follow::HeldWaits`).
    #[error("journal days wait for the setting to follow the journal folder")]
    JournalFolderHeld,
    /// The change could not be recorded before its first move, so nothing moved.
    #[error("the journal setting change could not be recorded: {0}")]
    Unrecorded(String),
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
    update_vault_settings_checked(root, days, patch, announce, &mut |_| {})
}

/// [`update_vault_settings`] with a hook at each [`ChangeStep`] of a change that moves the
/// days, so a test can stop it there as a crash would.
#[doc(hidden)]
pub fn update_vault_settings_checked(
    root: &Path,
    days: Option<(&Arc<Vault>, &VaultTier)>,
    mut patch: VaultConfigPatch,
    announce: impl FnOnce(&VaultConfig),
    step: &mut dyn FnMut(ChangeStep),
) -> Result<VaultConfig, SettingsError> {
    // Before the settings' lock, which it takes: a journal folder moved outside the app has
    // its setting follow it, so the days move from where they are.
    let follow = days.map_or(Follow::Nothing, |(vault, tier)| {
        match vault.notes_writer(tier.store()) {
            Ok(writer) => follow_moved_journal(root, &writer),
            Err(error) => {
                tracing::warn!(
                    scope = SCOPE,
                    "a journal folder moved outside the app was not looked for: {error}"
                );
                Follow::Nothing
            }
        }
    });
    let held = JournalFollow::hold();
    if let Some((vault, tier)) = days {
        finish_journal_change(JournalVault { root, vault, tier }, &held);
    }
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
    if moves_days && matches!(follow, Follow::HeldWaits { .. }) {
        return Err(SettingsError::JournalFolderHeld);
    }
    let _no_day_made = moves_days.then(|| held.no_day_named());
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
        Some(moved_for(at, &current, to, step)?)
    } else {
        None
    };
    let written = write_vault_config(root, &patch).inspect_err(|_| {
        if let Some(moved) = &moved {
            moved.put_back(step);
        }
    })?;
    step(ChangeStep::Saved);
    if let Some(moved) = &moved {
        forget_change(&moved.writer, &moved.change);
    }
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

/// The days a change moved, and its record.
struct Moved<'a> {
    at: JournalVault<'a>,
    writer: Arc<NotesWriter>,
    change: PendingJournalChange,
    pass: JournalRenameResult,
}

impl Moved<'_> {
    /// Takes back the moves of a setting that is not saved, so each day file is at a path the
    /// setting it is read with names. The record goes once every day is back; a day that is
    /// not keeps it, and the next open tries again.
    fn put_back(&self, step: &mut dyn FnMut(ChangeStep)) {
        let folders = (
            self.change.from.folder.as_str(),
            self.change.to.folder.as_str(),
        );
        let left = revert_journal_moves_checked(self.at, folders, &self.pass, step);
        if left.is_empty() {
            forget_change(&self.writer, &self.change);
        } else {
            tracing::error!(
                scope = SCOPE,
                left = left.len(),
                "day files kept the paths of a journal setting that was not saved; the next open \
                 puts them back"
            );
        }
    }
}

/// The day files moved to their paths in `to`, every one of them, or the change refused with
/// the moved ones put back (the module's doc).
fn moved_for<'a>(
    at: JournalVault<'a>,
    current: &VaultConfig,
    to: JournalPlace<'_>,
    step: &mut dyn FnMut(ChangeStep),
) -> Result<Moved<'a>, SettingsError> {
    if to.format != current.journal_date_format && !is_complete_journal_format(to.format) {
        return Err(SettingsError::IncompleteFormat);
    }
    if to.folder != current.journal_folder {
        if folded_key(to.folder) == folded_key(&current.journal_folder) {
            return Err(SettingsError::RespelledJournalFolder);
        }
        // `D:/Diary` is a folder on macOS and a drive on Windows, where the vault cannot hold it.
        let joins = safe_join(at.root, &[to.folder]).is_some()
            && !to.folder.split('/').any(|segment| segment.contains(':'));
        let holds = joins
            && holds_journal_days(at.root, to.folder, current.exclude_patterns.clone())
                .map_err(SettingsError::JournalUnlisted)?;
        if !holds {
            return Err(SettingsError::InvalidJournalFolder);
        }
    }
    let unrecorded = |error: &dyn std::fmt::Display| SettingsError::Unrecorded(error.to_string());
    let writer = at
        .vault
        .notes_writer(at.tier.store())
        .map_err(|error| unrecorded(&error))?;
    let moves_wait = writer
        .pending_app_moves()
        .map_err(|error| unrecorded(&error))?;
    if !moves_wait.is_empty() {
        return Err(SettingsError::MovesWait);
    }
    let setting = |folder: &str, format: &str| JournalSetting {
        folder: folder.to_owned(),
        format: format.to_owned(),
    };
    let change = PendingJournalChange {
        from: setting(&current.journal_folder, &current.journal_date_format),
        to: setting(to.folder, to.format),
        made: missing_folders(at.root, to.folder),
    };
    writer
        .begin_journal_change(&change)
        .map_err(|error| match error {
            BeginError::Unsettled | BeginError::Unreadable(_) => SettingsError::ChangeWaits,
            other => unrecorded(&other),
        })?;
    step(ChangeStep::Recorded);
    let from = JournalPlace {
        folder: &current.journal_folder,
        format: &current.journal_date_format,
    };
    let pass = match move_journal_days_checked(at, from, to, step) {
        Ok(pass) => pass,
        Err(error) => {
            // Refused before its first move.
            forget_change(&writer, &change);
            return Err(SettingsError::JournalUnlisted(error));
        }
    };
    let left = pass.skipped + pass.failed;
    let moved = Moved {
        at,
        writer,
        change,
        pass,
    };
    if left > 0 {
        moved.put_back(step);
        return Err(SettingsError::DaysNotRenamed { left });
    }
    Ok(moved)
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

    /// No day is named while the guard lives ([`DAY_NAMES`]): the days move.
    pub(crate) fn no_day_named(&self) -> RwLockWriteGuard<'static, ()> {
        DAY_NAMES.write().unwrap_or_else(PoisonError::into_inner)
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
