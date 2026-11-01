//! A note renamed or moved in the app (`renameNote` and `moveNote`, `vault/notes-rename.ts`).
//! A rename gives the note a new title and its file the name that title makes, in the same
//! folder. A move puts the file, under its name, in another folder. The bytes stay as they
//! are: the title lives in the record.
//!
//! In the note's write order, and under the rows' lane for the whole step, so no watcher fact
//! for either path lands in between:
//! 1. the target: the first free `<name>.md`, `<name> 1.md`, ... that no other note holds under
//!    any spelling the volume may fold and nothing on disk is at. The note's own file under
//!    another spelling is free: a rename that changes only case respells it in place;
//! 2. the move recorded in the core, then the file moved without replacing anything and synced
//!    into its folders, the own-write record told first that the old name goes, so the watcher
//!    never takes the move for a delete and a new file ([`NoteFileMove`]);
//! 3. the record, the row and the manual slot, in one core transaction that also forgets the
//!    record of step 2 ([`Lane::move_by_app`]): the title given and the new folder, the new
//!    path, and the slot carried (a rename) or the new folder's first (a move). A move that
//!    changes what the file is (a note into a journal day's path) leaves the record as it was,
//!    title included, owed the move, as the watcher's move does (Step 13m);
//! 4. [`Applied::Renamed`], under the lane, for whatever follows the rows (the note index, the
//!    shell's note events). A rename whose file keeps its name (a title its name already says)
//!    sends it with the same old and new path.
//!
//! A failed step 3 moves the file back and forgets the record of the move. A crash between 2 and
//! 3 leaves the file at its new name, its row at the old one and the record of the move, which
//! the next open finishes before its watcher starts
//! ([`crate::vault::app_move::finish_interrupted`]), with the title given. That is the one path
//! for a markdown note and a file note (PDF, image) alike.
//!
//! Also refused: a folder that is not a plain path of the vault ([`is_plain_relative`], each
//! segment one name), one the vault ignores, so the note would drop out of it at the next open,
//! and a folder reached through a link, which the open walk does not enter for the same reason.
//!
//! Not here yet: the inbound `[[link]]` rewrite (13g-2), a moved note's relative embeds
//! (`rewriteNoteRefsForMove`, 13g-3), and the locked-folder check (Step 13n).

use std::fs;
use std::io::{self, ErrorKind};
use std::path::Path;

use memry_core::api::errors::StorageError;
use memry_core::domain::notes::app_move::AppMoved;

use super::error::NotesError;
use super::read;
use super::service::NotesService;
use super::view::NoteView;
use crate::session::OpenVault;
use crate::shell::file_open::{Resolution, is_plain_relative};
use crate::vault::app_move::{NoteFileMove, on_disk};
use crate::vault::config::read_vault_config;
use crate::vault::consumer::Applied;
use crate::vault::consumer::identity::{IdentityCtx, IdentityError};
use crate::vault::consumer::rows::Lane;
use crate::vault::file_move::is_respelling;
use crate::vault::file_types::FileType;
use crate::vault::path_key::folded_key;
use crate::vault::paths::{resolve_vault_file, sanitize_filename, sanitize_new_filename};
use crate::vault::watch::filter::WatchFilter;

/// Names tried before a rename or move gives up: `<name>.md`, then `<name> 1.md` up to this.
const MAX_CANDIDATES: usize = 10_000;
/// `NoteRenameSchema`: `newTitle` is 1 to 200 UTF-16 units.
const MAX_TITLE_UNITS: usize = 200;

