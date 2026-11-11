//! The record of a journal setting change (`memry_core::domain::notes::journal_change`), and the
//! finish of one a crash cut short (#3530 13m-7b-2b).
//!
//! `settings::update_vault_settings` records a change that moves the days before its first move,
//! and forgets the record once the new setting is saved or every moved day went back
//! ([`forget_change`]). A crash in between leaves days at paths the saved setting does not read:
//! each one's next move would delete it as a day, and the delete would sync.
//! [`finish_journal_change`] puts them back. It runs before anything names a day or moves the
//! days: at the vault's open before the rows' lane, the walk and the watcher
//! (`consumer::tier`), and first in a day create, a folder move, a folder delete and a settings
//! update, for a record an open could not finish.
//!
//! When the saved setting already names the change's new place, the save landed and the record
//! goes; a day's file found elsewhere since was moved by hand after the save, and the walk takes
//! it as it takes any file moved out of the journal. Otherwise each row at its path in the new
//! place whose file is still at its path in the old one (a crash between a day's two steps) goes
//! back to its file, and each day whose row and file are at its path in the new place goes back
//! to its path in the old one, file first and row after, as a refused change's days go back. The
//! folders the change made go once empty, then the record.
//!
//! Settings that cannot be read do not say whether the save landed. The rows whose files never
//! moved still go back to them: the app leaves that state only before the save, since the save
//! comes after every move, and left to the open's walk the file would pair with no row and the
//! day would be deleted. The rest waits for readable settings, as does a day that cannot go back,
//! logged; its days stay at their new paths meanwhile, and no folder move or delete takes a
//! folder that is, holds or is inside either of the change's folders
//! ([`JournalChangeWaits::holds`]), since either would leave a day outside the journal the change
//! settles to. A note move or rename takes no day (`notes::moves` finds only notes).
//!
//! A change that waits is shown on the vault's notices ([`VaultNotice::JournalChangeWaits`]),
//! naming what holds its days (the settings file, or the file or folder at a day's old path),
//! which the user clears outside the app; the notice goes once the change settles.

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::journal_change::{JournalChangeRecorded, PendingJournalChange};

use super::journal::{Journal, exists, folders_of, remove_made};
use super::{First, JournalVault, Moved, SCOPE, move_one};
use crate::vault::config::settings::JournalFollow;
use crate::vault::config::{config_path, read_vault_config_strict};
use crate::vault::consumer::rows::{RowOwner, RowSession};
use crate::vault::consumer::{Applied, MoveKind};
use crate::vault::journal_format::{
    JournalDays, normalize_journal_date_format, normalize_journal_folder,
};
use crate::vault::notices::{ChangeHold, VaultNotice};
use crate::vault::path_key::folded_key;

/// A journal setting change whose days still wait at their new paths, in `to`, to go back to
/// `from`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct JournalChangeWaits {
    from: String,
    to: String,
}

impl JournalChangeWaits {
    /// Whether `folder` is, holds or is inside either folder of the change, in any case.
    pub(crate) fn holds(&self, folder: &str) -> bool {
        let at_or_below = |inner: &str, outer: &str| {
            let (inner, outer) = (folded_key(inner), folded_key(outer));
            inner == outer || inner.starts_with(&format!("{outer}/"))
        };
        [&self.from, &self.to]
            .into_iter()
            .any(|journal| at_or_below(journal, folder) || at_or_below(folder, journal))
    }
}

/// Forgets the record of `change`, logged when it cannot: the next open finds the setting saved
/// or the days back, and forgets it then.
pub(crate) fn forget_change(writer: &NotesWriter, change: &PendingJournalChange) {
    if let Err(error) = writer.abandon_journal_change(change) {
        tracing::warn!(
            scope = SCOPE,
            "the record of a settled journal setting change waits for the next open: {error}"
        );
    }
}

/// Why a change's days could not go back, and what holds them.
struct Waits {
    why: String,
    holds: ChangeHold,
}

impl From<String> for Waits {
    fn from(why: String) -> Self {
        let holds = ChangeHold::Unknown;
        Self { why, holds }
    }
}

