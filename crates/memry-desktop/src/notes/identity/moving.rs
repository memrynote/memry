//! The files a recorded app move is taking to their new paths (#3530 13m-7b-2b). Such a file
//! belongs to the note whose move names it, never to a new note or day: the next open finishes
//! the move before its walk and its watcher (`vault::app_move::finish_interrupted`), and until
//! then the file waits. A folder move that stays on disk with its rows behind (its records not
//! followed, or the settings unreadable at the open) would otherwise lose each note it carried
//! to a new note at its new path once anything shows the watcher that file, and the next open
//! would delete the note and sync the delete. The records go in the same core transaction that
//! moves the rows, so this claim ends with the move, whatever the watcher saw meanwhile.

use std::collections::HashSet;

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::app_move::Recorded;

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
