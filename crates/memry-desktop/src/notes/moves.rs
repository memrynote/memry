//! A note renamed or moved in the app (`renameNote` and `moveNote`, `vault/notes-rename.ts`).
//! A rename gives the note a new title and its file the name that title makes, in the same
//! folder. A move puts the file, under its name, in another folder. The bytes stay as they
//! are: the title lives in the record.
//!
//! In the note's write order, and under the rows' lane for the whole step, so no watcher fact
//! for either path lands in between:
//! 1. the target: the first free `<name>.md`, `<name> 1.md`, ... that no other note holds under
//!    any spelling the volume may fold and nothing on disk is at. The note's own file under
//!    another spelling is free: a rename that changes only case respells it in place, and a move
//!    to the note's own folder moves nothing. Both diverge from Electron on purpose: its
//!    `generateUniquePath` finds the note's own file taken and numbers it (`Plan 1.md`);
//! 2. the move recorded in the core, then the file moved without replacing anything and synced
//!    into its folders, the own-write record told first that the old name goes and that the
//!    new name holds a markdown note's bytes, so the watcher never takes the move for a delete
//!    and a new file ([`NoteFileMove`]);
//! 3. the record, the row and the manual slot, in one core transaction that also forgets the
//!    record of step 2 ([`Lane::move_by_app`]): the title given and the new folder, the new
//!    path, and the slot carried (a rename) or the new folder's first (a move). A move that
//!    changes what the file is (a note into a journal day's path) leaves the record as it was,
//!    title included, owed the move, which the next open's walk makes (Step 13m-6: the record
//!    deleted and the file made anew, as the watcher's move does);
//! 4. [`Applied::Renamed`], under the lane, for whatever follows the rows (the note index, the
//!    shell's note events): [`MoveKind::Renamed`] for a rename, [`MoveKind::Moved`] for a
//!    move. A rename whose file keeps its name (a title its name already says) sends it with
//!    the same old and new path;
//! 5. once the note's turn ended, a markdown note moved to another folder has its relative
//!    embeds re-pointed from there (`rewriteNoteRefsForMove`), in its own next turn (the answer
//!    says why when they could not be: [`MovedNoteView::refs_kept`]), and the links to it in
//!    other notes' files follow its new title or path, each in its own note's turn
//!    ([`super::link_rewrite`]). A move that changed what the file is changed no name a link
//!    spells, and repairs none.
//!
//! Step 5 has no durable record: a crash between the move and its repairs leaves them undone,
//! as in Electron. The moved note's own refs are not replayable blindly either (the arithmetic
//! is not idempotent), so a replayed record (#3886) must store which repairs ran.
//!
//! A failed step 3 moves the file back and forgets the record of the move. A crash between 2 and
//! 3 leaves the file at its new name, its row at the old one and the record of the move, which
//! the next open finishes before its watcher starts
//! ([`crate::vault::app_move::finish_interrupted`]), with the title given. That is the one path
//! for a markdown note and a file note (PDF, image) alike.
//!
//! Also refused: a folder that is not a plain path of the vault ([`is_plain_relative`], each
//! segment one name), one the vault ignores, so the note would drop out of it at the next open,
//! a folder reached through a link, which the open walk does not enter for the same reason, and
//! a folder path a file already holds. A folder its parent holds in another case or Unicode
//! form (`WORK` for `work/`) is named as the disk spells it, on every volume: the record, the
//! row and the sidebar name the folder the file lands in on a disk that folds case, and a
//! case-sensitive one makes no second spelling for those disks to receive (Electron records
//! the spelling given; `create_folder` refuses one).
//!
//! A locked note, or a note in a locked folder, is neither renamed nor moved, and no note moves
//! into a locked folder (`assertNoteWritable`, `assertFolderWritable`): refused before anything
//! is written ([`Locks`]).

use std::fs;
use std::io::{self, ErrorKind};
use std::path::Path;

use memry_core::api::errors::StorageError;
use memry_core::domain::notes::app_move::AppMoved;
use memry_core::domain::notes::link_rewrite::LinkNames;

