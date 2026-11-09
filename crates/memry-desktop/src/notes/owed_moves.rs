//! The moves a note's or journal day's record is owed (Step 13m-6, #3530): a move that changes
//! what the file is ([`keeps_kind`]) is made at the next open's walk ([`crossings`]), the
//! record deleted for the consumer to make the file anew, as Electron does
//! (`renameKeepsJournalDate`, `vault/watcher.ts`). A day the whole journal folder carried is
//! held, never crossed, and stays held whatever is on disk later ([`held`]).

use std::path::Path;

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::identity::{Crossing, Moved, Removed};
use memry_core::markdown::frontmatter::split_frontmatter_block;

use super::identity::{NotesIdentity, electron_db_beside, is_large_file, place};
use crate::journal::folder_follow::{
    Follow, batch_held, follow_after_batch, journal_folder_moved, mark_batch,
};
use crate::vault::consumer::identity::{Crossed, IdentityCtx, IdentityError};
use crate::vault::journal_format::JournalDays;

const SCOPE: &str = "note_identity";

/// Whether the record `id` at `path` is what it was: its day (none for a note) is the day
/// `path` names.
pub(super) fn keeps_kind(
    journal: &JournalDays,
    writer: &NotesWriter,
    id: &str,
    path: &str,
) -> Result<bool, IdentityError> {
    Ok(writer.journal_date(id)? == journal.day_of(path))
}

/// Whether the record `id` moved from `old` to `new` with the journal folder, the setting
/// following it from `days.0` to `days.1`, is what it was: [`keeps_kind`] under the new
/// setting, or its path a day of the same date (or of none) under each setting. A note a date
/// names in the journal folder stays the note it was, as Electron's `renameKeepsJournalDate`
/// keeps it; crossed, the note would be deleted and the delete synced.
pub(crate) fn keeps_kind_followed(
    days: &(JournalDays, JournalDays),
    writer: &NotesWriter,
    id: &str,
    (old, new): (&str, &str),
) -> Result<bool, IdentityError> {
    Ok(keeps_kind(&days.1, writer, id, new)? || days.0.day_of(old) == days.1.day_of(new))
}

/// The owed moves of the files a move of the journal folder carried (`(id, old, new)`), settled
/// by [`keeps_kind_followed`] once the setting followed: an open that could not read the
/// settings paired the moved files as moves owed while the days were unknown (`on_renamed`).
/// Crossed under the followed setting alone, a note a date names would be deleted.
pub(crate) fn settle_followed(
    days: &(JournalDays, JournalDays),
    writer: &NotesWriter,
    carried: &[(&str, &str, &str)],
) -> Result<(), IdentityError> {
    for owed in writer.owed_places()? {
        let Some(&(id, old, new)) = carried.iter().find(|(id, old, new)| {
            *id == owed.note_id && *old == owed.from_path && *new == owed.path
        }) else {
            continue;
        };
        if keeps_kind_followed(days, writer, id, (old, new))? {
            let (folder_path, title) = place(new);
            let moved = Moved {
                old_path: new,
                new_path: new,
                title,
                folder_path,
            };
            writer.file_moved(id, moved)?;
        }
    }
    Ok(())
}

/// Whether the day `id`, moved from `from` to `to`, is held: owed its move until the journal
/// setting follows the folder ([`crate::journal::folder_follow`]), never crossed. Crossed, a
/// folder renamed in Finder would delete every day and sync the delete. A day held already
/// stays held whatever is on disk now ([`NotesWriter::held_places`]); otherwise it is held when
/// the move is the journal folder moving whole ([`journal_folder_moved`]), read from where the
/// day was before its first owed move, so the held folder renamed again before the setting
/// followed is the journal moving on. The disk decides only here, once, and the hold is kept
/// ([`NotesWriter::hold_place`]): the old folder made again later (a folder or note create, or
/// by hand) never turns a held day into a crossing. A day at a path the setting reads as a day
/// is not held.
pub(crate) fn held(
    root: &Path,
    journal: &JournalDays,
    writer: &NotesWriter,
    id: &str,
    from: &str,
    to: &str,
) -> Result<bool, IdentityError> {
    if writer.journal_date(id)?.is_none() || journal.day_of(to).is_some() {
        return Ok(false);
    }
    let first = writer
        .owed_places()?
        .into_iter()
        .find(|owed| owed.note_id == id);
    if first.is_some() && writer.held_places()?.iter().any(|held| held.note_id == id) {
        return Ok(true);
    }
    let from = first.as_ref().map_or(from, |owed| owed.from_path.as_str());
    let held = journal_folder_moved(root, journal.folder(), from, to).is_some();
    if held {
        writer.hold_place(id, from)?;
    }
    Ok(held)
}

