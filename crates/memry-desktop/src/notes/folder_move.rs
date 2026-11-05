//! A folder renamed or moved in the app (`renameFolder` of `vault/notes-crud.ts` and
//! `renameFolderCommand` of `notes/domain.ts`): the sidebar's rename and its drag of a folder
//! onto another, both one `oldPath` to `newPath`.
//!
//! Each note in the folder moves as a note moved in the app does (`notes::moves`), all of them
//! in one step under the rows' lane, so no watcher fact and no write-back pass lands in between:
//! 1. the folder's move and every note's are recorded in the core, all or none
//!    ([`Lane::begin_folder_move`]): the next open finishes or forgets them, file notes (PDF,
//!    image) included, whose rows have no hash a moved file could pair on;
//! 2. the own-write record is told that the folder goes with everything below it
//!    ([`EchoGuard::will_remove_tree`]), so the watcher never takes the move for deletes and new
//!    files; then the folder moves on disk without
//!    replacing anything ([`move_dir`], whole, or entry by entry where Windows holds a file
//!    beneath it open, #2206);
//! 3. every record and row, the folder's `folder_config` records and its manual order follow,
//!    in one core transaction that forgets the move records of step 1
//!    ([`Lane::folder_moved_by_app`]). The folder's `.folder.md` moved with it;
//! 4. [`Applied::Renamed`] with [`MoveKind::Moved`] for each note, under the lane: the renderer
//!    hears `notes:moved` per note, as Electron's `moveIndexedNotesWithFolder` sends one `MOVED`
//!    per note;
//! 5. once the lane is free, the path-form links to each note (`[[Old/Note]]`) follow its new
//!    folder ([`super::link_rewrite`]), as Electron's `rewriteInboundWikiLinks` does. A moved
//!    note's own relative links to notes outside the folder are left as they are, as in Electron.
//!
//! A failed step 3 moves the folder back and forgets the records. A crash between 2 and 3
//! leaves them, and the next open runs step 3 for the folder when it is at `to` and gone from
//! `from` ([`crate::vault::app_move::finish_interrupted`]), after the open's sweep put back any
//! entry-wise move it cut short (`vault::move_journal`). A note the move makes another kind of
//! file (a note into a journal day's path) is left owed, as by its own move; Electron left it to
//! the watcher.
//!
//! Refused: a folder that is not there (`folder_not_found`, #2531's stale sidebar), a target that
//! exists under any spelling but the folder's own (`name_conflict`), one inside the folder, one the
//! tree hides, the vault ignores, a link leads to, or no record can name (`invalid_folder`), and
//! moving the journal folder or a folder holding it (`folder_holds_journal`): its setting would
//! have to follow, which waits for the settings port. Not here yet: the locked-folder check (Step
//! 14), the shortcuts and Readwise targets that name the folder (`followFolderRenameInShortcuts`,
//! `followFolderRenameInReadwise`), which have no Tauri port yet.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Component, Path};

use memry_core::domain::folders::valid_path;
use memry_core::domain::notes::app_move::AppMoved;
use memry_core::domain::notes::link_rewrite::LinkNames;

use super::error::{NotesError, SCOPE};
use super::folders::{respells_a_sibling, tree_filter, vault_folder};
use super::moves::{Named, identity_failed, plain_folders};
use super::service::NotesService;
use crate::session::OpenVault;
use crate::vault::app_move::on_disk;
use crate::vault::config::read_vault_config;
use crate::vault::consumer::identity::IdentityCtx;
use crate::vault::consumer::rows::Lane;
use crate::vault::consumer::{Applied, MoveKind};
use crate::vault::file_types::FileType;
use crate::vault::move_dir::{self, IncompleteRollback, Step};
use crate::vault::move_journal::STAGING_PREFIX;
use crate::vault::path_key::folded_key;
use crate::vault::watch::EchoGuard;
use crate::vault::watch::filter::WatchFilter;

/// A note the folder carries, vault-relative paths with `/`.
struct Carried {
    note_id: String,
    old: String,
    new: String,
    title: String,
    markdown: bool,
    keeps_kind: bool,
}

impl Carried {
    fn moved(&self) -> (&str, AppMoved<'_>) {
        let moved = AppMoved {
            old_path: &self.old,
            new_path: &self.new,
            title: None,
            keeps_kind: self.keeps_kind,
        };
        (&self.note_id, moved)
    }
}