/// Finishes the recorded journal setting change, if any (the module's doc). The settings'
/// update lock is `held`; no day is named meanwhile. Answers the change that still waits, which
/// the vault's notices show until it settles.
pub(crate) fn finish_journal_change(
    at: JournalVault<'_>,
    held: &JournalFollow,
) -> Option<JournalChangeWaits> {
    let notices = at.tier.identity().notices();
    let settled = || {
        let kind = VaultNotice::JournalChangeWaits {
            from: String::new(),
            to: String::new(),
            holds: ChangeHold::Unknown,
        };
        if let Some(notices) = &notices {
            notices.clear(at.root, &kind);
        }
    };
    let pending = at
        .vault
        .notes_writer(at.tier.store())
        .map_err(|error| error.to_string())
        .and_then(|writer| {
            let pending = writer
                .pending_journal_change()
                .map_err(|error| error.to_string())?;
            Ok((writer, pending))
        });
    let (writer, change) = match pending {
        // No notice to take down: one is raised only while a record waits, the record goes
        // only through `settle` (or with every day back, before any notice), and the open
        // starts with an empty board.
        Ok((_, None)) => return None,
        Ok((writer, Some(JournalChangeRecorded::Change(change)))) => (writer, change),
        Ok((_, Some(JournalChangeRecorded::Unreadable(why)))) => {
            tracing::warn!(
                scope = SCOPE,
                "another version of the app recorded a journal setting change this one cannot \
                 finish: {why}"
            );
            return None;
        }
        Err(error) => {
            tracing::error!(
                scope = SCOPE,
                "the record of a journal setting change is unread: {error}"
            );
            return None;
        }
    };
    let _no_day_named = held.no_day_named();
    match settle(at, &writer, &change) {
        Ok(done) => {
            tracing::info!(scope = SCOPE, "{done}");
            settled();
            None
        }
        Err(Waits { why, holds }) => {
            tracing::warn!(
                scope = SCOPE,
                "a journal setting change a crash cut short waits for the next open: {why}"
            );
            let (from, to) = (change.from.folder, change.to.folder);
            if let Some(notices) = &notices {
                let notice = VaultNotice::JournalChangeWaits {
                    from: from.clone(),
                    to: to.clone(),
                    holds,
                };
                notices.raise(at.root, notice);
            }
            Some(JournalChangeWaits { from, to })
        }
    }
}

fn settle(
    at: JournalVault<'_>,
    writer: &NotesWriter,
    change: &PendingJournalChange,
) -> Result<&'static str, Waits> {
    let config = match read_vault_config_strict(at.root) {
        Ok(config) => config,
        Err(why) => {
            let (left, _) = put_days_back(at, writer, change, Back::RowsOnly)?;
            let path = config_path(at.root).to_string_lossy().into_owned();
            return Err(Waits {
                why: format!(
                    "the settings cannot be read ({left} journal days could not go back): {why}"
                ),
                holds: ChangeHold::Settings { path },
            });
        }
    };
    let saved = (
        normalize_journal_folder(&config.journal_folder),
        normalize_journal_date_format(&config.journal_date_format),
    );
    let forget = |done| {
        writer
            .abandon_journal_change(change)
            .map(|_| done)
            .map_err(|error| Waits::from(error.to_string()))
    };
    if saved == (change.to.folder.clone(), change.to.format.clone()) {
        return forget("forgot the record of a journal setting change that was saved");
    }
    let (left, taken) = put_days_back(at, writer, change, Back::All)?;
    if left > 0 {
        let why = format!("{left} journal days could not go back");
        let holds = taken.map_or(ChangeHold::Unknown, |path| ChangeHold::Taken { path });
        return Err(Waits { why, holds });
    }
    remove_made(at, &change.made);
    forget("put back the days of a journal setting change a crash cut short")
}

/// What [`put_days_back`] takes back.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Back {
    /// Only the rows that moved without their files, which needs no setting (the module's doc).
    RowsOnly,
    /// Those, and each day whose file moved with its row.
    All,
}

