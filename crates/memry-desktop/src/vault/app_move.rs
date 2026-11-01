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
//! [`NoteFileMove`] is the live half: it records the move and moves the file, and puts the
//! file back when the transaction fails.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::app_move::{AppMoved, BeginError, PendingMove, Recorded};
use unicode_normalization::UnicodeNormalization;

use super::consumer::identity::{IdentityCtx, NoteIdentity};
use super::consumer::rows::Lane;
use super::file_move::FileMove;
use super::path_key::folded_key;
use super::watch::EchoGuard;
use crate::shell::file_open::is_plain_relative;

const SCOPE: &str = "app_move";

/// Why [`NoteFileMove::forward`] did not move the file.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MoveError {
    #[error(transparent)]
    Begin(#[from] BeginError),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// One app move of a note's file, between two vault-relative paths, under the rows' lane.
pub(crate) struct NoteFileMove<'a> {
    pub echo: &'a EchoGuard,
    pub root: &'a Path,
    pub old: &'a str,
    pub new: &'a str,
    /// A markdown note's row has the hash of its bytes, which the watcher pairs a move on.
    pub pairs_on_hash: bool,
}

impl NoteFileMove<'_> {
    /// Records the move ([`Lane::begin_move`]), then moves the file without replacing anything
    /// ([`FileMove`], on disk when it returns). A file that did not move forgets the record.
    pub(crate) fn forward(
        &self,
        lane: &mut Lane<'_>,
        writer: &NotesWriter,
        note_id: &str,
        moved: AppMoved<'_>,
    ) -> Result<(), MoveError> {
        lane.begin_move(writer, note_id, moved)?;
        let (source, target) = (on_disk(self.root, self.old), on_disk(self.root, self.new));
        if let Err(error) = self.file_move(&source, &target, self.old).run(self.echo) {
            self.forget(lane, writer, note_id);
            return Err(error.into());
        }
        Ok(())
    }

    /// Puts the file back after the record and row could not follow it: file and row must
    /// agree, or the moved file is taken for a new note and the row stranded. A file that went
    /// back forgets the record. One that could not stays at the new path with its record, for
    /// the next open to finish ([`finish_interrupted`]); meanwhile a markdown note's old name
    /// is withdrawn from the own-write record, so the watcher sees an outside move and pairs it
    /// on the row's hash, and a file note's stays, so its old name going is not taken for the
    /// note's removal.
    pub(crate) fn back(&self, lane: &mut Lane<'_>, writer: &NotesWriter, note_id: &str) {
        let (source, target) = (on_disk(self.root, self.new), on_disk(self.root, self.old));
        match self.file_move(&source, &target, self.new).run(self.echo) {
            Ok(()) => {
                self.echo.cancel_removal(self.old);
                self.forget(lane, writer, note_id);
            }
            Err(error) => {
                tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "a note's file could not go back after its record did not move: {error}"
                );
                if self.pairs_on_hash {
                    self.echo.cancel_removal(self.old);
                }
            }
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
