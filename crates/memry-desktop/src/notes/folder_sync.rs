//! A folder another device made, changed or deleted, mirrored into this vault (#3906, Step 13h),
//! after `folder-config-handler.ts` and `deleted-folder-prune.ts`. The record is already applied
//! when these run: the sync engine (Step 17, #3534) calls them after a pulled `folder_config` or
//! a pulled note delete committed, and sends `FolderConfigUpdatedEvent` for each path they name.
//!
//! - [`NotesService::apply_remote_folder`]: the record's icon goes into the folder's
//!   `.folder.md`, which keeps its views, template and every other key (`writeMergedFolderConfig`).
//!   A folder that is not here is made: an empty folder made on another device. A file that
//!   cannot be read stays as it is (#720).
//! - [`NotesService::apply_remote_folder_delete`]: a folder still here loses its icon, for when
//!   it stays because it still holds notes, and then goes once it holds nothing worth keeping.
//! - [`NotesService::prune_deleted_folders`]: from a folder up to the vault root, each deleted
//!   folder ([`NotesWriter::folder_deleted`]: no record, a tombstone) that holds nothing worth
//!   keeping is removed ([`empty_folder::remove_if_empty`]). It stops at the first folder that is
//!   not deleted, before or after the quiet wait, still holds a file, or keeps changing. A folder
//!   made in a file manager has no tombstone and is never removed.
//!
//! None of them touches a folder the app keeps out of sync's reach (`remote_folder`): the tree
//! hides it, it is the journal folder or holds or sits in it, or its spelling differs from a
//! sibling's in case only, a folder a case-blind disk would take for that sibling.
//!
//! [`NotesWriter::folder_deleted`]: memry_core::api::notes_write::NotesWriter::folder_deleted

use std::fs;
use std::path::Path;

use super::error::{NotesError, SCOPE};
use super::folder_move::within;
use super::folders::{respells_a_sibling, tree_filter, vault_folder};
use super::moves::plain_folders;
use super::service::NotesService;
use crate::session::OpenVault;
use crate::vault::app_move::on_disk;
use crate::vault::config::read_vault_config;
use crate::vault::empty_folder::{self, Quiet, Removal};
use crate::vault::folder_file;

impl NotesService {
    /// A pulled `folder_config` upsert of the folder at `path`, its icon `icon`.
    pub fn apply_remote_folder(
        &self,
        open: &OpenVault,
        path: &str,
        icon: Option<&str>,
    ) -> Result<(), NotesError> {
        let root = open.path.as_path();
        let Some(folder) = remote_folder(root, path)? else {
            return Ok(());
        };
        fs::create_dir_all(on_disk(root, &folder))?;
        folder_file::update(root, &folder, |file| file.set_icon(icon))?;
        Ok(())
    }

    /// A pulled `folder_config` delete of the folder at `path`: the folders it removed, the
    /// folder first.
    pub fn apply_remote_folder_delete(
        &self,
        open: &OpenVault,
        path: &str,
    ) -> Result<Vec<String>, NotesError> {
        let root = open.path.as_path();
        let Some(folder) = remote_folder(root, path)? else {
            return Ok(Vec::new());
        };
        if fs::symlink_metadata(on_disk(root, &folder)).is_ok_and(|meta| meta.is_dir()) {
            // The folder goes whatever its file says: a file that cannot be read keeps its icon.
            if let Err(error) = folder_file::update(root, &folder, |file| file.set_icon(None)) {
                tracing::warn!(
                    scope = SCOPE,
                    "a deleted folder's file keeps its icon: {error}"
                );
            }
        }
        self.prune_deleted_folders(open, &folder, true)
    }

    /// The deleted folders from `path` up that held nothing worth keeping, removed: the folders
    /// it removed, deepest first. `folder_config_deleted`: the caller applied the delete of
    /// `path`'s record, so it counts as deleted without asking before the wait.
    pub fn prune_deleted_folders(
        &self,
        open: &OpenVault,
        path: &str,
        folder_config_deleted: bool,
    ) -> Result<Vec<String>, NotesError> {
        self.prune_deleted_folders_checked(
            open,
            path,
            folder_config_deleted,
            Quiet::default(),
            &mut |_| {},
        )
    }

