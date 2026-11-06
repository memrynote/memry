//! The vault open's finish of the app moves a crash cut short (Step 13g, #3530).
//!
//! A note's rename or move in the app records the move in the core
//! ([`NotesWriter::begin_app_move`]), moves the file, and then moves record, row and slot in
//! one transaction that forgets the record ([`Lane::move_by_app`]). A crash between the file
//! and the transaction leaves the file at its new path, its row at the old one, and the record.
//! [`finish_interrupted`] runs when the vault opens, before its walk and its watcher, so the
//! moved file is never taken for a new one. That serves a markdown note and a file note (PDF,
//! image) alike: a file note's row has no hash, so nothing else could pair its moved file
//! with it.
//!
//! A folder the app moved (`notes::folder_move`) records its own move beside its notes'. When
//! the folder moved on disk (`moved_on_disk`: it is at its new path, and gone from the old one
//! or every note the move carried is at its new path and gone from its old one), the open
//! finishes it as the live move would have: the notes found moved, the folder's `folder_config` records and its manual
//! order follow in one transaction ([`Lane::folder_moved_by_app`]). Otherwise it forgets the
//! folder's record, and each note's record is settled on its own.
//!
//! A folder move that carried the journal folder had its setting follow it once the folder was
//! on disk (`notes::folder_move`). A crash before that save leaves the setting at the old folder:
//! [`follow_interrupted`] saves the followed folder before the lane is taken, so the folder's
//! days finish their moves as days, and a day made later lands beside them. Each note the move
//! carried keeps its kind as the live move read it (`keeps_kind_followed`). An open that cannot
//! read the settings leaves the folder's record and its notes' for one that can; the moves its
//! walk pairs meanwhile are owed, and settle by the same rule (`settle_followed`).
//!
//! A folder the app deleted (`notes::folder_delete`) records its delete the same way. When the
//! folder is gone, the open runs the delete's transaction for the notes still listed under it;
//! when it is still there, the open forgets the record.
//!
//! [`NoteFileMove`] is the live half: it records the move and moves the file, and puts the
//! file back when the transaction fails. A file that cannot go back stays at its new path with
//! the record, and the watcher is told that both names are the app's, so the session reports
//! neither a removal nor a new note and the next open finishes the move.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::app_move::{
    AppMoved, BeginError, FolderRecorded, PendingFolderMove, PendingMove, Recorded,
};
use memry_core::domain::notes::folder_delete::FolderDeleteRecorded;
use unicode_normalization::UnicodeNormalization;

use super::config::{VaultConfig, read_vault_config_strict};
use super::consumer::identity::{IdentityCtx, NoteIdentity};
use super::consumer::rows::Lane;
use super::file_move::{FileMove, FileMoveError};
use super::journal_format::JournalDays;
use super::path_key::folded_key;
use super::watch::EchoGuard;
use crate::journal::folder_follow::followed_journal_folder;
use crate::notes::owed_moves::{keeps_kind_followed, settle_followed};
use crate::shell::file_open::is_plain_relative;

mod follow;

pub(crate) use follow::follow_interrupted;
use follow::{carries, moved_on_disk};

const SCOPE: &str = "app_move";

/// Why [`NoteFileMove::forward`] did not move the file.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MoveError {
    #[error(transparent)]
    Begin(#[from] BeginError),
    /// A folder of the new path could not be made (a file holds its name).
    #[error("the note's new folder could not be made: {0}")]
    Folder(io::Error),
    #[error(transparent)]
    Io(io::Error),
}

impl From<FileMoveError> for MoveError {
    fn from(error: FileMoveError) -> Self {
        match error {
            FileMoveError::Folder(error) => Self::Folder(error),
            FileMoveError::Move(error) => Self::Io(error),
        }
    }
}

/// One app move of a note's file, between two vault-relative paths, under the rows' lane.
pub(crate) struct NoteFileMove<'a> {
    pub echo: &'a EchoGuard,
    pub root: &'a Path,
    pub old: &'a str,
    pub new: &'a str,
    /// The hash of the bytes the file holds, as its row says (a markdown note's): its sighting
    /// at the new path is the app's own write, so the watcher never takes the moved file for a
    /// new note, the time before the row follows included.
    pub hash: Option<&'a str>,
}

