//! Renames the journal files when the journal date format changes, after
//! `apps/desktop/src/main/vault/journal-format-migration.ts`, and moves them into the new
//! folder when the journal folder changes (`settings`; Electron moves nothing then). A folder
//! change moves only the days, the files the old format reads as dates whose rows are journal
//! days: a note at a day's path (a note titled with a date) and a file no row names yet stay
//! where they are, notes under the new folder. It takes the new folder's files for taken names;
//! the rest of what follows holds for both, with "name" read as the path in the new folder.
//!
//! A format may carry folders (`YYYY/MMMM/YYYY-MM-DD`), so a rename can move a file between
//! folders of the journal folder: `2025-01-14.md` becomes `2025/January/2025-01-14.md` and back.
//! Target folders are created on demand; folders a move leaves empty are removed, never the
//! journal folder and never one that still holds anything, and so are the folders a move that
//! failed had created.
//!
//! Both formats are taken in the canonical form the config holds and every reader parses with
//! ([`normalize_journal_date_format`]): no `.` or `..` folder, a backslash read as `/`. A new
//! name that would still land outside the vault, through a linked folder or a drive (`C:`), is
//! not moved.
//!
//! A file is a journal only while its name matches the configured format: switching
//! `YYYY-MM-DD` to `YYYY-MM-DD dddd` without renaming would leave `2026-09-25.md` behind as a
//! plain note, and the day's next entry would be a second file.
//!
//! Only the name changes. A journal's identity is its date: its note id and document stay, so
//! the file's `note_files` row moves with it and keeps its note, and the day's manual order
//! slot is carried. The record is not touched.
//!
//! Never overwrites. A target already on disk (under any case), held by a row, or claimed by
//! another file of the same pass leaves the source as it is, and the move itself refuses a file
//! that appeared there since ([`super::fs_atomic::rename_no_replace`]). A new name that differs
//! from the file's only in case is a respelling in place only when it names that very file, and
//! no link to it (a symbolic link, or a second hard link a rename would leave behind). A format
//! that cannot name every date renames nothing.
//!
//! Each file and its row move as one step under the rows' lane. The consumer and the write-back
//! take the same lane, so they see the file and its row at the old path or both at the new one.
//! The lane is held for one rename and its retries on a transient error ([`FileMove::run`]),
//! and for a second one when the first step is taken back.
//!
//! The order keeps a day a day through a crash. The config names the old format until the pass
//! is done, and the next open's rescan pairs a file and a row that disagree as a move to where
//! the file is: a day only while that name is one the saved format reads as its date. So a
//! file never sits at its new name while its row is at the old. The pass moves the row first
//! and the file after, the row put back when a try of the file's move fails, so the row names
//! the new path only while a try runs ([`FileMove::run_each`]); the revert of a format that
//! was not saved moves the file first, back to its old name, and the row after, the file sent
//! forward again when the row cannot move. Moved the other way, a crash would leave the file
//! at a name the old format does not read, and the next open would take the day for a note
//! that moved out of the journal: its record deleted, the delete synced.
//!
//! The watcher keeps running, and a move the app makes is never a delete to it. Before each try
//! of a move the pass tells the own-write record that the old name goes
//! ([`EchoGuard::will_remove`]): the watcher drops that name without tracking a delete, and
//! finds the file at its new name as its row names it. Left to pair the two itself, the watcher
//! could not tell apart journals with the same bytes whose new names are not their old ones;
//! each would settle as a delete, and the note with it. The same holds for each folder the pass
//! removes, whose going would otherwise stand for the notes the watcher last saw in it. A try
//! that fails withdraws its record before the next, so a delete by another program while the
//! move waits is still reported. A record ends when the watcher sees its path, or a path below
//! it, again. Electron stops its watcher for the pass instead. The refusal when a lock covers a file
//! is Step 14's (#3531).

use std::fs;
use std::io;
use std::path::Path;
use std::sync::Arc;

use memry_core::api::notes_write::NotesWriter;
use memry_core::api::vault::Vault;