    /// [`Self::prune_deleted_folders`] with the quiet window and the wait for it, and a hook that
    /// runs once a folder's wait is over, so a test can act there as another writer would.
    #[doc(hidden)]
    pub fn prune_deleted_folders_checked(
        &self,
        open: &OpenVault,
        path: &str,
        folder_config_deleted: bool,
        quiet: Quiet,
        after_wait: &mut dyn FnMut(&str),
    ) -> Result<Vec<String>, NotesError> {
        let root = open.path.as_path();
        let writer = open.vault.notes_writer(self.store.clone())?;
        let mut current = vault_folder(root, path)?;
        let mut known_deleted = folder_config_deleted;
        let mut removed = Vec::new();
        while remote_folder(root, &current)?.is_some() {
            if !known_deleted && !writer.folder_deleted(&current)? {
                break;
            }
            // The wait gives a pulled upsert or the user time to make the folder again, so it
            // goes only when that did not happen meanwhile. The folder whose delete the caller
            // applied may have no record or tombstone clock here (Electron prunes it all the
            // same, #2512): for it only a live record says it was made again.
            let applied = std::mem::take(&mut known_deleted);
            let mut confirm = || {
                let gone = if applied {
                    !open
                        .vault
                        .notes()
                        .folders()?
                        .iter()
                        .any(|row| row.path == current)
                } else {
                    writer.folder_deleted(&current)?
                };
                Ok::<_, NotesError>(gone)
            };
            let removal =
                empty_folder::remove_if_empty(root, &current, quiet, &mut confirm, &mut || {
                    after_wait(&current)
                })?;
            match removal {
                Removal::Removed => {
                    tracing::info!(scope = SCOPE, "removed a folder deleted on another device");
                    removed.push(current.clone());
                }
                Removal::Missing => {}
                Removal::HoldsFiles {
                    file,
                    removed: below,
                } => {
                    tracing::info!(
                        scope = SCOPE,
                        file,
                        "kept a folder deleted on another device, it still holds files"
                    );
                    removed.extend(below);
                    break;
                }
                Removal::Busy => {
                    tracing::warn!(
                        scope = SCOPE,
                        "kept a folder deleted on another device, its files kept changing"
                    );
                    break;
                }
                Removal::Declined => {
                    tracing::info!(
                        scope = SCOPE,
                        "kept a folder deleted on another device, it was made again"
                    );
                    break;
                }
            }
            current = current
                .rsplit_once('/')
                .map_or_else(String::new, |(parent, _)| parent.to_owned());
        }
        Ok(removed)
    }
}

/// A folder a record names, as a plain path inside the vault, or `None` (logged) for one the
/// app keeps out of sync's reach: the vault root, a folder the tree hides (a dot folder,
/// attachments, canvases, an excluded one), the journal folder, a folder holding it or inside
/// it, and a spelling that differs from a sibling's in case only, which a case-blind disk would
/// take for that sibling.
fn remote_folder(root: &Path, path: &str) -> Result<Option<String>, NotesError> {
    let folder = vault_folder(root, path)?;
    if folder.is_empty() {
        return Ok(None);
    }
    if !plain_folders(root, &folder)? {
        return Err(NotesError::InvalidFolder);
    }
    let journal = read_vault_config(root).journal_folder;
    let skipped = if folder.split('/').any(|segment| segment.starts_with('.'))
        || !tree_filter(root)(&folder)
    {
        Some("the tree hides it")
    } else if !journal.is_empty() && (within(&journal, &folder) || within(&folder, &journal)) {
        Some("it is or holds the journal folder, or is inside it")
    } else if respells_a_sibling(root, &folder)? {
        Some("a folder beside it differs in case only")
    } else {
        None
    };
    if let Some(reason) = skipped {
        tracing::warn!(scope = SCOPE, reason, "a synced folder stays as it is here");
        return Ok(None);
    }
    Ok(Some(folder))
}