impl NotesService {
    pub fn rename_folder(&self, open: &OpenVault, old: &str, new: &str) -> Result<(), NotesError> {
        self.rename_folder_checked(open, old, new, &mut |_| Ok(()), &mut || Ok(()))
    }

    /// [`Self::rename_folder`] with a hook before each step of the move on disk, and one once
    /// the folder moved, before the notes follow it, so a test can fail either.
    #[doc(hidden)]
    pub fn rename_folder_checked(
        &self,
        open: &OpenVault,
        old: &str,
        new: &str,
        step: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
        after_disk: &mut dyn FnMut() -> Result<(), NotesError>,
    ) -> Result<(), NotesError> {
        let root = open.path.as_path();
        let (from, to) = (vault_folder(root, old)?, vault_folder(root, new)?);
        if from == to {
            return Ok(());
        }
        check(root, &from, &to)?;
        let carried = self.carry(open, &from, &to, step, after_disk)?;
        for note in carried.iter().filter(|note| note.keeps_kind) {
            let names = |path: &str| Named {
                path: path.to_owned(),
                link: LinkNames {
                    title: note.title.clone(),
                    folder: path.rsplit_once('/').map(|(folder, _)| folder.to_owned()),
                    markdown: note.markdown,
                },
            };
            self.rewrite_inbound(open, &note.note_id, &names(&note.old), &names(&note.new));
        }
        Ok(())
    }

    /// Steps 1 to 4, under the lane.
    fn carry(
        &self,
        open: &OpenVault,
        from: &str,
        to: &str,
        step: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
        after_disk: &mut dyn FnMut() -> Result<(), NotesError>,
    ) -> Result<Vec<Carried>, NotesError> {
        let root = open.path.as_path();
        let rows = self.tier.rows();
        let session = rows.session_for(&open.vault)?;
        let writer = open.vault.notes_writer(self.store.clone())?;
        let identity = self.tier.identity();
        let ctx = IdentityCtx {
            root,
            vault: &open.vault,
            search: &open.search,
        };
        let mut lane = rows.lane_of(session)?;
        let mut carried = Vec::new();
        for (note_id, old) in lane.files().list_paths()? {
            let Some(rest) = old
                .strip_prefix(from)
                .and_then(|rest| rest.strip_prefix('/'))
            else {
                continue;
            };
            let new = format!("{to}/{rest}");
            if lane.check(&note_id, &new).is_err() {
                return Err(NotesError::NameConflict);
            }
            let Some(row) = lane.files().by_id(&note_id)? else {
                continue;
            };
            let title = lane
                .files()
                .listed_by_id(&note_id)?
                .map(|listed| listed.title)
                .unwrap_or_default();
            let keeps_kind = identity
                .keeps_kind(&ctx, &note_id, &new)
                .map_err(identity_failed)?;
            carried.push(Carried {
                markdown: row.file_type == FileType::Markdown.as_str(),
                note_id,
                old,
                new,
                title,
                keeps_kind,
            });
        }
        // A pattern with a slash (`vendor/cache`) can ignore a note's new path below a target it
        // does not ignore: the next open would drop that note.
        let filter = WatchFilter::new(read_vault_config(root).exclude_patterns);
        if carried.iter().any(|note| filter.ignores(&note.new)) {
            return Err(NotesError::InvalidFolder);
        }
        let moves: Vec<(&str, AppMoved<'_>)> = carried.iter().map(Carried::moved).collect();
        lane.begin_folder_move(&writer, from, to, &moves)?;
        let echo = self.tier.echo();
        let mut tree = TreeRecord::new(&echo, root, from, &carried);
        let (source, target) = (on_disk(root, from), on_disk(root, to));
        if let Err(error) = move_dir::move_dir_checked(root, &source, &target, step) {
            let mut undo = Undo {
                lane: &mut lane,
                writer: &writer,
                root,
            };
            undo.forget((from, to), &moves);
            tree.narrow();
            if let Some(incomplete) = IncompleteRollback::of(&error) {
                undo.keep_aside(&ctx, &*identity, from, &carried, incomplete);
                return Err(NotesError::FolderMoveIncomplete);
            }
            return Err(match error.kind() {
                ErrorKind::AlreadyExists => NotesError::NameConflict,
                ErrorKind::NotFound => NotesError::FolderNotFound,
                ErrorKind::InvalidInput => NotesError::InvalidFolder,
                _ => error.into(),
            });
        }
        tree.settle();
        let followed =
            after_disk().and_then(|()| Ok(lane.folder_moved_by_app(&writer, from, to, &moves)?));
        if let Err(error) = followed {
            echo.will_remove(to);
            match move_dir::move_dir(root, &target, &source) {
                Ok(()) => {
                    Undo {
                        lane: &mut lane,
                        writer: &writer,
                        root,
                    }
                    .forget((from, to), &moves);
                    tree.narrow();
                }
                // The folder's record and each note's stay, and the next open finishes the move.
                Err(back) => tracing::error!(
                    scope = SCOPE,
                    "a folder could not go back after its notes did not follow it: {back}"
                ),
            }
            return Err(error);
        }
        for note in &carried {
            lane.publish(Applied::Renamed {
                note_id: note.note_id.clone(),
                old_path: note.old.clone(),
                new_path: note.new.clone(),
                kind: MoveKind::Moved,
            });
        }
        drop(tree);
        Ok(carried)
    }
}

/// Every path the move takes away that the watcher could take for a note's removal: each
/// note's file, each folder that holds one below `from`, and `from`.
fn carried_paths(from: &str, carried: &[Carried]) -> Vec<String> {
    let mut folders = std::collections::BTreeSet::new();
    for note in carried {
        let mut path = note.old.as_str();
        while let Some((folder, _)) = path.rsplit_once('/')
            && folder.len() > from.len()
        {
            folders.insert(folder.to_owned());
            path = folder;
        }
    }
    let notes = carried.iter().map(|note| note.old.clone());
    notes
        .chain(folders.into_iter().rev())
        .chain([from.to_owned()])
        .collect()
}

/// The own-write record of the folder's going ([`EchoGuard::will_remove_tree`]) for the length of
/// a move: settled once the folder is gone ([`Self::settle`]), narrowed to what is still gone
/// when the move did not happen ([`Self::narrow`]), and narrowed on drop when neither ran, a
/// panic included, so no unsettled record outlives the move and absorbs later deletes.
struct TreeRecord<'a> {
    echo: &'a EchoGuard,
    root: &'a Path,
    from: &'a str,
    carried: &'a [Carried],
    done: bool,
}

