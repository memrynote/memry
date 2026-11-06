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
//! leaves them, and the next open runs step 3 for the folder when it moved on disk
//! ([`crate::vault::app_move::finish_interrupted`]), after the open's sweep put back any
//! entry-wise move it cut short (`vault::move_journal`). Until then each moved file is its
//! note's, never a new one (`notes::identity`'s `moving`): the records name its new path. A note the move makes another kind of
//! file (a note into a journal day's path) is left owed, as by its own move; Electron left it to
//! the watcher.
//!
//! The journal folder, or a folder holding it, takes the journal setting along
//! (`followJournalFolderMove`), so each day moves as a day: the move holds the settings' locks
//! before the lane ([`JournalFollow`]), reads each file's kind under the setting before and after
//! (`keeps_kind_followed`: a note a date names stays that note), and saves the new folder once
//! the folder is on disk, before step 3. The setting follows the disk: a failed step 3 moves the
//! folder back only once the old folder is saved again, and a folder that stays moved keeps (or
//! has saved again) the new one, which every window hears. A crash before the save is finished by
//! the next open (`vault::app_move::follow_interrupted`). Such a folder moves by the plain rename
//! only ([`move_dir::move_dir_whole_checked`]): one Windows holds is refused as it is, since a
//! rollback of an entry-wise move could leave days in `(incomplete move)`, outside every journal
//! folder. A settings file that cannot be read refuses every folder move
//! (`vault_settings_unreadable`): it does not say where the journal is, or whether it follows.
//!
//! Refused: a folder that is not there (`folder_not_found`, #2531's stale sidebar), a target that
//! exists under any spelling but the folder's own (`name_conflict`), and one inside the folder, one
//! the tree hides, the vault ignores, a link leads to, or no record can name (`invalid_folder`),
//! a folder that is locked, sits in a locked folder or holds a lock, and a target inside a locked
//! folder (`folder_locked`, `assertFolderTreeWritable`, `assertParentFolderWritable`).
//! Not here yet: the shortcuts and Readwise targets that name
//! the folder (`followFolderRenameInShortcuts`, `followFolderRenameInReadwise`), which have no
//! Tauri port yet.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Component, Path};

use memry_core::domain::folders::valid_path;
use memry_core::domain::notes::app_move::AppMoved;
use memry_core::domain::notes::link_rewrite::LinkNames;

use super::error::{NotesError, SCOPE};
use super::folders::{respells_a_sibling, tree_filter, vault_folder};
use super::moves::{Named, disk_spelling, identity_failed, plain_folders};
use super::owed_moves::keeps_kind_followed;
use super::service::NotesService;
use crate::journal::folder_follow::followed_journal_folder;
use crate::locks::Locks;
use crate::session::OpenVault;
use crate::vault::app_move::on_disk;
use crate::vault::config::settings::JournalFollow;
use crate::vault::config::{VaultConfig, read_vault_config, read_vault_config_strict};
use crate::vault::consumer::identity::IdentityCtx;
use crate::vault::consumer::rows::Lane;
use crate::vault::consumer::{Applied, MoveKind};
use crate::vault::file_types::FileType;
use crate::vault::journal_format::JournalDays;
use crate::vault::journal_format::normalize_journal_folder;
use crate::vault::journal_rename::{JournalVault, finish_journal_change};
use crate::vault::move_dir::{self, IncompleteRollback, Step};
use crate::vault::move_journal::STAGING_PREFIX;
use crate::vault::path_key::folded_key;
use crate::vault::watch::filter::WatchFilter;

mod echo;

use echo::TreeRecord;

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

/// The journal setting a move of the folder holding the journal takes along (module doc).
struct Follow<'a> {
    settings: &'a JournalFollow,
    /// The journal folder before the move and after it.
    folders: (String, String),
    /// The days as the setting before the move reads them, and after it.
    days: (JournalDays, JournalDays),
}

impl Follow<'_> {
    fn save(&self, root: &Path, folder: &str) -> Result<VaultConfig, NotesError> {
        self.settings
            .save(root, folder)
            .map_err(|error| NotesError::Io(io::Error::other(error.to_string())))
    }
}

impl NotesService {
    /// Moves the folder `old` to `new`; `announce` hears the settings when the journal setting
    /// followed it.
    pub fn rename_folder(
        &self,
        open: &OpenVault,
        old: &str,
        new: &str,
        announce: impl FnOnce(&VaultConfig),
    ) -> Result<(), NotesError> {
        self.rename_folder_checked(open, old, new, announce, &mut |_| Ok(()), &mut || Ok(()))
    }