/// Moves each row the change moved without its file (a note's, too: a format change renames
/// every file its old format reads) back to that file, and with [`Back::All`] each day the
/// change moved back to its path in the old place. A note whose file is at the new place stays:
/// renamed by the change or there before it, it is a note under either setting. Answers how many
/// could not go back, each logged, and the first old place a file or folder holds, absolute.
fn put_days_back(
    at: JournalVault<'_>,
    writer: &NotesWriter,
    change: &PendingJournalChange,
    back_what: Back,
) -> Result<(usize, Option<String>), String> {
    let failed = |error: &dyn std::fmt::Display| error.to_string();
    let to = JournalDays::new(&change.to.folder, &change.to.format);
    let from = JournalDays::new(&change.from.folder, &change.from.format);
    let (Some(out_of), Some(into)) = (
        Journal::of(at.root, to.folder().to_owned()),
        Journal::of(at.root, from.folder().to_owned()),
    ) else {
        return Err("a journal folder leads out of the vault".to_owned());
    };
    let rows = at.tier.rows();
    let session = rows.session_for(at.vault).map_err(|e| failed(&e))?;
    let listed = rows
        .lane_of(session)
        .map_err(|e| failed(&e))?
        .files()
        .list_paths()
        .map_err(|e| failed(&e))?;
    let (mut left, mut taken) = (0, None);
    for (note_id, path) in listed {
        let Some(date) = to.day_of(&path) else {
            continue;
        };
        let Some(back) = from.path_of(&date).filter(|back| *back != path) else {
            continue;
        };
        let places = (below(&out_of, &path), below(&into, &back));
        let file_goes = on_disk(&out_of, places.0);
        let went = if file_goes {
            if back_what == Back::RowsOnly {
                continue;
            }
            let day = writer.journal_date(&note_id).map_err(|e| failed(&e))?;
            if day.as_deref() != Some(&*date) {
                continue;
            }
            back_one(at, (&rows, session), (&out_of, &into), places)
        } else if on_disk(&into, places.1) {
            row_back(&rows, session, &note_id, (&path, &back))
        } else {
            // Gone from both: the walk reports what is there.
            continue;
        };
        if let Err(error) = went {
            left += 1;
            // The day's file could not go back where something else is.
            if taken.is_none() && file_goes && on_disk(&into, places.1) {
                taken = into
                    .path(places.1)
                    .map(|at| at.to_string_lossy().into_owned());
            }
            tracing::error!(
                scope = SCOPE,
                note_id,
                "a journal day could not go back: {error}"
            );
        }
    }
    Ok((left, taken))
}

fn on_disk(journal: &Journal, rel: &str) -> bool {
    journal.path(rel).is_some_and(|path| exists(&path))
}

/// `path` relative to the journal folder it is in.
fn below<'p>(journal: &Journal, path: &'p str) -> &'p str {
    path.strip_prefix(&journal.folder)
        .and_then(|rest| rest.strip_prefix('/'))
        .unwrap_or(path)
}

/// Moves one day back, its file at `from` in `out_of` and its row with it, to `to` in `into`.
fn back_one(
    at: JournalVault<'_>,
    (rows, session): (&RowOwner, RowSession),
    (out_of, into): (&Journal, &Journal),
    (from, to): (&str, &str),
) -> Result<(), String> {
    let moved = move_one(
        at,
        (rows, session),
        (out_of, into),
        (from, to),
        (First::File, &mut || {}),
    )
    .map_err(|error| error.to_string())?;
    match moved {
        Moved::Done => {
            out_of.remove_empty(&at.tier.echo(), folders_of(from));
            Ok(())
        }
        Moved::TargetTaken => Err("its old path is taken".to_owned()),
    }
}

/// Moves a row back to `new_path`, where its file still is.
fn row_back(
    rows: &RowOwner,
    session: RowSession,
    note_id: &str,
    (old_path, new_path): (&str, &str),
) -> Result<(), String> {
    let mut lane = rows.lane_of(session).map_err(|error| error.to_string())?;
    lane.rename(note_id, new_path)
        .map_err(|error| error.to_string())?;
    lane.publish(Applied::Renamed {
        note_id: note_id.to_owned(),
        old_path: old_path.to_owned(),
        new_path: new_path.to_owned(),
        kind: MoveKind::JournalFormat,
    });
    Ok(())
}