impl<'a> TreeRecord<'a> {
    fn new(echo: &'a EchoGuard, root: &'a Path, from: &'a str, carried: &'a [Carried]) -> Self {
        echo.will_remove_tree(from);
        Self {
            echo,
            root,
            from,
            carried,
            done: false,
        }
    }

    fn settle(&mut self) {
        self.echo.removed_tree(self.from);
        self.done = true;
    }

    /// Keeps a record of each path not back on disk (a hidden staging folder may hold them
    /// until the next open's sweep): the absence of one that is back is not the app's.
    fn narrow(&mut self) {
        let root = self.root;
        let still_gone = carried_paths(self.from, self.carried)
            .into_iter()
            .filter(|path| fs::symlink_metadata(on_disk(root, path)).is_err());
        self.echo.narrow_tree(self.from, still_gone);
        self.done = true;
    }
}

impl Drop for TreeRecord<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.narrow();
        }
    }
}

/// What a move that did not happen undoes, under the lane.
struct Undo<'a, 'l> {
    lane: &'a mut Lane<'l>,
    writer: &'a memry_core::api::notes_write::NotesWriter,
    root: &'a Path,
}

impl Undo<'_, '_> {
    /// Forgets the folder's and each note's record of the move.
    fn forget(&mut self, (from, to): (&str, &str), moves: &[(&str, AppMoved<'_>)]) {
        if let Err(error) = self.lane.forget_folder_move(self.writer, from, to) {
            tracing::warn!(
                scope = SCOPE,
                "the record of an undone folder move waits for the next open: {error}"
            );
        }
        for (note_id, moved) in moves {
            if let Err(error) =
                self.lane
                    .forget_move(self.writer, note_id, moved.old_path, moved.new_path)
            {
                tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    "the record of an undone folder move waits for the next open: {error}"
                );
            }
        }
    }

    /// A rollback that left files in the visible `<name> (incomplete move)` folder: each note
    /// whose file waits there follows it, so the file is not taken for a new note and the note
    /// for a removed one. What waits in the hidden staging folder is put back by the next
    /// open's sweep, its rows untouched.
    fn keep_aside(
        &mut self,
        ctx: &IdentityCtx<'_>,
        identity: &dyn crate::vault::consumer::identity::NoteIdentity,
        from: &str,
        carried: &[Carried],
        incomplete: &IncompleteRollback,
    ) {
        let visible = incomplete.kept.iter().filter(|kept| {
            kept.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| !name.starts_with(STAGING_PREFIX))
        });
        let Some(kept) = visible.filter_map(|kept| vault_rel(self.root, kept)).next() else {
            return;
        };
        for note in carried {
            if fs::symlink_metadata(on_disk(self.root, &note.old)).is_ok() {
                continue;
            }
            let new = format!("{kept}{}", &note.old[from.len()..]);
            if fs::symlink_metadata(on_disk(self.root, &new)).is_err() {
                continue;
            }
            let keeps_kind = identity
                .keeps_kind(ctx, &note.note_id, &new)
                .unwrap_or(false);
            let moved = AppMoved {
                old_path: &note.old,
                new_path: &new,
                title: None,
                keeps_kind,
            };
            match self.lane.move_by_app(self.writer, &note.note_id, moved) {
                Ok(()) => self.lane.publish(Applied::Renamed {
                    note_id: note.note_id.clone(),
                    old_path: note.old.clone(),
                    new_path: new,
                    kind: MoveKind::Moved,
                }),
                Err(error) => tracing::error!(
                    scope = SCOPE,
                    note_id = note.note_id,
                    "a note whose file a failed folder move left aside did not follow it: {error}"
                ),
            }
        }
    }
}