use super::consumer::rows::{RowError, RowOwner, RowSession};
use super::consumer::{Applied, MoveKind, VaultTier};
use super::file_move::FileMove;
use super::journal_format::{normalize_journal_date_format, normalize_journal_folder};
use super::paths::resolve_vault_file;
use crate::locks::{Locks, Refused};
use crate::shell::file_open::Resolution;
use crate::web::extract::utils::js;

mod change;
mod journal;
mod plan;

pub(crate) use change::{finish_journal_change, forget_change};
pub(crate) use journal::missing_folders;
use journal::{Journal, exists, folders_of, list_files, remove_made};

pub use plan::{
    JournalRename, JournalRenamePlan, JournalRenameSkip, SkipReason, is_complete_journal_format,
    plan_journal_moves, plan_journal_renames,
};

const SCOPE: &str = "journal_rename";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JournalRenameResult {
    /// The renames that landed, file and row both; [`revert_journal_moves`] takes them back.
    pub moved: Vec<JournalRename>,
    pub skipped: usize,
    pub failed: usize,
    /// The folders the pass made for a new journal folder, deepest first, which go again with
    /// the days when the move is taken back.
    pub made: Vec<String>,
}

/// The open vault a pass works in: its folder, its core, and the tier whose rows' lane and
/// own-write record the moves go through.
#[derive(Clone, Copy)]
pub struct JournalVault<'a> {
    pub root: &'a Path,
    pub vault: &'a Arc<Vault>,
    pub tier: &'a VaultTier,
}

/// Where a journal setting change stands, for a test to stop it there as a crash would
/// (`settings::update_vault_settings_checked`).
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeStep {
    /// The change is recorded, before the first day moves.
    Recorded,
    /// Between a day's two steps: its row moved and its file not yet, or on the way back its
    /// file moved and its row not yet.
    Between,
    /// A day moved, or moved back, file and row both.
    Moved,
    /// The new setting is saved, before its record is forgotten.
    Saved,
}

/// Why no day moved.
#[derive(Debug, thiserror::Error)]
pub enum RenameError {
    /// A journal folder could not be listed, or leads out of the vault.
    #[error("the journal folder could not be listed: {0}")]
    Unlisted(#[from] io::Error),
    /// A lock covers a day the pass would move, or the path it would take: nothing moved, as
    /// Electron's format change refuses (`journal-format-migration.ts`, `noteLockedError`). A
    /// locked day keeps its name, and a partial pass would split the journal in two.
    #[error("{}", Refused::Note.message())]
    Locked,
}

/// A journal's days: its vault-relative folder and its date format.
#[derive(Debug, Clone, Copy)]
pub struct JournalPlace<'a> {
    pub folder: &'a str,
    pub format: &'a str,
}

/// Moves the journal days of `from` to their names in `to`, both taken in their canonical
/// form: a date format change renames them in their folder, a journal folder change moves them
/// into the new one (`settings::update_vault_settings`). An error only when a journal folder
/// could not be listed; a file that could not move is counted in `failed` and the pass goes on.
pub fn move_journal_days(
    at: JournalVault<'_>,
    from: JournalPlace<'_>,
    to: JournalPlace<'_>,
) -> Result<JournalRenameResult, RenameError> {
    move_journal_days_checked(at, from, to, &mut |_| {})
}