    /// [`Self::rename_folder`] with a hook before each step of the move on disk, and one once
    /// the folder moved (and a journal setting that follows it was saved), before the notes
    /// follow it, so a test can fail either.
    #[doc(hidden)]
    pub fn rename_folder_checked(
        &self,
        open: &OpenVault,
        old: &str,
        new: &str,
        announce: impl FnOnce(&VaultConfig),
        step: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
        after_disk: &mut dyn FnMut() -> Result<(), NotesError>,
    ) -> Result<(), NotesError> {
        let root = open.path.as_path();
        let (from, to) = (vault_folder(root, old)?, vault_folder(root, new)?);
        // Nothing locked moves with the folder, and nothing moves into a locked one.
        // Each as the disk spells it: `ARCHIVE` names a locked `Archive`.
        let locks = Locks::of(open);
        locks.refuse_folder_tree(&disk_spelling(root, &from))?;
        locks.refuse_parent_folder(&disk_spelling(root, &to))?;
        if from == to {
            return Ok(());
        }
        // Before the lane: the settings' locks come first (`settings`'s lock order).
        let settings = JournalFollow::hold();
        // The days of a journal setting change a crash cut short go back first; while they
        // wait, no move takes either of its folders (`vault::journal_rename`).
        let at = JournalVault {
            root,
            vault: &open.vault,
            tier: &self.tier,
        };
        if finish_journal_change(at, &settings).is_some_and(|waits| waits.holds(&from)) {
            return Err(NotesError::JournalChangeWaits);
        }
        // Settings that cannot be read do not say where the journal is, so no folder moves:
        // one that held it would leave every day outside the journal, to be deleted.
        let config = read_vault_config_strict(root).map_err(NotesError::SettingsUnreadable)?;
        let follow =
            followed_journal_folder(&config.journal_folder, &from, &to).map(|followed| Follow {
                settings: &settings,
                days: (
                    JournalDays::new(&config.journal_folder, &config.journal_date_format),
                    JournalDays::new(&followed, &config.journal_date_format),
                ),
                folders: (normalize_journal_folder(&config.journal_folder), followed),
            });
        check(root, &from, &to)?;
        let mut saved = None;
        let carried = self.carry(
            open,
            (&from, &to),
            follow.as_ref(),
            &mut saved,
            step,
            after_disk,
        );
        if let Some(saved) = saved {
            tracing::info!(scope = SCOPE, "the journal folder followed a folder move");
            announce(&saved);
        }
        drop(follow);
        drop(settings);
        let carried = carried?;
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

    /// Steps 1 to 4, under the lane, the journal setting saved between 2 and 3 when it follows;
    /// `saved` is left with the settings when the journal folder the move leaves stays saved.
    fn carry(
        &self,
        open: &OpenVault,
        (from, to): (&str, &str),
        follow: Option<&Follow<'_>>,
        saved: &mut Option<VaultConfig>,
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
            let keeps_kind = match follow {
                Some(Follow { days, .. }) => {
                    keeps_kind_followed(days, &writer, &note_id, (&old, &new))
                }
                None => identity.keeps_kind(&ctx, &note_id, &new),
            }
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
        let moved = match follow {
            Some(_) => move_dir::move_dir_whole_checked(root, &source, &target, step),
            None => move_dir::move_dir_checked(root, &source, &target, step),
        };
        if let Err(error) = moved {
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
        let followed = follow
            .map_or(Ok(()), |follow| {
                *saved = Some(follow.save(root, &follow.folders.1)?);
                Ok(())
            })
            .and_then(|()| after_disk())
            .and_then(|()| Ok(lane.folder_moved_by_app(&writer, from, to, &moves)?));
        if let Err(error) = followed {
            // The setting follows the disk: the folder goes back only once the old folder is
            // saved again, and one that cannot go back has the new folder saved again. Left
            // moved, the records of the move stay, and the next open finishes it.
            if let Some(follow) = follow
                && saved.is_some()
            {
                match follow.save(root, &follow.folders.0) {
                    Ok(_) => *saved = None,
                    Err(kept) => {
                        tracing::error!(
                            scope = SCOPE,
                            "the journal folder stays moved, its setting could not go back: {kept}"
                        );
                        return Err(error);
                    }
                }
            }
            echo.will_remove(to);
            let back = match follow {
                Some(_) => move_dir::move_dir_whole_checked(root, &target, &source, step),
                None => move_dir::move_dir(root, &target, &source),
            };
            match back {
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
                Err(back) => {
                    tracing::error!(
                        scope = SCOPE,
                        "a folder could not go back after its notes did not follow it: {back}"
                    );
                    echo.cancel_removal(to);
                    if let Some(follow) = follow {
                        *saved = follow
                            .save(root, &follow.folders.1)
                            .inspect_err(|kept| {
                                tracing::error!(
                                    scope = SCOPE,
                                    "the journal setting waits for the next open to follow its \
                                     folder: {kept}"
                                );
                            })
                            .ok();
                    }
                }
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