impl NoteFileMove<'_> {
    /// Records the move ([`Lane::begin_move`]), then moves the file without replacing anything
    /// ([`FileMove`], on disk when it returns). A file that did not move forgets the record and
    /// the new name's own write.
    pub(crate) fn forward(
        &self,
        lane: &mut Lane<'_>,
        writer: &NotesWriter,
        note_id: &str,
        moved: AppMoved<'_>,
    ) -> Result<(), MoveError> {
        lane.begin_move(writer, note_id, moved)?;
        let (source, target) = (on_disk(self.root, self.old), on_disk(self.root, self.new));
        if let Some(hash) = self.hash {
            self.echo.will_write(self.new, hash);
        }
        if let Err(error) = self.file_move(&source, &target, self.old).run(self.echo) {
            self.echo.cancel_write(self.new);
            self.forget(lane, writer, note_id);
            return Err(error.into());
        }
        Ok(())
    }

    /// Puts the file back after the record and row could not follow it: file and row must
    /// agree, or the moved file is taken for a new note and the row stranded. A file that went
    /// back forgets the record. One that could not stays at the new path with its record, for
    /// the next open to finish ([`finish_interrupted`]), and both names stay the app's: the
    /// old name's going is not the note's removal, and the new name's file (a markdown note's,
    /// [`Self::hash`]) is not a new note. Withdrawing the old name instead, for the watcher to
    /// pair the move on the hash, loses to the tries of the move back: they take over half a
    /// second, and by then the watcher has taken the old name's going for the app's and holds
    /// the new name as a new note. A file note's new name is not recorded (it has no hash);
    /// nothing adopts a file note as new yet, and what will must not take a recorded move's
    /// new path for one.
    pub(crate) fn back(&self, lane: &mut Lane<'_>, writer: &NotesWriter, note_id: &str) {
        let (source, target) = (on_disk(self.root, self.new), on_disk(self.root, self.old));
        match self.file_move(&source, &target, self.new).run(self.echo) {
            Ok(()) => {
                self.echo.cancel_removal(self.old);
                self.forget(lane, writer, note_id);
            }
            Err(error) => tracing::error!(
                scope = SCOPE,
                note_id,
                "a note's file could not go back after its record did not move; the next open \
                 finishes its move: {error}"
            ),
        }
    }

    /// Forgets the record of a move whose file did not move or went back. A record that stays
    /// is forgotten by the next open, which finds the file at the old path.
    fn forget(&self, lane: &mut Lane<'_>, writer: &NotesWriter, note_id: &str) {
        if let Err(error) = lane.forget_move(writer, note_id, self.old, self.new) {
            tracing::warn!(
                scope = SCOPE,
                note_id,
                "the record of an undone app move waits for the next open: {error}"
            );
        }
    }

    fn file_move<'p>(
        &self,
        source: &'p Path,
        target: &'p Path,
        source_rel: &'p str,
    ) -> FileMove<'p> {
        FileMove {
            source,
            target,
            source_rel,
            case_only: folded_key(self.old) == folded_key(self.new),
        }
    }
}

/// The file at the vault-relative, `/`-separated `rel`.
pub(crate) fn on_disk(root: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}

/// Settles each note's recorded app move, before the walk. Nothing here stops the open: a
/// record that cannot be settled now is logged and stays for the next open, and its note
/// does not move until then ([`memry_core::domain::notes::app_move::BeginError`]).
pub(crate) fn finish_interrupted(
    ctx: &IdentityCtx<'_>,
    writer: &NotesWriter,
    lane: &mut Lane<'_>,
    identity: &dyn NoteIdentity,
) {
    let deferred = finish_folders(ctx, writer, lane, identity);
    finish_folder_deletes(ctx.root, writer, lane);
    let pending = match writer.pending_app_moves() {
        Ok(pending) => pending,
        Err(error) => {
            return tracing::error!(
                scope = SCOPE,
                "the interrupted app moves are unread; they wait for the next open: {error}"
            );
        }
    };
    for (note_id, recorded) in pending {
        let settled = match recorded {
            // Its folder's record waits, and so does it.
            Recorded::Move(pending) if deferred.iter().any(|folder| carries(folder, &pending)) => {
                continue;
            }
            Recorded::Move(pending) => settle(ctx, writer, lane, identity, &note_id, &pending),
            Recorded::Unreadable(why) => Err(format!(
                "another version of the app recorded it, and this one cannot read it: {why}"
            )),
        };
        match settled {
            Ok(done) => tracing::info!(scope = SCOPE, note_id, "{done}"),
            // TODO(#3531 Step 14): tell the user, in one notice with the vault open's other
            // unsettled state (`notes::identity`'s `tell_once`): this note cannot be renamed
            // or moved until its interrupted move settles.
            Err(error) => tracing::warn!(
                scope = SCOPE,
                note_id,
                "an interrupted app move stays for the next open, and the note does not move \
                 until it settles: {error}"
            ),
        }
    }
}