/// [`move_journal_days`] with a hook at each [`ChangeStep`] of each move, where a crash would
/// stop it, so a test can see what a crash there leaves.
#[doc(hidden)]
pub fn move_journal_days_checked(
    at: JournalVault<'_>,
    from: JournalPlace<'_>,
    to: JournalPlace<'_>,
    step: &mut dyn FnMut(ChangeStep),
) -> Result<JournalRenameResult, RenameError> {
    let mut result = JournalRenameResult::default();
    let (source, target) = (
        normalize_journal_folder(from.folder),
        normalize_journal_folder(to.folder),
    );
    if source.is_empty() || target.is_empty() {
        return Ok(result);
    }
    let (old_format, new_format) = (
        normalize_journal_date_format(from.format),
        normalize_journal_date_format(to.format),
    );
    if !is_complete_journal_format(&new_format) {
        tracing::warn!(
            scope = SCOPE,
            "the new journal date format cannot name every date; files left as they are"
        );
        return Ok(result);
    }
    // A folder the vault cannot hold names no day the setting could save.
    let (Some(source), Some(target)) = (Journal::of(at.root, source), Journal::of(at.root, target))
    else {
        return Err(io::Error::other("a journal folder leads out of the vault").into());
    };
    let Some(files) = list_files(&source.dir)? else {
        return Ok(result);
    };
    let plan = if source.folder == target.folder {
        plan_journal_renames(&files, &old_format, &new_format)
    } else {
        result.made = target.missing(at.root);
        let present = list_files(&target.dir)?.unwrap_or_default();
        plan_journal_moves(&files, &present, &old_format, &new_format)
    };
    result.skipped = plan.skipped.len();
    if plan.renames.is_empty() {
        log_skipped(&plan.skipped);
        return Ok(result);
    }
    let locks = Locks::new(at.root, at.vault);
    for rename in &plan.renames {
        for path in [source.rel(&rename.from), target.rel(&rename.to)] {
            if locks.is_path_locked(&path).map_err(io::Error::other)? {
                return Err(RenameError::Locked);
            }
        }
    }
    let rows = at.tier.rows();
    let session = match rows.session_for(at.vault) {
        Ok(session) => session,
        Err(error) => {
            tracing::error!(scope = SCOPE, "no journal file renamed: {error}");
            result.failed = plan.renames.len();
            return Ok(result);
        }
    };
    let days_only = match source.folder != target.folder {
        true => match at.vault.notes_writer(at.tier.store()) {
            Ok(writer) => Some(writer),
            Err(error) => {
                tracing::error!(scope = SCOPE, "no journal day moved: {error}");
                result.failed = plan.renames.len();
                return Ok(result);
            }
        },
        false => None,
    };
    let mut skipped = plan.skipped;
    let mut stayed = 0;
    for rename in plan.renames {
        if let Some(writer) = &days_only {
            match is_day(&rows, session, writer, &source.rel(&rename.from)) {
                Ok(true) => {}
                Ok(false) => {
                    stayed += 1;
                    continue;
                }
                Err(error) => {
                    result.failed += 1;
                    tracing::warn!(scope = SCOPE, "a journal day was not moved: {error}");
                    continue;
                }
            }
        }
        let names = (rename.from.as_str(), rename.to.as_str());
        match move_one(
            at,
            (&rows, session),
            (&source, &target),
            names,
            (First::Row, &mut || step(ChangeStep::Between)),
        ) {
            Ok(Moved::Done) => {
                source.remove_empty(&at.tier.echo(), folders_of(&rename.from));
                result.moved.push(rename);
                step(ChangeStep::Moved);
            }
            Ok(Moved::TargetTaken) => {
                result.skipped += 1;
                skipped.push(JournalRenameSkip {
                    file: rename.from,
                    reason: SkipReason::TargetExists,
                });
            }
            Err(error) => {
                result.failed += 1;
                tracing::warn!(scope = SCOPE, "a journal file was not renamed: {error}");
            }
        }
    }
    tracing::info!(
        scope = SCOPE,
        renamed = result.moved.len(),
        skipped = result.skipped,
        failed = result.failed,
        stayed,
        "journal files moved to their names in the new journal setting"
    );
    log_skipped(&skipped);
    if result.moved.is_empty() {
        remove_made(at, &result.made);
    }
    Ok(result)
}

/// Takes back the moves of a pass from the journal folder `from` to `to` whose setting was not
/// saved, newest first, file then row (the module's doc), so every journal file matches the
/// setting it is read with again. Returns the moves that did not go back, in the order given:
/// each file is logged and left at its new name, with its row.
pub fn revert_journal_moves(
    at: JournalVault<'_>,
    folders: (&str, &str),
    pass: &JournalRenameResult,
) -> Vec<JournalRename> {
    revert_journal_moves_checked(at, folders, pass, &mut |_| {})
}

