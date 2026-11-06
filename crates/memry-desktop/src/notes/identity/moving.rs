//! The paths a recorded app move is taking its note's file between (#3530 13m-7b-2b). Both are
//! that note's until the next open finishes the move before its walk and its watcher
//! (`vault::app_move::finish_interrupted`): a file at the new path is never a new note or day,
//! and the absence of the file at the old path, where the note's row still is, is never the
//! note's removal or a move to pair (an edited file pairs with nothing, an unedited one would
//! cross under a setting the move has not settled). The record waits instead. A folder move that stays on disk with its rows behind (its records not
//! followed, or the settings unreadable at the open) would otherwise lose each note it carried
//! to a new note at its new path once anything shows the watcher that file, and the next open
//! would delete the note and sync the delete. The records go in the same core transaction that
//! moves the rows, so this claim ends with the move, whatever the watcher saw meanwhile.

use std::collections::HashSet;

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::app_move::Recorded;

use super::SCOPE;
use crate::vault::consumer::identity::IdentityError;
use crate::vault::path_key::folded_key;

/// The new path of every pending app move this build can read, in the folded form a
/// case-blind volume compares. A record another build wrote and this one cannot read holds
/// back that note's moves only (`Recorded::Unreadable`), and claims no path here.
pub(super) fn moving_to(writer: &NotesWriter) -> Result<HashSet<String>, IdentityError> {
    Ok(writer
        .pending_app_moves()?
        .into_iter()
        .filter_map(|(_, recorded)| match recorded {
            Recorded::Move(pending) => Some(folded_key(&pending.new_path)),
            Recorded::Unreadable(_) => None,
        })
        .collect())
}

/// Whether `path` is where a recorded app move takes its note's file.
pub(super) fn is_moving_to(writer: &NotesWriter, path: &str) -> Result<bool, IdentityError> {
    Ok(moving_to(writer)?.contains(&folded_key(path)))
}

/// Whether a recorded app move of `note_id` takes its file from `path`, where its row is: the
/// row's absence there is the move's, which the next open finishes ([`moving_to`]'s module doc).
pub(super) fn is_moving_from(
    writer: &NotesWriter,
    note_id: &str,
    path: &str,
) -> Result<bool, IdentityError> {
    let moving = writer
        .pending_app_moves()?
        .into_iter()
        .any(|(id, recorded)| {
            id == note_id && matches!(recorded, Recorded::Move(pending) if pending.old_path == path)
        });
    if moving {
        tracing::warn!(
            scope = SCOPE,
            note_id,
            "the note's file left its row's path for an app move that did not finish; the note \
             waits for the open that finishes it"
        );
    }
    Ok(moving)
}

/// What a removal or move of the file [`is_moving_from`] names answers: the row stays with its
/// hash, and the next open finishes the recorded move (an `Err`, which the consumer logs and
/// asks again at the next open).
pub(super) fn waits() -> IdentityError {
    IdentityError::Other("the note waits for the open that finishes its app move".to_owned())
}