/// Settles each folder's recorded app move, before its notes' are settled one by one. A move
/// the settings do not say how to finish waits, with its notes' records, for an open that reads
/// them: without the journal setting each day and dated note it carried would be left owed, and
/// the setting would never follow. The moves that wait.
fn finish_folders(
    ctx: &IdentityCtx<'_>,
    writer: &NotesWriter,
    lane: &mut Lane<'_>,
    identity: &dyn NoteIdentity,
) -> Vec<PendingFolderMove> {
    let read = writer
        .pending_folder_moves()
        .and_then(|folders| Ok((folders, writer.pending_app_moves()?)));
    let (folders, notes) = match read {
        Ok(read) => read,
        Err(error) => {
            tracing::error!(
                scope = SCOPE,
                "the interrupted folder moves are unread; they wait for the next open: {error}"
            );
            return Vec::new();
        }
    };
    let mut deferred = Vec::new();
    for recorded in folders {
        let settled = match recorded {
            FolderRecorded::Move(folder) => match read_vault_config_strict(ctx.root) {
                Ok(config) => settle_folder(ctx, writer, lane, identity, &folder, &notes, &config),
                Err(why) => {
                    deferred.push(folder);
                    Err(format!("the vault settings cannot be read: {why}"))
                }
            },
            FolderRecorded::Unreadable(why) => Err(format!(
                "another version of the app recorded it, and this one cannot read it: {why}"
            )),
        };
        match settled {
            Ok(done) => tracing::info!(scope = SCOPE, "{done}"),
            Err(error) => tracing::warn!(
                scope = SCOPE,
                "an interrupted folder move stays for the next open: {error}"
            ),
        }
    }
    deferred
}

fn settle_folder(
    ctx: &IdentityCtx<'_>,
    writer: &NotesWriter,
    lane: &mut Lane<'_>,
    identity: &dyn NoteIdentity,
    folder: &PendingFolderMove,
    notes: &[(String, Recorded)],
    config: &VaultConfig,
) -> Result<&'static str, String> {
    let (from, to) = (folder.from.as_str(), folder.to.as_str());
    if !moved_on_disk(ctx.root, folder, notes)? {
        lane.forget_folder_move(writer, from, to)
            .map_err(|error| error.to_string())?;
        return Ok("forgot an interrupted folder move that had not moved its folder");
    }
    // The journal setting that followed the folder, and the one it followed from.
    let followed = followed_journal_folder(&config.journal_folder, to, from).map(|before| {
        let format = &config.journal_date_format;
        (
            JournalDays::new(&before, format),
            JournalDays::new(&config.journal_folder, format),
        )
    });
    if let Some(days) = &followed {
        let walked: Vec<(&str, &str, &str)> = notes
            .iter()
            .filter_map(|(note_id, recorded)| match recorded {
                Recorded::Move(pending) if carries(folder, pending) => Some((
                    note_id.as_str(),
                    pending.old_path.as_str(),
                    pending.new_path.as_str(),
                )),
                _ => None,
            })
            .collect();
        settle_followed(days, writer, &walked).map_err(|error| error.to_string())?;
    }
    let mut carried = Vec::new();
    for (note_id, recorded) in notes {
        let Recorded::Move(pending) = recorded else {
            continue;
        };
        if carries(folder, pending) && found(ctx.root, lane, note_id, pending) == Found::Moved {
            let keeps_kind = match &followed {
                Some(days) => keeps_kind_followed(
                    days,
                    writer,
                    note_id,
                    (&pending.old_path, &pending.new_path),
                ),
                None => identity.keeps_kind(ctx, note_id, &pending.new_path),
            }
            .map_err(|error| error.to_string())?;
            carried.push((note_id.as_str(), pending, keeps_kind));
        }
    }
    let moves: Vec<(&str, AppMoved<'_>)> = carried
        .iter()
        .map(|(note_id, pending, keeps_kind)| {
            let moved = AppMoved {
                old_path: &pending.old_path,
                new_path: &pending.new_path,
                title: None,
                keeps_kind: *keeps_kind,
            };
            (*note_id, moved)
        })
        .collect();
    lane.folder_moved_by_app(writer, from, to, &moves)
        .map_err(|error| error.to_string())?;
    Ok("finished an interrupted folder move")
}

/// Settles each folder's recorded delete, before the notes' moves.
fn finish_folder_deletes(root: &Path, writer: &NotesWriter, lane: &mut Lane<'_>) {
    let pending = match writer.pending_folder_deletes() {
        Ok(pending) => pending,
        Err(error) => {
            return tracing::error!(
                scope = SCOPE,
                "the interrupted folder deletes are unread; they wait for the next open: {error}"
            );
        }
    };
    for recorded in pending {
        let settled = match recorded {
            FolderDeleteRecorded::Delete(path) => settle_folder_delete(root, writer, lane, &path),
            FolderDeleteRecorded::Unreadable(_, why) => Err(format!(
                "another version of the app recorded it, and this one cannot read it: {why}"
            )),
        };
        match settled {
            Ok(done) => tracing::info!(scope = SCOPE, "{done}"),
            Err(error) => tracing::warn!(
                scope = SCOPE,
                "an interrupted folder delete stays for the next open: {error}"
            ),
        }
    }
}