/// The checks before anything moves (module doc).
fn check(root: &Path, from: &str, to: &str) -> Result<(), NotesError> {
    if from.is_empty() || to.is_empty() {
        return Err(NotesError::InvalidFolder);
    }
    let config = read_vault_config(root);
    // Before the tree's filter, which hides the journal folder unless the sidebar shows it.
    if !config.journal_folder.is_empty() && within(&config.journal_folder, from) {
        return Err(NotesError::FolderHoldsJournal);
    }
    let shown = tree_filter(root);
    let hidden =
        |folder: &str| folder.split('/').any(|segment| segment.starts_with('.')) || !shown(folder);
    // A folder the vault ignores drops the notes moved into it at the next open.
    let ignored = WatchFilter::new(config.exclude_patterns).ignores(to);
    if hidden(from) || hidden(to) || ignored || valid_path(to).is_err() {
        return Err(NotesError::InvalidFolder);
    }
    // A folder reached through a link is one the open walk does not enter.
    if !plain_folders(root, from)? || !plain_folders(root, to)? {
        return Err(NotesError::InvalidFolder);
    }
    match fs::symlink_metadata(on_disk(root, from)) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(NotesError::InvalidFolder),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(NotesError::FolderNotFound);
        }
        Err(error) => return Err(error.into()),
    }
    // A respelling of the folder's own name only: its parent, which the move does not own,
    // stays as it is spelled.
    let parent = |path: &str| path.rsplit_once('/').map(|(parent, _)| parent.to_owned());
    let case_only = folded_key(from) == folded_key(to) && parent(from) == parent(to);
    if !case_only && within(&folded_key(to), &folded_key(from)) {
        return Err(NotesError::InvalidFolder);
    }
    if let Some((parent, _)) = to.rsplit_once('/')
        && !on_disk(root, parent).is_dir()
    {
        return Err(NotesError::FolderNotFound);
    }
    if !case_only
        && (respells_a_sibling(root, to)? || fs::symlink_metadata(on_disk(root, to)).is_ok())
    {
        return Err(NotesError::NameConflict);
    }
    Ok(())
}

/// Whether `path` is `root` or sits under it.
pub(super) fn within(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// `path` under `root`, vault-relative with `/`; `None` for one that is not, or not UTF-8.
fn vault_rel(root: &Path, path: &Path) -> Option<String> {
    let segments: Option<Vec<&str>> = path
        .strip_prefix(root)
        .ok()?
        .components()
        .map(|component| match component {
            Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .collect();
    segments.map(|segments| segments.join("/"))
}
