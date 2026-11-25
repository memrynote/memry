//! A live journal day's file at its date's path (#5786).
//!
//! Invariant: a live day owns its file, which stands at the day's path under the vault's date
//! format. The core reads an id a live day holds as the day, never as the `notes` row a peer's
//! same-id `note` record keeps beside it (`memry_core::domain::note_files::unfiled`'s
//! invariant): such a row neither names nor patches the day's file, nor sends it to the trash.
//! This module is the desktop half: the one place a pass moves a day's file.
//!
//! The order it mends: a peer's `note j<date>` record (Electron names a day's pictures that
//! way, #5731) pulled before the day's journal record gets its first file as a note's,
//! `journal/2026-11-04.md`. Once the day is live here, under a format such as `DD-MM-YYYY` that
//! is no day's path, and nothing else ever moves it. The day's next pass moves the file to
//! `journal/04-11-2026.md`, as Electron's journal write-back always writes a day at
//! `getJournalPath(date)` (`sync/crdt-writeback.ts`, `writebackJournal`).
//!
//! As the journal format revert of `vault::journal_rename`, the file moves first and its row
//! after: a crash in between leaves the file at a name the saved format reads as its date,
//! which the next open's rescan pairs with the row as the day's move. Moved the other way, the
//! file would sit at a name that is no day while the row named the day's, and the rescan could
//! take the day for a note that left the journal. A day held by a pending journal change, a
//! day owed a move, settings that do not read, a lock, and a taken path keep the file where it
//! is: the pass still writes the day's body there, and tries again on its next pass.

use memry_core::domain::note_files::NoteFile;

use super::Pass;
use crate::journal::day_path_in;
use crate::locks::Locks;
use crate::shell::file_open::Resolution;
use crate::vault::config::read_vault_config_strict;
use crate::vault::consumer::rows::Lane;
use crate::vault::consumer::{Applied, MoveKind};
use crate::vault::file_move::FileMove;
use crate::vault::paths::resolve_vault_file;
use crate::web::extract::utils::js;

const SCOPE: &str = "vault_writeback";

impl Pass {
    /// Moves the file of `row`, when its id is a live day's and the file is not at the day's
    /// path, to that path; the new path, `None` when the file stays.
    pub(super) fn place_day(&self, lane: &mut Lane<'_>, row: &NoteFile) -> Option<String> {
        let note_id = row.note_id.as_str();
        // `None` for a note, a deleted day, and a day owed a move of its file.
        let date = match self.vault.write_back().file_date(note_id) {
            Ok(Some(date)) => date,
            Ok(None) => return None,
            Err(error) => return kept(note_id, format!("the day's date: {error}")),
        };
        match self.vault.note_files().days_wait() {
            Ok(false) => {}
            Ok(true) => return None,
            Err(error) => return kept(note_id, format!("the held days: {error}")),
        }
        let root = self.root.as_path();
        let Ok(config) = read_vault_config_strict(root) else {
            return kept(note_id, "the vault's settings cannot be read");
        };
        let new = match day_path_in(&config, &date) {
            Ok(new) if new == row.path => return None,
            Ok(new) => new,
            Err(error) => return kept(note_id, format!("the day's path: {error}")),
        };
        let (source, target) = (root.join(&row.path), root.join(&new));
        if lane.check(note_id, &new).is_err() || target.symlink_metadata().is_ok() {
            return kept(note_id, "the day's path is taken");
        }
        match resolve_vault_file(root, &new) {
            Ok(Resolution::Outside) => {
                return kept(note_id, "the day's path leads out of the vault");
            }
            Ok(_) => {}
            Err(error) => return kept(note_id, format!("the day's path: {error}")),
        }
        let locks = Locks::new(root, &self.vault);
        let locked = locks.refuse_note(note_id, &row.path).is_err()
            || locks.is_path_locked(&new).unwrap_or(true);
        if locked {
            return kept(note_id, "a lock covers the day's file or its path");
        }
        let case_only = js::to_lower(&row.path) == js::to_lower(&new);
        let forward = FileMove {
            source: &source,
            target: &target,
            source_rel: &row.path,
            case_only,
        };
        // The bytes at the new name are the app's: the watcher never takes them for a new note.
        if let Some(hash) = &row.file_hash {
            self.echo.will_write(&new, hash);
        }
        if let Err(error) = forward.run(&self.echo) {
            self.echo.cancel_write(&new);
            return kept(note_id, format!("the file did not move: {error}"));
        }
        if let Err(error) = lane.rename(note_id, &new) {
            let back = FileMove {
                source: &target,
                target: &source,
                source_rel: &new,
                case_only,
            };
            if let Err(back) = back.run(&self.echo) {
                // The file stays at the day's name and the row at the old: the next open's
                // rescan pairs the two as the day's move.
                tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "a day's file could not go back: {back}"
                );
            }
            self.echo.cancel_removal(&row.path);
            return kept(note_id, format!("the row did not follow the file: {error}"));
        }
        // The manual order is a convenience: a slot that did not follow is not worth the move.
        if let Err(error) = self.vault.note_positions().carry(&row.path, &new) {
            tracing::warn!(
                scope = SCOPE,
                note_id,
                "a day's order slot did not follow it: {error}"
            );
        }
        tracing::info!(
            scope = SCOPE,
            note_id,
            "a live day's file moved to its date's path"
        );
        lane.publish(Applied::Renamed {
            note_id: note_id.to_owned(),
            old_path: row.path.clone(),
            new_path: new.clone(),
            kind: MoveKind::JournalFormat,
        });
        Some(new)
    }
}

/// A day's file the pass leaves where it is, for this reason; its next pass tries again.
fn kept(note_id: &str, why: impl std::fmt::Display) -> Option<String> {
    tracing::warn!(
        scope = SCOPE,
        note_id,
        "a day's file stays off its date's path: {why}"
    );
    None
}
