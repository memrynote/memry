//! The folders of the sidebar's notes tree (Step 13h, #3530): `getFolders`, `createFolder`
//! (`vault/notes-crud.ts`), `notes:get-folder-config`, `notes:set-folder-config` and
//! `notes:get-folder-template` (`ipc/notes-handlers.ts`, `vault/folders.ts`).
//!
//! A folder is a directory of the vault; its settings live in its `.folder.md`
//! ([`folder_file`]), and its icon is mirrored in the synced `folder_config` record
//! ([`memry_core::domain::folders`]), so a folder with no notes reaches the other devices
//! (`notes/folder-config-effects.ts`). The file is the truth here: a record that cannot be
//! written is an error after the file was, as in Electron, and a path the record cannot name
//! (a segment with outer spaces) keeps its file and is logged.
//!
//! Not here yet: the locked-folder check (Step 14), the record backfill of folders made before
//! records existed and of folders made in a file manager (`backfillFolderConfigs`,
//! `syncFolderConfigDiscovered`, Step 17).

use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use memry_core::domain::folders::valid_path;

use super::error::{NotesError, SCOPE};
use super::moves::plain_folder;
use super::service::NotesService;
use crate::session::OpenVault;
use crate::shell::file_open::Resolution;
use crate::vault::config::read_vault_config;
use crate::vault::folder_file::{self, FolderConfigView, FolderFileError};
use crate::vault::layout::{ATTACHMENTS_DIR, CANVAS_DIR};
use crate::vault::paths::resolve_vault_file;

/// A folder of the tree (`FolderInfo` of `@memry/rpc/notes`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderView {
    pub path: String,
    pub icon: Option<String>,
}

/// `notes:set-folder-config`'s config, as `FolderConfigSchema` parses it.
#[derive(Debug, Clone, Default, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderConfigInput {
    /// Absent: the file's icon stays; `null`: none.
    #[serde(default, deserialize_with = "crate::templates::present")]
    #[specta(optional, type = Option<String>)]
    pub icon: Option<Option<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub template: Option<String>,
    /// `z.boolean().optional().default(true)`.
    #[serde(default)]
    #[specta(optional)]
    pub inherit: Option<bool>,
}

/// `getFolders`: every folder of the vault the tree lists, each with its icon: the record's
/// when the folder has one, else its file's.
pub fn list(open: &OpenVault) -> Result<Vec<FolderView>, NotesError> {
    let root = open.path.as_path();
    let shown = tree_filter(root);
    let icons: HashMap<String, Option<String>> = open
        .vault
        .notes()
        .folders()?
        .into_iter()
        .map(|folder| (folder.path, folder.icon))
        .collect();
    Ok(directories(root)?
        .into_iter()
        .filter(|path| shown(path))
        .map(|path| {
            let icon = match icons.get(&path) {
                Some(icon) => icon.clone(),
                None => file_of(root, &path).and_then(|file| file.icon().map(str::to_owned)),
            };
            FolderView { path, icon }
        })
        .collect())
}

/// `createTreeFolderFilter`: hides the attachments and canvases folders and the first folder
/// of each exclude pattern by their first segment, and the journal folder's subtree unless the
/// journal is shown in the sidebar.
fn tree_filter(root: &Path) -> impl Fn(&str) -> bool {
    let config = read_vault_config(root);
    let hidden: Vec<String> = [ATTACHMENTS_DIR.to_owned(), CANVAS_DIR.to_owned()]
        .into_iter()
        .chain(config.exclude_patterns)
        .filter(|pattern| !pattern.is_empty())
        .map(|pattern| {
            let trimmed = pattern.trim_end_matches('/');
            trimmed.split('/').next().unwrap_or(trimmed).to_owned()
        })
        .collect();
    let journal = (!config.journal_show_in_sidebar).then_some(config.journal_folder);
    move |path: &str| {
        let first = path.split('/').next().unwrap_or(path);
        !hidden.iter().any(|hidden| hidden == first)
            && !journal.as_deref().is_some_and(|journal| {
                !journal.is_empty()
                    && (path == journal
                        || path
                            .strip_prefix(journal)
                            .is_some_and(|rest| rest.starts_with('/')))
            })
    }
}

/// `listDirectories`: every folder under the vault, vault-relative with `/`, each before its
/// subfolders and siblings by name. Dot folders and links are not entered; a folder that cannot
/// be read or went meanwhile lists nothing, as does a name that is not UTF-8.
fn directories(root: &Path) -> Result<Vec<String>, NotesError> {
    let mut found = Vec::new();
    let mut stack = vec![String::new()];
    while let Some(folder) = stack.pop() {
        if !folder.is_empty() {
            found.push(folder.clone());
        }
        let dir = folder
            .split('/')
            .filter(|segment| !segment.is_empty())
            .fold(root.to_path_buf(), |path, segment| path.join(segment));
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error)
                if !folder.is_empty()
                    && matches!(
                        error.kind(),
                        ErrorKind::NotFound | ErrorKind::PermissionDenied
                    ) =>
            {
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        let mut children = Vec::new();
        for entry in entries {
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if name.starts_with('.') || !entry.file_type()?.is_dir() {
                continue;
            }
            children.push(match folder.as_str() {
                "" => name,
                folder => format!("{folder}/{name}"),
            });
        }
        children.sort_unstable_by(|a, b| b.cmp(a));
        stack.extend(children);
    }
    Ok(found)
}

