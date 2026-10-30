//! Renames the journal files when the journal date format changes, after
//! `apps/desktop/src/main/vault/journal-format-migration.ts`.
//!
//! A format may carry folders (`YYYY/MMMM/YYYY-MM-DD`), so a rename can move a file between
//! folders of the journal folder: `2025-01-14.md` becomes `2025/January/2025-01-14.md` and back.
//! Target folders are created on demand; folders a move leaves empty are removed, never the
//! journal folder and never one that still holds anything.
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
//! that appeared there since ([`rename_no_replace`]). A format that cannot name every date
//! renames nothing.
//!
//! Each file and its row move as one step under the rows' lane, the file first: when the row
//! cannot move, the file goes back. The consumer and the write-back take the same lane, so they
//! see the file and its row at the old path or both at the new one. A crash between the two
//! leaves the file at the new path and the row at the old, which the next open's rescan pairs
//! as a move of that note. Electron stops its watcher for the pass because its watcher reads a
//! path with the config of the moment; the caller here may pause it too, and the rows already
//! name each new path before the watcher reports it. The refusal when a lock covers a file is
//! Step 14's (#3531).

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use memry_core::api::vault::Vault;

use super::consumer::Applied;
use super::consumer::rows::{RowError, RowOwner, RowSession};
use super::fs_atomic::{RETRY_DELAYS_MS, rename_no_replace, with_transient_retry};
use super::journal_format::{JournalDate, JournalFormat, normalize_journal_folder};
use super::paths::safe_join;
use crate::shell::file_open::file_identity;
use crate::web::extract::utils::js;

const SCOPE: &str = "journal_rename";