/// Where the app puts a note.
#[derive(Debug, Clone, Copy)]
pub enum MoveTo<'a> {
    /// `notes:rename`: a new title, and its file renamed in its folder.
    Title(&'a str),
    /// `notes:move`: another folder, vault-relative with `/` (`""` for the root); the file
    /// keeps its name.
    Folder(&'a str),
}

impl NotesService {
    pub fn rename(
        &self,
        open: &OpenVault,
        note_id: &str,
        title: &str,
    ) -> Result<NoteView, NotesError> {
        self.move_checked(open, note_id, MoveTo::Title(title), &mut || Ok(()))
    }

    pub fn move_to_folder(
        &self,
        open: &OpenVault,
        note_id: &str,
        folder: &str,
    ) -> Result<NoteView, NotesError> {
        self.move_checked(open, note_id, MoveTo::Folder(folder), &mut || Ok(()))
    }

    /// [`Self::rename`] and [`Self::move_to_folder`], with a hook that runs once the file
    /// moved, before the record and row follow it, so a test can fail or cut the step there.
    #[doc(hidden)]
    pub fn move_checked(
        &self,
        open: &OpenVault,
        note_id: &str,
        to: MoveTo<'_>,
        after_file: &mut dyn FnMut() -> Result<(), NotesError>,
    ) -> Result<NoteView, NotesError> {
        if let MoveTo::Title(title) = to {
            let units = title.encode_utf16().count();
            if units == 0 || units > MAX_TITLE_UNITS {
                return Err(NotesError::InvalidTitle);
            }
        }
        self.order
            .run(note_id, || self.move_now(open, note_id, to, after_file))?;
        read::get(open, note_id, None)?.ok_or_else(|| NotesError::NotFound(note_id.to_owned()))
    }

    fn move_now(
        &self,
        open: &OpenVault,
        note_id: &str,
        to: MoveTo<'_>,
        after_file: &mut dyn FnMut() -> Result<(), NotesError>,
    ) -> Result<(), NotesError> {
        let root = open.path.as_path();
        let rows = self.tier.rows();
        let session = rows.session_for(&open.vault)?;
        let writer = open.vault.notes_writer(self.store.clone())?;
        let identity = self.tier.identity();
        let mut lane = rows.lane_of(session)?;
        let not_found = || NotesError::NotFound(note_id.to_owned());
        let listed = open
            .vault
            .note_files()
            .listed_by_id(note_id)?
            .ok_or_else(not_found)?;
        let old = listed.path;
        let row = lane.files().by_id(note_id)?.ok_or_else(not_found)?;
        let (old_folder, name) = old.rsplit_once('/').unwrap_or(("", &old));
        let (folder, name) = match to {
            MoveTo::Title(title) => (old_folder.to_owned(), name_for(name, title)),
            MoveTo::Folder(folder) => (plain_folder(folder)?, name.to_owned()),
        };
        let title = match to {
            MoveTo::Title(title) => Some(title),
            MoveTo::Folder(_) => None,
        };
        let new = free_target(&lane, root, note_id, &old, &folder, &name)?;
        let ctx = IdentityCtx {
            root,
            vault: &open.vault,
        };
        let keeps_kind = identity
            .keeps_kind(&ctx, note_id, &new)
            .map_err(identity_failed)?;
        let moved = AppMoved {
            old_path: &old,
            new_path: &new,
            title: title.filter(|_| keeps_kind),
            keeps_kind,
        };
        if new == old && moved.title.is_none_or(|title| title == listed.title) {
            return Ok(());
        }
        let echo = self.tier.echo();
        let file = (new != old).then(|| NoteFileMove {
            echo: &echo,
            root,
            old: &old,
            new: &new,
            pairs_on_hash: row.file_type == FileType::Markdown.as_str(),
        });
        if let Some(file) = &file {
            file.forward(&mut lane, &writer, note_id, moved)?;
        }
        let followed = after_file().and_then(|()| Ok(lane.move_by_app(&writer, note_id, moved)?));
        if let Err(error) = followed {
            if let Some(file) = &file {
                file.back(&mut lane, &writer, note_id);
            }
            return Err(error);
        }
        lane.publish(Applied::Renamed {
            note_id: note_id.to_owned(),
            old_path: old,
            new_path: new,
        });
        Ok(())
    }
}

/// The file name `title` gives the note whose file is `name`, its extension kept. A file that
/// already bears the name Electron's rule makes of the title keeps it, even where a new name
/// would be cut or hardened (`con.md`, a name over [`sanitize_new_filename`]'s bytes): renaming
/// a note to its own title moves nothing.
fn name_for(name: &str, title: &str) -> String {
    let ext = extension_of(name);
    if name.strip_suffix(ext) == Some(sanitize_filename(title).as_str()) {
        return name.to_owned();
    }
    format!("{}{ext}", sanitize_new_filename(title))
}

/// `path.extname` of a file name, the dot included; `""` for none.
fn extension_of(name: &str) -> &str {
    match name.rfind('.') {
        Some(dot) if dot > 0 => &name[dot..],
        _ => "",
    }
}

/// A move's folder, a path of the vault the sidebar lists: empty segments (`a//b`, a leading
/// or trailing `/`) and `.` dropped as `path.join` drops them, and every other segment one name
/// of the user's file system ([`is_plain_relative`]; `Re: plan` is a folder on macOS).
fn plain_folder(folder: &str) -> Result<String, NotesError> {
    let segments: Vec<&str> = folder
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect();
    let one_name =
        |segment: &&str| is_plain_relative(segment) && Path::new(segment).components().count() == 1;
    if !segments.iter().all(one_name) {
        return Err(NotesError::InvalidFolder);
    }
    Ok(segments.join("/"))
}

/// The first name for the note in `folder`, vault-relative with `/`: one no other note holds
/// and nothing on disk is at, or the note's own file. A folder outside the vault, one the
/// vault ignores, or one reached through a link is refused.
fn free_target(
    lane: &Lane<'_>,
    root: &Path,
    note_id: &str,
    old: &str,
    folder: &str,
    name: &str,
) -> Result<String, NotesError> {
    if !folder.is_empty() {
        if resolve_vault_file(root, folder)? == Resolution::Outside {
            return Err(NotesError::Outside);
        }
        if through_link(root, folder)? {
            return Err(NotesError::InvalidFolder);
        }
    }
    let filter = WatchFilter::new(read_vault_config(root).exclude_patterns);
    let rel = |name: &str| match folder {
        "" => name.to_owned(),
        folder => format!("{folder}/{name}"),
    };
    if !filter.takes_file(&rel(name)) {
        return Err(NotesError::InvalidFolder);
    }
    let (stem, ext) = name.split_at(name.len() - extension_of(name).len());
    let names = std::iter::once(name.to_owned())
        .chain((1..MAX_CANDIDATES).map(|counter| format!("{stem} {counter}{ext}")));
    for candidate in names.map(|name| rel(&name)) {
        if candidate == old {
            return Ok(candidate);
        }
        if lane.check(note_id, &candidate).is_err() {
            continue;
        }
        match fs::symlink_metadata(on_disk(root, &candidate)) {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(candidate),
            Err(error) => return Err(error.into()),
            Ok(_)
                if folded_key(&candidate) == folded_key(old)
                    && is_respelling(&on_disk(root, old), &on_disk(root, &candidate)) =>
            {
                return Ok(candidate);
            }
            Ok(_) => {}
        }
    }
    Err(NotesError::NameConflict)
}

/// Whether a folder on the way to `folder` is a link (a junction on Windows). The open walk
/// enters none, so a note moved under one would read as removed at the next open.
fn through_link(root: &Path, folder: &str) -> io::Result<bool> {
    let mut path = root.to_path_buf();
    for segment in folder.split('/') {
        path.push(segment);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => return Ok(true),
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        }
    }
    Ok(false)
}

fn identity_failed(error: IdentityError) -> NotesError {
    match error {
        IdentityError::Storage(error) => NotesError::Storage(error),
        IdentityError::Other(what) => NotesError::Storage(StorageError::Failed { what }),
    }
}