/// [`revert_journal_moves`] with a hook at each [`ChangeStep`] of each move back.
#[doc(hidden)]
pub fn revert_journal_moves_checked(
    at: JournalVault<'_>,
    (from, to): (&str, &str),
    pass: &JournalRenameResult,
    step: &mut dyn FnMut(ChangeStep),
) -> Vec<JournalRename> {
    let moved = &pass.moved;
    let (source, target) = (normalize_journal_folder(from), normalize_journal_folder(to));
    if source.is_empty() || target.is_empty() || moved.is_empty() {
        return moved.to_vec();
    }
    let (Some(source), Some(target)) = (Journal::of(at.root, source), Journal::of(at.root, target))
    else {
        return moved.to_vec();
    };
    let rows = at.tier.rows();
    let session = match rows.session_for(at.vault) {
        Ok(session) => session,
        Err(error) => {
            tracing::error!(scope = SCOPE, "no journal file moved back: {error}");
            return moved.to_vec();
        }
    };
    let mut left = Vec::new();
    for rename in moved.iter().rev() {
        let names = (rename.to.as_str(), rename.from.as_str());
        match move_one(
            at,
            (&rows, session),
            (&target, &source),
            names,
            (First::File, &mut || step(ChangeStep::Between)),
        ) {
            Ok(Moved::Done) => {
                target.remove_empty(&at.tier.echo(), folders_of(&rename.to));
                step(ChangeStep::Moved);
                continue;
            }
            Ok(Moved::TargetTaken) => tracing::error!(
                scope = SCOPE,
                "a journal file could not move back: its old name is taken"
            ),
            Err(error) => {
                tracing::error!(scope = SCOPE, "a journal file could not move back: {error}");
            }
        }
        left.push(rename.clone());
    }
    left.reverse();
    if left.is_empty() {
        remove_made(at, &pass.made);
    }
    left
}

/// Whether the file at `path` has a row whose record is a journal day.
fn is_day(
    rows: &RowOwner,
    session: RowSession,
    writer: &NotesWriter,
    path: &str,
) -> Result<bool, String> {
    let row = rows
        .lane_of(session)
        .and_then(|lane| lane.row_at(path).map_err(RowError::from))
        .map_err(|error| error.to_string())?;
    match row {
        Some(row) => Ok(writer
            .journal_date(&row.note_id)
            .map_err(|error| error.to_string())?
            .is_some()),
        None => Ok(false),
    }
}

enum Moved {
    Done,
    /// A row, or a file that appeared since the plan, holds the target.
    TargetTaken,
}