use super::error::NotesError;
use super::folders::{Sibling, sibling_named};
use super::read;
use super::service::NotesService;
use super::view::{MovedNoteView, NoteView};
use crate::locks::Locks;
use crate::session::OpenVault;
use crate::shell::file_open::{Resolution, is_plain_relative};
use crate::vault::app_move::{NoteFileMove, on_disk};
use crate::vault::config::read_vault_config;
use crate::vault::consumer::identity::{IdentityCtx, IdentityError};
use crate::vault::consumer::rows::Lane;
use crate::vault::consumer::{Applied, MoveKind};
use crate::vault::file_move::is_respelling;
use crate::vault::file_types::FileType;
use crate::vault::path_key::folded_key;
use crate::vault::paths::{
    is_reserved_windows_name, resolve_vault_file, sanitize_filename, sanitize_new_filename,
};
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
        self.move_note(open, note_id, MoveTo::Title(title), &mut || Ok(()))
            .map(|moved| moved.note)
    }

    pub fn move_to_folder(
        &self,
        open: &OpenVault,
        note_id: &str,
        folder: &str,
    ) -> Result<MovedNoteView, NotesError> {
        self.move_note(open, note_id, MoveTo::Folder(folder), &mut || Ok(()))
    }

    /// Test hook: [`Self::rename`] and [`Self::move_to_folder`], with `after_file` run once the
    /// file moved, before the record and row follow it, so a test can fail or cut the step there.
    #[cfg(feature = "test-hooks")]
    #[doc(hidden)]
    pub fn move_checked(
        &self,
        open: &OpenVault,
        note_id: &str,
        to: MoveTo<'_>,
        after_file: &mut dyn FnMut() -> Result<(), NotesError>,
    ) -> Result<MovedNoteView, NotesError> {
        self.move_note(open, note_id, to, after_file)
    }

    fn move_note(
        &self,
        open: &OpenVault,
        note_id: &str,
        to: MoveTo<'_>,
        after_file: &mut dyn FnMut() -> Result<(), NotesError>,
    ) -> Result<MovedNoteView, NotesError> {
        if let MoveTo::Title(title) = to {
            let units = title.encode_utf16().count();
            if units == 0 || units > MAX_TITLE_UNITS {
                return Err(NotesError::InvalidTitle);
            }
        }
        let followed = self
            .order
            .run(note_id, |_| self.move_now(open, note_id, to, after_file))?;
        let refs_kept = followed.and_then(|(from, to)| {
            let kept = self.rewrite_own_refs(open, note_id, &from, &to);
            self.rewrite_inbound(open, note_id, &from, &to);
            kept
        });
        let note = read::get(open, note_id, None)?
            .ok_or_else(|| NotesError::NotFound(note_id.to_owned()))?;
        Ok(MovedNoteView { note, refs_kept })
    }

    /// Moves the note; the names a link spelled it by before and after, with its paths, when
    /// they may differ.
    fn move_now(
        &self,
        open: &OpenVault,
        note_id: &str,
        to: MoveTo<'_>,
        after_file: &mut dyn FnMut() -> Result<(), NotesError>,
    ) -> Result<Option<(Named, Named)>, NotesError> {
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
        let locks = Locks::of(open);
        locks.refuse_note(note_id, &old)?;
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
        if let MoveTo::Folder(_) = to {
            // The folder as the disk spells it, the one the file lands in: `ARCHIVE` names a
            // locked `Archive` ([`folder_on_disk`]).
            locks.refuse_folder(new.rsplit_once('/').map_or("", |(folder, _)| folder))?;
        }
        let ctx = IdentityCtx {
            root,
            vault: &open.vault,
            search: &open.search,
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
            return Ok(None);
        }
        let echo = self.tier.echo();
        let file = (new != old).then(|| NoteFileMove {
            echo: &echo,
            root,
            old: &old,
            new: &new,
            hash: row
                .file_hash
                .as_deref()
                .filter(|_| row.file_type == FileType::Markdown.as_str()),
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
        let markdown = row.file_type == FileType::Markdown.as_str();
        let names = |title: &str, path: &str| Named {
            path: path.to_owned(),
            link: LinkNames {
                title: title.to_owned(),
                folder: path.rsplit_once('/').map(|(folder, _)| folder.to_owned()),
                markdown,
            },
        };
        let renamed = keeps_kind.then(|| {
            let to = names(moved.title.unwrap_or(&listed.title), &new);
            (names(&listed.title, &old), to)
        });
        lane.publish(Applied::Renamed {
            note_id: note_id.to_owned(),
            old_path: old,
            new_path: new,
            kind: match to {
                MoveTo::Title(_) => MoveKind::Renamed,
                MoveTo::Folder(_) => MoveKind::Moved,
            },
        });
        Ok(renamed)
    }
}

/// A note's path, and the names a link spells it by there.
pub(super) struct Named {
    pub path: String,
    pub link: LinkNames,
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
pub(super) fn plain_folder(folder: &str) -> Result<String, NotesError> {
    let segments: Vec<&str> = folder
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect();
    // Windows strips a trailing dot or space, so no folder there ends in one: `x.` would be
    // created as `x` while the record says `x.`. Nor is a device name (`con`, `nul.x`) one.
    let windows_refuses = |segment: &str| {
        let stem = segment.split('.').next().unwrap_or(segment);
        segment.ends_with(['.', ' ']) || is_reserved_windows_name(stem.trim_end_matches(' '))
    };
    let one_name = |segment: &&str| {
        is_plain_relative(segment)
            && Path::new(segment).components().count() == 1
            && !(cfg!(windows) && windows_refuses(segment))
    };
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
    let folder = match folder {
        "" => String::new(),
        folder => {
            let OnDisk::Spelled(folder) = folder_on_disk(root, folder)? else {
                return Err(NotesError::InvalidFolder);
            };
            if resolve_vault_file(root, &folder)? == Resolution::Outside {
                return Err(NotesError::Outside);
            }
            folder
        }
    };
    let filter = WatchFilter::new(read_vault_config(root).exclude_patterns);
    let rel = |name: &str| match folder.as_str() {
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

/// `folder` as the disk spells it ([`folder_on_disk`]), or as given when the disk cannot say:
/// what a lock check compares, since the operation lands on the disk's spelling.
pub(super) fn disk_spelling(root: &Path, folder: &str) -> String {
    if folder.is_empty() {
        return String::new();
    }
    match folder_on_disk(root, folder) {
        Ok(OnDisk::Spelled(spelled)) => spelled,
        _ => folder.to_owned(),
    }
}

/// Whether each segment of `folder` that is there is a plain folder ([`folder_on_disk`]).
pub(super) fn plain_folders(root: &Path, folder: &str) -> io::Result<bool> {
    Ok(!matches!(folder_on_disk(root, folder)?, OnDisk::NotPlain))
}

/// A folder path as the disk holds it ([`folder_on_disk`]).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OnDisk {
    /// As the disk spells it.
    Spelled(String),
    /// A segment is a link or a file.
    NotPlain,
    /// A segment names no entry exactly and several in case only ([`Sibling::Several`]).
    Ambiguous,
}

/// `folder` as the disk spells it, when each segment that is there is a plain folder: not a
/// link (a junction on Windows), which the open walk does not enter, so a note moved under one
/// would read as removed at the next open, and not a file, which the move could not create the
/// folder over. A segment its parent holds in another case or Unicode form takes that spelling
/// on every volume ([`sibling_named`], the rule `create_folder` refuses a second spelling by),
/// unless it holds several such and none spelled as given, which names none of them; the
/// segments not there yet stay as given.
pub(crate) fn folder_on_disk(root: &Path, folder: &str) -> io::Result<OnDisk> {
    let mut path = root.to_path_buf();
    let mut spelled = Vec::new();
    let mut segments = folder.split('/');
    for segment in segments.by_ref() {
        let listed = match sibling_named(&path, segment)? {
            Sibling::Named(listed) => listed,
            Sibling::Several => return Ok(OnDisk::Ambiguous),
            Sibling::Missing => {
                spelled.push(segment.to_owned());
                break;
            }
        };
        path.push(&listed);
        spelled.push(listed);
        match fs::symlink_metadata(&path) {
            Ok(meta) if !meta.file_type().is_dir() => return Ok(OnDisk::NotPlain),
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => break,
            Err(error) => return Err(error),
        }
    }
    spelled.extend(segments.map(str::to_owned));
    Ok(OnDisk::Spelled(spelled.join("/")))
}

pub(crate) fn identity_failed(error: IdentityError) -> NotesError {
    match error {
        IdentityError::Storage(error) => NotesError::Storage(error),
        IdentityError::Other(what) => NotesError::Storage(StorageError::Failed { what }),
    }
}