/// `folder`'s file, `None` when there is none or it cannot be read (logged).
fn file_of(root: &Path, folder: &str) -> Option<folder_file::FolderFile> {
    folder_file::read(root, folder)
        .inspect_err(|error| {
            tracing::warn!(scope = SCOPE, "a folder's settings are unread: {error}")
        })
        .ok()
        .flatten()
}

/// A folder the renderer names (`""` is the vault root), as a plain path inside the vault.
fn vault_folder(root: &Path, folder: &str) -> Result<String, NotesError> {
    let folder = plain_folder(folder)?;
    if !folder.is_empty() && resolve_vault_file(root, &folder)? == Resolution::Outside {
        return Err(NotesError::Outside);
    }
    Ok(folder)
}

/// `notes:get-folder-config`: `None` when the folder has no file, or one that cannot be read.
pub fn config(open: &OpenVault, folder: &str) -> Result<Option<FolderConfigView>, NotesError> {
    let root = open.path.as_path();
    let folder = vault_folder(root, folder)?;
    Ok(file_of(root, &folder).map(|file| file.config()))
}

/// `notes:get-folder-template`.
pub fn template(open: &OpenVault, folder: &str) -> Result<Option<String>, NotesError> {
    let root = open.path.as_path();
    Ok(folder_file::template_of(root, &vault_folder(root, folder)?))
}

/// The folder on disk, for the file manager.
pub fn on_disk(open: &OpenVault, folder: &str) -> Result<std::path::PathBuf, NotesError> {
    let root = open.path.as_path();
    let folder = vault_folder(root, folder)?;
    Ok(folder
        .split('/')
        .filter(|segment| !segment.is_empty())
        .fold(root.to_path_buf(), |path, segment| path.join(segment)))
}

impl NotesService {
    /// `createFolder`: the folder and its parents on disk, the folder above its siblings in the
    /// manual order, and its `folder_config` record when it has none, so an empty folder
    /// reaches the other devices. A folder that is there already is no error and keeps its
    /// icon (Electron's create cleared it).
    pub fn create_folder(&self, open: &OpenVault, folder: &str) -> Result<(), NotesError> {
        let root = open.path.as_path();
        let folder = vault_folder(root, folder)?;
        if folder.is_empty() {
            return Err(NotesError::InvalidFolder);
        }
        fs::create_dir_all(on_disk(open, &folder)?).map_err(|error| match error.kind() {
            ErrorKind::AlreadyExists | ErrorKind::NotADirectory => NotesError::NameConflict,
            _ => error.into(),
        })?;
        let parent = folder.rsplit_once('/').map_or("", |(parent, _)| parent);
        open.vault.note_positions().place_at_top(&folder, parent)?;
        if valid_path(&folder).is_err() {
            tracing::warn!(
                scope = SCOPE,
                "a folder name no record can hold stays on this device"
            );
            return Ok(());
        }
        let known = open
            .vault
            .notes()
            .folders()?
            .iter()
            .any(|row| row.path == folder);
        if !known {
            open.vault
                .notes_writer(self.store.clone())?
                .create_folder(folder, None)?;
        }
        Ok(())
    }

    /// `notes:set-folder-config`: the icon (kept when absent), the template and `inherit` in the
    /// folder's file, which keeps its views; then the icon in the folder's record.
    pub fn set_folder_config(
        &self,
        open: &OpenVault,
        folder: &str,
        input: &FolderConfigInput,
    ) -> Result<(), NotesError> {
        let root = open.path.as_path();
        let folder = vault_folder(root, folder)?;
        let mut icon = None;
        folder_file::update(root, &folder, |file| {
            icon = match &input.icon {
                Some(given) => given.clone(),
                None => file.icon().map(str::to_owned),
            };
            file.set(
                icon.as_deref(),
                input.template.as_deref(),
                input.inherit.unwrap_or(true),
            );
        })?;
        if folder.is_empty() || valid_path(&folder).is_err() {
            return Ok(());
        }
        open.vault
            .notes_writer(self.store.clone())?
            .set_folder_icon(folder, icon)?;
        Ok(())
    }
}

impl From<FolderFileError> for NotesError {
    fn from(error: FolderFileError) -> Self {
        Self::FolderFile(error)
    }
}