/// Once the consumer's queue went quiet after a batch, with the rows' lane released: the journal
/// setting follows the folder the batch held days in (`journal::folder_follow`), as Electron's
/// watcher follows at the move's first event. `true` when it followed. A quiet queue after a
/// batch that held nothing asks nothing of the database.
pub(super) fn follow_held(identity: &NotesIdentity, ctx: &IdentityCtx<'_>) -> bool {
    batch_held(ctx.root)
        && identity
            .writer(ctx)
            .is_ok_and(|writer| follow_after_batch(ctx.root, &writer) == Follow::Followed)
}

/// Each owed move that changes what its file is, with its record deleted as the watcher's move
/// deletes it ([`NotesWriter::file_crossed`]); one whose record stays is left owed, and a held
/// day is never crossed ([`held`]).
pub(super) fn crossings(
    identity: &NotesIdentity,
    ctx: &IdentityCtx<'_>,
    journal: &JournalDays,
    writer: &NotesWriter,
) -> Vec<Crossed> {
    let root = ctx.root;
    let owed = match writer.owed_places() {
        Ok(owed) => owed,
        Err(error) => {
            tracing::error!(scope = SCOPE, "the owed moves could not be read: {error}");
            return Vec::new();
        }
    };
    let mut crossed = Vec::new();
    for owed in owed {
        let removed = keeps_kind(journal, writer, &owed.note_id, &owed.path).and_then(|keeps| {
            if keeps {
                return Ok(None);
            }
            if held(
                root,
                journal,
                writer,
                &owed.note_id,
                &owed.from_path,
                &owed.path,
            )? {
                mark_batch(root);
                return Ok(None);
            }
            let (id, from) = (&owed.note_id, &owed.from_path);
            Ok(Some(cross(
                identity, ctx, writer, journal, id, from, &owed.path,
            )?))
        });
        match removed {
            Ok(Some(Removed::Deleted)) => crossed.push(Crossed {
                note_id: owed.note_id,
                path: owed.path,
            }),
            Ok(_) => {}
            Err(error) => tracing::error!(
                scope = SCOPE,
                note_id = owed.note_id,
                "an owed move between note and journal day was not made: {error}"
            ),
        }
    }
    crossed
}

/// Makes the crossing of the record `id`'s file from `from` to `to` as the core decides
/// ([`NotesWriter::file_crossed`]), with what the file says there. A file not read, or of the
/// large-file class, which the tier would not make a note or a day, is only owed the move.
pub(super) fn cross(
    identity: &NotesIdentity,
    ctx: &IdentityCtx<'_>,
    writer: &NotesWriter,
    journal: &JournalDays,
    id: &str,
    from: &str,
    to: &str,
) -> Result<Removed, IdentityError> {
    let raw = match std::fs::read_to_string(ctx.root.join(to)) {
        Ok(raw) if !is_large_file(u64::try_from(raw.len()).unwrap_or(u64::MAX), &raw) => raw,
        _ => {
            writer.owe_place(id, from)?;
            return Ok(Removed::Undecided);
        }
    };
    let body = split_frontmatter_block(&raw).body;
    let (folder_path, title) = place(to);
    let day = journal.day_of(to);
    let crossing = Crossing {
        from_path: from,
        path: to,
        title,
        folder_path,
        day: day.as_deref(),
        body,
        electron_db_beside: electron_db_beside(ctx.root),
    };
    let (converter, embeds) = identity.reader(ctx, to, body)?;
    writer
        .file_crossed(id, crossing, Some(&converter), Some(&embeds))
        .map_err(|error| IdentityError::Other(error.to_string()))
}
