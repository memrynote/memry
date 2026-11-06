//! The record of a journal setting change (`memry_core::domain::notes::journal_change`), and the
//! finish of one a crash cut short (#3530 13m-7b-2b).
//!
//! `settings::update_vault_settings` records a change that moves the days before its first move,
//! and forgets the record once the new setting is saved or every moved day went back
//! ([`forget_change`]). A crash in between leaves days at paths the saved setting does not read:
//! each one's next move would delete it as a day, and the delete would sync.
//! [`finish_journal_change`] puts them back. It runs before anything names a day or moves the
//! days: at the vault's open before the rows' lane, the walk and the watcher
//! (`consumer::tier`), and first in a day create, a folder move and a settings update, for a
//! record an open could not finish.
//!
//! First, before the settings are read, a row at its path in the new place whose file is still at
//! its path in the old one (a crash between a day's two steps) goes back to its file. That state
//! exists only before the save, since the save comes after every move, so it needs no setting;
//! left to an open that cannot read the settings, its walk would pair the file with no row and
//! delete the day. Then, when the saved setting already names the change's new place, the save
//! landed and the record goes. Otherwise each day whose row and file are at its path in the new
//! place goes back to its path in the old one, file first and row after, as a refused change's
//! days go back. The folders the change made go once empty, then the record. Settings that
//! cannot be read, or a day that cannot go back, leave the record for the next try, logged; its
//! days stay at their new paths meanwhile, and no folder move or delete takes a folder that is,
//! holds or is inside either of the change's folders ([`JournalChangeWaits::holds`]), since
//! either would leave a day outside the journal the change settles to.

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::journal_change::{JournalChangeRecorded, PendingJournalChange};

use super::journal::{Journal, exists, folders_of, remove_made};
use super::{First, JournalVault, Moved, SCOPE, move_one};
use crate::vault::config::read_vault_config_strict;
use crate::vault::config::settings::JournalFollow;
use crate::vault::consumer::rows::{RowOwner, RowSession};
use crate::vault::consumer::{Applied, MoveKind};
use crate::vault::journal_format::{
    JournalDays, normalize_journal_date_format, normalize_journal_folder,
};
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

/// Finishes the recorded journal setting change, if any (the module's doc). The settings'
/// update lock is `held`; no day is named meanwhile. Answers the change that still waits.
pub(crate) fn finish_journal_change(
    at: JournalVault<'_>,
    held: &JournalFollow,
) -> Option<JournalChangeWaits> {
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
            None
        }
        // TODO(#3531 Step 14): tell the user, in one notice with the vault open's other
        // unsettled state: the journal days of an unfinished setting change wait.
        Err(why) => {
            tracing::warn!(
                scope = SCOPE,
                "a journal setting change a crash cut short waits for the next open: {why}"
            );
            Some(JournalChangeWaits {
                from: change.from.folder,
                to: change.to.folder,
            })
        }
    }
}

fn settle(
    at: JournalVault<'_>,
    writer: &NotesWriter,
    change: &PendingJournalChange,
) -> Result<&'static str, String> {
    let rows_left = put_days_back(at, writer, change, Back::RowsOnly)?;
    let config = read_vault_config_strict(at.root)
        .map_err(|why| format!("the settings cannot be read: {why}"))?;
    if rows_left > 0 {
        return Err(format!("{rows_left} journal days could not go back"));
    }
    let saved = (
        normalize_journal_folder(&config.journal_folder),
        normalize_journal_date_format(&config.journal_date_format),
    );
    let forget = |done| {
        writer
            .abandon_journal_change(change)
            .map(|_| done)
            .map_err(|error| error.to_string())
    };
    if saved == (change.to.folder.clone(), change.to.format.clone()) {
        return forget("forgot the record of a journal setting change that was saved");
    }
    let left = put_days_back(at, writer, change, Back::All)?;
    if left > 0 {
        return Err(format!("{left} journal days could not go back"));
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
/// could not go back, each logged.
fn put_days_back(
    at: JournalVault<'_>,
    writer: &NotesWriter,
    change: &PendingJournalChange,
    back_what: Back,
) -> Result<usize, String> {
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
    let mut left = 0;
    for (note_id, path) in listed {
        let Some(date) = to.day_of(&path) else {
            continue;
        };
        let Some(back) = from.path_of(&date).filter(|back| *back != path) else {
            continue;
        };
        let places = (below(&out_of, &path), below(&into, &back));
        let went = if on_disk(&out_of, places.0) {
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
            tracing::error!(
                scope = SCOPE,
                note_id,
                "a journal day could not go back: {error}"
            );
        }
    }
    Ok(left)
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