fn settle_folder_delete(
    root: &Path,
    writer: &NotesWriter,
    lane: &mut Lane<'_>,
    path: &str,
) -> Result<&'static str, String> {
    let failed = |error: &dyn std::fmt::Display| error.to_string();
    if listed(root, path)? {
        lane.forget_folder_delete(writer, path)
            .map_err(|error| failed(&error))?;
        return Ok("forgot an interrupted folder delete that had not removed its folder");
    }
    let below = format!("{path}/");
    let listed_notes = lane.files().list_paths().map_err(|error| failed(&error))?;
    let ids: Vec<&str> = listed_notes
        .iter()
        .filter(|(_, at)| at.starts_with(&below))
        .map(|(id, _)| id.as_str())
        .collect();
    lane.folder_deleted_by_app(writer, path, &ids)
        .map_err(|error| failed(&error))?;
    Ok("finished an interrupted folder delete")
}

/// What the open finds of a note's recorded move.
#[derive(Debug, PartialEq, Eq)]
enum Found {
    /// The note's row is at the old path, and its file is listed at the new path only.
    Moved,
    /// Nothing of the move is left to finish: the row is elsewhere or gone, or the file is not
    /// at the new path alone. The walk reports what is there.
    NotMoved,
    /// The row or a folder could not be read, or the record names no path of the vault.
    Unknown(String),
}

fn settle(
    ctx: &IdentityCtx<'_>,
    writer: &NotesWriter,
    lane: &mut Lane<'_>,
    identity: &dyn NoteIdentity,
    note_id: &str,
    pending: &PendingMove,
) -> Result<&'static str, String> {
    let (old, new) = (pending.old_path.as_str(), pending.new_path.as_str());
    match found(ctx.root, lane, note_id, pending) {
        Found::Moved => {
            let keeps_kind = identity
                .keeps_kind(ctx, note_id, new)
                .map_err(|error| error.to_string())?;
            let moved = AppMoved {
                old_path: old,
                new_path: new,
                title: pending.title.as_deref().filter(|_| keeps_kind),
                keeps_kind,
            };
            lane.move_by_app(writer, note_id, moved)
                .map_err(|error| error.to_string())?;
            Ok("finished an interrupted app move")
        }
        Found::NotMoved => {
            lane.forget_move(writer, note_id, old, new)
                .map_err(|error| error.to_string())?;
            Ok("forgot an interrupted app move that had not moved its file")
        }
        Found::Unknown(why) => Err(why),
    }
}

fn found(root: &Path, lane: &Lane<'_>, note_id: &str, pending: &PendingMove) -> Found {
    let row = match lane.files().by_id(note_id) {
        Ok(row) => row,
        Err(error) => return Found::Unknown(format!("the note's row is unread: {error}")),
    };
    if row.is_none_or(|row| row.path != pending.old_path) {
        return Found::NotMoved;
    }
    match (
        listed(root, &pending.new_path),
        listed(root, &pending.old_path),
    ) {
        (Ok(true), Ok(false)) => Found::Moved,
        (Ok(_), Ok(_)) => Found::NotMoved,
        (Err(why), _) | (_, Err(why)) => Found::Unknown(why),
    }
}

/// Whether `rel` is an entry of its folder under exactly that name (NFC): a volume that folds
/// case answers a lookup of either spelling of a respelled file. Only the name is compared:
/// the folders are opened as recorded, and the move that respells a file leaves them as they
/// are. A missing folder lists nothing; one that cannot be read is an `Err`, and so is a path
/// that leads out of the vault ([`is_plain_relative`]: a name the user's file system holds,
/// `Re: plan.md` or a folder `Notes `, is a path of the vault).
fn listed(root: &Path, rel: &str) -> Result<bool, String> {
    if !is_plain_relative(rel) {
        return Err("the record names no path in the vault".to_owned());
    }
    let segments: Vec<&str> = rel.split('/').collect();
    let (name, folders) = segments.split_last().expect("split yields a segment");
    let folder = folders
        .iter()
        .fold(root.to_path_buf(), |path, segment| path.join(segment));
    let unread = |error: io::Error| format!("a folder of the move cannot be listed: {error}");
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(unread(error)),
    };
    for entry in entries {
        let entry = entry.map_err(unread)?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(|entry| entry.nfc().eq(name.nfc()))
        {
            return Ok(true);
        }
    }
    Ok(false)
}