#[derive(Debug, thiserror::Error)]
enum MoveError {
    #[error("{0}")]
    Rows(#[from] RowError),
    #[error("the new name leads out of the vault")]
    Outside,
    #[error("the file did not move: {0}")]
    File(io::Error),
    /// The file moved and its row did not; the file went back.
    #[error("its row did not move, so the file went back: {0}")]
    Row(RowError),
}

/// Which of a file and its row moves first: whichever leaves the file at its name in the saved
/// format while the two disagree (the module's doc).
#[derive(Clone, Copy, PartialEq, Eq)]
enum First {
    /// The rename pass: the file stays at its old name until its row is at the new.
    Row,
    /// The revert: the file is back at its old name before its row follows.
    File,
}

/// Moves one file and its row under the lane, `first` first and `between` run after it; `from`
/// is relative to the journal folder `out_of`, `to` to `into` (the same one for a format).
fn move_one(
    at: JournalVault<'_>,
    (rows, session): (&RowOwner, RowSession),
    (out_of, into): (&Journal, &Journal),
    (from, to): (&str, &str),
    (first, between): (First, &mut dyn FnMut()),
) -> Result<Moved, MoveError> {
    let (Some(source), Some(target)) = (out_of.path(from), into.path(to)) else {
        return Err(MoveError::Outside);
    };
    let (from_path, to_path) = (out_of.rel(from), into.rel(to));
    // A name that is there is the move's to refuse; a free one must not lead out of the vault.
    if fs::symlink_metadata(&target).is_err()
        && resolve_vault_file(at.root, &to_path).map_err(MoveError::File)? == Resolution::Outside
    {
        return Err(MoveError::Outside);
    }
    let case_only = js::to_lower(&from_path) == js::to_lower(&to_path);
    let mut lane = rows.lane_of(session)?;
    let row = lane.row_at(&from_path).map_err(RowError::from)?;
    let target_free = match &row {
        Some(row) => lane.check(&row.note_id, &to_path),
        None => lane.check_free(&to_path),
    };
    if target_free.is_err() {
        return Ok(Moved::TargetTaken);
    }
    let echo = at.tier.echo();
    let created = folders_of(to)
        .take_while(|folder| into.path(folder).is_some_and(|path| !exists(&path)))
        .count();
    let forward = FileMove {
        source: &source,
        target: &target,
        source_rel: &from_path,
        case_only,
    };
    // The row names the new path only while a try runs, as the record that the old name goes
    // is up: a delete by another program while the move waits finds the note at its old path.
    let mut row_refused = None;
    let moved = match row.as_ref().filter(|_| first == First::Row) {
        Some(row) => forward.run_each(&echo, |rename| {
            if let Err(error) = lane.rename(&row.note_id, &to_path) {
                let failed = io::Error::other(error.to_string());
                row_refused = Some(error);
                return Err(failed);
            }
            between();
            rename().inspect_err(|_| {
                if let Err(back) = lane.rename(&row.note_id, &from_path) {
                    // The row stays at the new name and the file at the old, a day the next
                    // open's rescan pairs back.
                    tracing::error!(scope = SCOPE, "a journal row could not go back: {back}");
                }
            })
        }),
        None => forward.run(&echo),
    };
    if let Err(error) = moved {
        into.remove_empty(&echo, folders_of(to).take(created));
        if let Some(refused) = row_refused {
            return Err(MoveError::Rows(refused));
        }
        let error = io::Error::from(error);
        return match error.kind() {
            io::ErrorKind::AlreadyExists => Ok(Moved::TargetTaken),
            _ => Err(MoveError::File(error)),
        };
    }
    if let Some(row) = row.as_ref().filter(|_| first == First::File)
        && let Err(error) = {
            between();
            lane.rename(&row.note_id, &to_path)
        }
    {
        // File and row must agree, or the moved file is taken for a new note and the row
        // stranded.
        let back = FileMove {
            source: &target,
            target: &source,
            source_rel: &to_path,
            case_only,
        };
        match back.run(&echo) {
            Ok(()) => into.remove_empty(&echo, folders_of(to).take(created)),
            // The file stays at its new name and the row at its old. The old name's record
            // is withdrawn below: a watcher that has not looked at the old name yet sees an
            // outside move and pairs the two by the file's bytes, a rename. After tries to
            // move back that took over half a second it has usually taken the old name's
            // going for the app's and pairs nothing: the file reaches the identity as a new
            // one, and the next open's rescan finds the row's file gone. The text survives;
            // the note's id may not.
            Err(back) => {
                tracing::error!(scope = SCOPE, "a journal file could not go back: {back}");
            }
        }
        echo.cancel_removal(&from_path);
        return Err(MoveError::Row(error));
    }
    if let Some(row) = row {
        lane.publish(Applied::Renamed {
            note_id: row.note_id,
            old_path: from_path.clone(),
            new_path: to_path.clone(),
            kind: MoveKind::JournalFormat,
        });
    }
    // The manual order is a convenience: a slot that did not follow is not worth the move.
    if let Err(error) = at.vault.note_positions().carry(&from_path, &to_path) {
        tracing::warn!(
            scope = SCOPE,
            "a journal's order slot did not follow it: {error}"
        );
    }
    Ok(Moved::Done)
}

fn log_skipped(skipped: &[JournalRenameSkip]) {
    if skipped.is_empty() {
        return;
    }
    let taken = skipped
        .iter()
        .filter(|skip| skip.reason == SkipReason::TargetExists)
        .count();
    tracing::warn!(
        scope = SCOPE,
        target_exists = taken,
        unrepresentable = skipped.len() - taken,
        "journal files not renamed"
    );
}