/// One file to move, relative to the journal folder with `/` separators.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalRename {
    pub from: String,
    pub to: String,
    pub date: JournalDate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    TargetExists,
    Unrepresentable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalRenameSkip {
    pub file: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JournalRenamePlan {
    pub renames: Vec<JournalRename>,
    pub skipped: Vec<JournalRenameSkip>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JournalRenameResult {
    /// The renames that landed, file and row both; [`revert_journal_renames`] takes them back.
    pub moved: Vec<JournalRename>,
    pub skipped: usize,
    pub failed: usize,
}

/// The open vault a pass works in: its folder, its core and the rows' lane.
#[derive(Clone, Copy)]
pub struct JournalVault<'a> {
    pub root: &'a Path,
    pub vault: &'a Arc<Vault>,
    pub rows: &'a RowOwner,
}

/// Two-digit month and day, distinct from each other and across both dates, so a format
/// missing the year, the month or the day cannot name them both.
const PROBE_DATES: [&str; 2] = ["2026-11-28", "2031-12-31"];

/// True when every date renders to a name that parses back to the same date.
pub fn is_complete_journal_format(format: &str) -> bool {
    let format = JournalFormat::new(format);
    PROBE_DATES.iter().all(|iso| {
        let date = JournalDate::from_iso(iso).expect("a probe date");
        format.parse(&format.render(date)) == Some(date)
    })
}

/// The renames of the files of the journal folder (`/`-separated paths relative to it) from
/// `old_format` to `new_format`. Names are compared case-insensitively: on the default macOS
/// and Windows volumes two names differing only in case are one file.
pub fn plan_journal_renames(
    files: &[String],
    old_format: &str,
    new_format: &str,
) -> JournalRenamePlan {
    let (old, new) = (
        JournalFormat::new(old_format),
        JournalFormat::new(new_format),
    );
    let present: HashSet<String> = files.iter().map(|name| js::to_lower(name)).collect();
    let mut claimed = HashSet::new();
    let mut plan = JournalRenamePlan::default();
    // Electron sorts by UTF-16 units. Two names of one format differ only where their
    // tokens' ASCII is, where byte order is the same.
    let mut sorted: Vec<&String> = files.iter().collect();
    sorted.sort();
    for name in sorted {
        let Some(stem) = name.strip_suffix(".md") else {
            continue;
        };
        let Some(date) = old.parse(stem) else {
            continue;
        };
        let stem = new.render(date);
        let target = format!("{stem}.md");
        if target == *name {
            continue;
        }
        let skip = |reason| JournalRenameSkip {
            file: name.clone(),
            reason,
        };
        if new.parse(&stem) != Some(date) {
            plan.skipped.push(skip(SkipReason::Unrepresentable));
            continue;
        }
        let key = js::to_lower(&target);
        let case_only = key == js::to_lower(name);
        if (present.contains(&key) && !case_only) || claimed.contains(&key) {
            plan.skipped.push(skip(SkipReason::TargetExists));
            continue;
        }
        claimed.insert(key);
        plan.renames.push(JournalRename {
            from: name.clone(),
            to: target,
            date,
        });
    }
    plan
}

/// Renames the journal files of `journal_folder` from `old_format` to `new_format`. An error
/// only when the journal folder could not be listed; a file that could not move is counted in
/// `failed` and the pass goes on.
pub fn rename_journals_for_format_change(
    at: JournalVault<'_>,
    journal_folder: &str,
    old_format: &str,
    new_format: &str,
) -> io::Result<JournalRenameResult> {
    let mut result = JournalRenameResult::default();
    let folder = normalize_journal_folder(journal_folder);
    if folder.is_empty() {
        return Ok(result);
    }
    if !is_complete_journal_format(new_format) {
        tracing::warn!(
            scope = SCOPE,
            "the new journal date format cannot name every date; files left as they are"
        );
        return Ok(result);
    }
    let Some(dir) = journal_dir(at.root, &folder) else {
        return Ok(result);
    };
    let Some(files) = list_files(&dir)? else {
        return Ok(result);
    };
    let plan = plan_journal_renames(&files, old_format, new_format);
    result.skipped = plan.skipped.len();
    if plan.renames.is_empty() {
        log_skipped(&plan.skipped);
        return Ok(result);
    }
    let session = match at.rows.session_for(at.vault) {
        Ok(session) => session,
        Err(error) => {
            tracing::error!(scope = SCOPE, "no journal file renamed: {error}");
            result.failed = plan.renames.len();
            return Ok(result);
        }
    };
    let mut skipped = plan.skipped;
    for rename in plan.renames {
        let (from_rel, to_rel) = (
            format!("{folder}/{}", rename.from),
            format!("{folder}/{}", rename.to),
        );
        match move_one(
            at,
            session,
            &dir,
            (&rename.from, &rename.to),
            (&from_rel, &to_rel),
        ) {
            Ok(Moved::Done) => {
                prune_empty_parents(&dir, &rename.from);
                result.moved.push(rename);
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
        "journal files renamed for the new date format"
    );
    log_skipped(&skipped);
    Ok(result)
}

/// Takes back the renames of a format change whose new format was not saved, newest first,
/// file then row as the forward pass moved them, so every journal file matches the format it
/// is read with again. A file that cannot go back is logged and left where it is.
pub fn revert_journal_renames(at: JournalVault<'_>, journal_folder: &str, moved: &[JournalRename]) {
    let folder = normalize_journal_folder(journal_folder);
    if folder.is_empty() || moved.is_empty() {
        return;
    }
    let Some(dir) = journal_dir(at.root, &folder) else {
        return;
    };
    let session = match at.rows.session_for(at.vault) {
        Ok(session) => session,
        Err(error) => {
            return tracing::error!(scope = SCOPE, "no journal file moved back: {error}");
        }
    };
    for rename in moved.iter().rev() {
        let (from_rel, to_rel) = (
            format!("{folder}/{}", rename.from),
            format!("{folder}/{}", rename.to),
        );
        match move_one(
            at,
            session,
            &dir,
            (&rename.to, &rename.from),
            (&to_rel, &from_rel),
        ) {
            Ok(Moved::Done) => prune_empty_parents(&dir, &rename.to),
            Ok(Moved::TargetTaken) => tracing::error!(
                scope = SCOPE,
                "a journal file could not move back: its old name is taken"
            ),
            Err(error) => {
                tracing::error!(scope = SCOPE, "a journal file could not move back: {error}");
            }
        }
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
    #[error("the file did not move: {0}")]
    File(io::Error),
    /// The file moved and its row did not; the file went back.
    #[error("its row did not move, so the file went back: {0}")]
    Row(RowError),
}

/// Moves one file and its row under the lane. `names` are relative to the journal folder
/// `dir`, `paths` to the vault.
fn move_one(
    at: JournalVault<'_>,
    session: RowSession,
    dir: &Path,
    (from, to): (&str, &str),
    (from_path, to_path): (&str, &str),
) -> Result<Moved, MoveError> {
    let mut lane = at.rows.lane_of(session)?;
    let row = lane.row_at(from_path).map_err(RowError::from)?;
    let target_free = match &row {
        Some(row) => lane.check(&row.note_id, to_path),
        None => lane.check_free(to_path),
    };
    if target_free.is_err() {
        return Ok(Moved::TargetTaken);
    }
    let (source, target) = (join(dir, from), join(dir, to));
    match move_file(&source, &target) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Ok(Moved::TargetTaken);
        }
        Err(error) => return Err(MoveError::File(error)),
    }
    if let Some(row) = row {
        if let Err(error) = lane.rename(&row.note_id, to_path) {
            // File and row must agree, or the next open takes the moved file for a new note
            // and strands the row. A file that cannot go back is paired by that open's rescan.
            if let Err(back) = move_file(&target, &source) {
                tracing::error!(scope = SCOPE, "a journal file could not go back: {back}");
            }
            return Err(MoveError::Row(error));
        }
        lane.publish(Applied::Renamed {
            note_id: row.note_id,
            old_path: from_path.to_owned(),
            new_path: to_path.to_owned(),
        });
    }
    // The manual order is a convenience: a slot that did not follow is not worth the move.
    if let Err(error) = at.vault.note_positions().carry(from_path, to_path) {
        tracing::warn!(
            scope = SCOPE,
            "a journal's order slot did not follow it: {error}"
        );
    }
    Ok(Moved::Done)
}

/// Moves `source` to `target` without replacing anything, creating the target's folders. A
/// name that differs only in case from the source's, on a volume that folds case, names the
/// source itself, and that respelling is a plain rename.
fn move_file(source: &Path, target: &Path) -> io::Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    match with_transient_retry(&delays, || rename_no_replace(source, target)) {
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists && same_file(source, target) => {
            with_transient_retry(&delays, || fs::rename(source, target))
        }
        other => other,
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    let id = |path: &Path| fs::File::open(path).and_then(|file| file_identity(&file));
    matches!((id(a), id(b)), (Ok((a, _)), Ok((b, _))) if a == b)
}

/// Every file under `dir` as a `/`-separated path relative to it; dot entries (`.obsidian`,
/// editor temp files) and links are skipped, names that are not UTF-8 too, since no format
/// renders one. `None` when `dir` is missing.
fn list_files(dir: &Path) -> io::Result<Option<Vec<String>>> {
    let mut files = Vec::new();
    let mut folders = vec![String::new()];
    while let Some(relative) = folders.pop() {
        let entries = match fs::read_dir(join(dir, &relative)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound && relative.is_empty() => {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let path = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let kind = entry.file_type()?;
            if kind.is_dir() {
                folders.push(path);
            } else if kind.is_file() {
                files.push(path);
            }
        }
    }
    Ok(Some(files))
}

/// Removes the folders between `relative` and the journal folder that are empty now, from the
/// deepest up; the first that holds anything ends it.
fn prune_empty_parents(dir: &Path, relative: &str) {
    let mut parent = relative;
    while let Some((up, _)) = parent.rsplit_once('/') {
        // `remove_dir` refuses a folder that is not empty, which is the guard wanted here.
        if fs::remove_dir(join(dir, up)).is_err() {
            return;
        }
        parent = up;
    }
}

/// The journal folder in the vault; `None`, and a warning, for one that leads out of it.
fn journal_dir(root: &Path, folder: &str) -> Option<PathBuf> {
    let dir = safe_join(root, &[folder]);
    if dir.is_none() {
        tracing::warn!(
            scope = SCOPE,
            "the journal folder is outside the vault; nothing renamed"
        );
    }
    dir
}

/// `dir` joined with a `/`-separated relative path of names a listing returned.
fn join(dir: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .filter(|segment| !segment.is_empty())
        .fold(dir.to_path_buf(), |path, segment| path.join(segment))
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
