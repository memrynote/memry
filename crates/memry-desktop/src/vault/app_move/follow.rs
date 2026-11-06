//! The journal setting an interrupted folder move owes (`notes::folder_move`), and whether such
//! a move happened on disk.

use std::path::Path;

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::app_move::{
    FolderRecorded, PendingFolderMove, PendingMove, Recorded,
};

use super::{SCOPE, listed};
use crate::journal::folder_follow::followed_journal_folder;
use crate::vault::config::read_vault_config_strict;
use crate::vault::config::settings::JournalFollow;

/// The journal setting follows each recorded folder move that carried the journal folder and
/// moved on disk ([`moved_on_disk`]). Called before the rows' lane, by the open before it
/// finishes the moves and by a day create before it names its file, so no day is named in the
/// folder the journal left while the move waits (on settings the open could not read). Takes
/// the settings' lock only when a folder move is recorded. Its failures are its own to log: the
/// move then waits for the next open, its days held by their records.
pub(crate) fn follow_interrupted(root: &Path, writer: &NotesWriter) {
    let read = writer
        .pending_folder_moves()
        .and_then(|folders| Ok((folders, writer.pending_app_moves()?)));
    let (folders, notes) = match read {
        Ok(read) => read,
        Err(error) => {
            return tracing::error!(
                scope = SCOPE,
                "the interrupted folder moves are unread; they wait for the next open: {error}"
            );
        }
    };
    let moves: Vec<PendingFolderMove> = folders
        .into_iter()
        .filter_map(|recorded| match recorded {
            FolderRecorded::Move(folder) => Some(folder),
            FolderRecorded::Unreadable(_) => None,
        })
        .collect();
    if moves.is_empty() {
        return;
    }
    let settings = JournalFollow::hold();
    for folder in moves {
        let (from, to) = (folder.from.as_str(), folder.to.as_str());
        let followed = read_vault_config_strict(root)
            .map_err(|why| format!("the settings cannot be read: {why}"))
            .and_then(|config| {
                let Some(followed) = followed_journal_folder(&config.journal_folder, from, to)
                else {
                    return Ok(None);
                };
                if !moved_on_disk(root, &folder, &notes)? {
                    return Ok(None);
                }
                settings
                    .save(root, &followed)
                    .map(|_| Some(followed))
                    .map_err(|error| error.to_string())
            });
        match followed {
            Ok(Some(folder)) => tracing::info!(
                scope = SCOPE,
                folder,
                "the journal setting followed an interrupted folder move"
            ),
            Ok(None) => {}
            Err(error) => tracing::warn!(
                scope = SCOPE,
                "the journal setting waits for the next open to follow its folder: {error}"
            ),
        }
    }
}

/// Whether the recorded folder move happened on disk: its folder is at `to`, and `from` is
/// gone, or every note the move carried is at its new path and gone from its old one. A file
/// made in `from` after the move (a day named there before the setting followed, a folder made
/// by hand) is new there and does not undo the move: forgotten, its notes would settle alone
/// under a setting that did not follow, and each day would cross into a note.
pub(super) fn moved_on_disk(
    root: &Path,
    folder: &PendingFolderMove,
    notes: &[(String, Recorded)],
) -> Result<bool, String> {
    if !listed(root, &folder.to)? {
        return Ok(false);
    }
    if !listed(root, &folder.from)? {
        return Ok(true);
    }
    let mut carried = false;
    for (note_id, recorded) in notes {
        let Recorded::Move(pending) = recorded else {
            continue;
        };
        if !carries(folder, pending) {
            continue;
        }
        if !listed(root, &pending.new_path)? {
            return Ok(false);
        }
        if listed(root, &pending.old_path)? {
            // Told at each open that meets it: a file made at the old path of a note the move
            // carried leaves the move unfinished, and a journal setting it owes unfollowed.
            tracing::warn!(
                scope = SCOPE,
                note_id,
                "a file is back at the old path of a note a folder move carried; the folder's \
                 move is not finished, and its notes settle one by one"
            );
            return Ok(false);
        }
        carried = true;
    }
    Ok(carried)
}

/// Whether the note's recorded move is the folder's move carrying it.
pub(super) fn carries(folder: &PendingFolderMove, pending: &PendingMove) -> bool {
    pending
        .old_path
        .strip_prefix(folder.from.as_str())
        .and_then(|rest| rest.strip_prefix('/'))
        .is_some_and(|rest| pending.new_path == format!("{}/{rest}", folder.to))
}
