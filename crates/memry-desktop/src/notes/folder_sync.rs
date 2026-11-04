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
//!   not deleted, still holds a file, or keeps changing. A folder made in a file manager has no
//!   tombstone and is never removed.
//!
//! [`NotesWriter::folder_deleted`]: memry_core::api::notes_write::NotesWriter::folder_deleted

use std::fs;

use super::error::{NotesError, SCOPE};
use super::folders::vault_folder;
use super::moves::plain_folders;
use super::service::NotesService;
use crate::session::OpenVault;
use crate::vault::app_move::on_disk;
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
        let folder = remote_folder(root, path)?;
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
        let folder = remote_folder(root, path)?;
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
    /// `path`'s record, so it counts as deleted without asking.
    pub fn prune_deleted_folders(
        &self,
        open: &OpenVault,
        path: &str,
        folder_config_deleted: bool,
    ) -> Result<Vec<String>, NotesError> {
        self.prune_deleted_folders_quiet(open, path, folder_config_deleted, Quiet::default())
    }

    /// [`Self::prune_deleted_folders`] with the quiet window and the wait for it.
    #[doc(hidden)]
    pub fn prune_deleted_folders_quiet(
        &self,
        open: &OpenVault,
        path: &str,
        folder_config_deleted: bool,
        quiet: Quiet,
    ) -> Result<Vec<String>, NotesError> {
        let root = open.path.as_path();
        let writer = open.vault.notes_writer(self.store.clone())?;
        let mut current = remote_folder(root, path)?;
        let mut known_deleted = folder_config_deleted;
        let mut removed = Vec::new();
        while !current.is_empty() {
            if !known_deleted && !writer.folder_deleted(&current)? {
                break;
            }
            known_deleted = false;
            // A link would take the removal to what it leads to.
            if !plain_folders(root, &current)? {
                break;
            }
            match empty_folder::remove_if_empty(root, &current, quiet)? {
                Removal::Removed => {
                    tracing::info!(scope = SCOPE, "removed a folder deleted on another device");
                    removed.push(current.clone());
                }
                Removal::Missing => {}
                Removal::HoldsFiles(file) => {
                    tracing::info!(
                        scope = SCOPE,
                        file,
                        "kept a folder deleted on another device, it still holds files"
                    );
                    break;
                }
                Removal::Busy => {
                    tracing::warn!(
                        scope = SCOPE,
                        "kept a folder deleted on another device, its files kept changing"
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

/// A folder a record names, as a plain path inside the vault; never the vault root.
fn remote_folder(root: &std::path::Path, path: &str) -> Result<String, NotesError> {
    let folder = vault_folder(root, path)?;
    if folder.is_empty() || !plain_folders(root, &folder)? {
        return Err(NotesError::InvalidFolder);
    }
    Ok(folder)
}
