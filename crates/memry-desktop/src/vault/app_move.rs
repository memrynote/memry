//! The vault open's finish of an app move a crash cut short (Step 13g, #3530).
//!
//! A note's rename or move in the app records the move in the core
//! ([`NotesWriter::begin_app_move`]), moves the file, and then moves record, row and slot in
//! one transaction that forgets the record ([`Lane::move_by_app`]). A crash between the file
//! and the transaction leaves the file at its new path, its row at the old one, and the record.
//! [`finish_interrupted`] runs when the vault opens, before its watcher starts, so the watcher
//! never sees the moved file as a new one. That serves a markdown note and a file note (PDF,
//! image) alike: a file note's row has no hash, so nothing else could pair its moved file
//! with it.

use std::fs;
use std::path::{Path, PathBuf};

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::app_move::{AppMoved, Recorded};
use unicode_normalization::UnicodeNormalization;

use super::consumer::identity::{IdentityCtx, NoteIdentity};
use super::consumer::rows::Lane;

const SCOPE: &str = "app_move";

/// Settles the app move a crash cut short, before the watcher starts. Finished when the note's
/// row is still at the old path and the file is listed at the new path and not at the old,
/// with the title given (or owed, by the identity's `keeps_kind`); forgotten when the file is
/// not there, which the watcher's walk then reports as it finds it. A move whose note cannot
/// follow keeps its record for the next open. A record this build cannot read (another
/// version's) is logged and left as it is. Nothing here stops the open.
pub(crate) fn finish_interrupted(
    ctx: &IdentityCtx<'_>,
    writer: &NotesWriter,
    lane: &mut Lane<'_>,
    identity: &dyn NoteIdentity,
) {
    let pending = match writer.pending_app_move() {
        Ok(Some(Recorded::Move(pending))) => pending,
        Ok(None) => return,
        Ok(Some(Recorded::Unknown(why))) => {
            return tracing::warn!(
                scope = SCOPE,
                "an interrupted app move this version cannot read stays for the version that \
                 wrote it: {why}"
            );
        }
        Err(error) => {
            return tracing::error!(scope = SCOPE, "an interrupted app move is unread: {error}");
        }
    };
    let (note_id, old, new) = (&pending.note_id, &pending.old_path, &pending.new_path);
    let row_at_old = matches!(lane.files().by_id(note_id), Ok(Some(row)) if row.path == *old);
    if !(row_at_old && listed(ctx.root, new) && !listed(ctx.root, old)) {
        tracing::info!(
            scope = SCOPE,
            note_id,
            "an interrupted app move had not moved its file"
        );
        if let Err(error) = writer.abandon_app_move() {
            tracing::warn!(
                scope = SCOPE,
                "the record of an undone app move stays: {error}"
            );
        }
        return;
    }
    let finished = match identity.keeps_kind(ctx, note_id, new) {
        Ok(keeps_kind) => {
            let moved = AppMoved {
                old_path: old,
                new_path: new,
                title: pending.title.as_deref().filter(|_| keeps_kind),
                keeps_kind,
            };
            lane.move_by_app(writer, note_id, moved)
                .map_err(|error| error.to_string())
        }
        Err(error) => Err(error.to_string()),
    };
    match finished {
        Ok(()) => tracing::info!(scope = SCOPE, note_id, "finished an interrupted app move"),
        Err(error) => tracing::error!(
            scope = SCOPE,
            note_id,
            "an interrupted app move waits for the next open: {error}"
        ),
    }
}

/// Whether `rel` is an entry of its folder under exactly that name (NFC): a volume that folds
/// case answers a lookup of either spelling of a respelled file.
fn listed(root: &Path, rel: &str) -> bool {
    let path = on_disk(root, rel);
    let (Some(folder), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str()))
    else {
        return false;
    };
    let Ok(entries) = fs::read_dir(folder) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .file_name()
            .to_str()
            .is_some_and(|entry| entry.nfc().eq(name.nfc()))
    })
}

/// A vault-relative `/` path on disk, joined a segment at a time (`path.join`).
fn on_disk(root: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}
