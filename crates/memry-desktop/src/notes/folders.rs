//! The folders of the sidebar's notes tree (Step 13h, #3530): `getFolders`, `createFolder`
//! (`vault/notes-crud.ts`), `notes:get-folder-config`, `notes:set-folder-config` and
//! `notes:get-folder-template` (`ipc/notes-handlers.ts`, `vault/folders.ts`).
//!
//! A folder is a directory of the vault; its settings live in its `.folder.md`
//! ([`folder_file`]), and its icon is mirrored in the synced `folder_config` record
//! ([`memry_core::domain::folders`]), so a folder with no notes reaches the other devices
//! (`notes/folder-config-effects.ts`). The file holds the template, `inherit` and the views;
//! a record that cannot be written is an error after the file was, as in Electron, and a path
//! the record cannot name (a segment with outer spaces) keeps its file and is logged.
//!
//! The icon has one owner for every read: the folder's record when it has one, else its file
//! ([`shown_icon`]). The tree, the settings read and a settings write that leaves the icon
//! alone all take it from there, so the renderer's `{ ...existing, template }` cannot send a
//! stale file icon back over the record's.
//!
//! Not here yet: the record backfill of folders made before
//! records existed and of folders made in a file manager (`backfillFolderConfigs`,
//! `syncFolderConfigDiscovered`, Step 17, #3534), and a remote record's icon written into the
//! folder's file (`writeMergedFolderConfig`, #3906).

use std::collections::HashMap;
use std::fs;
use std::io::{self, ErrorKind};
use std::path::Path;

use unicode_normalization::UnicodeNormalization;

use memry_core::domain::folders::valid_path;

use super::error::{NotesError, SCOPE};
use super::moves::{disk_spelling, plain_folder, plain_folders};
use super::service::NotesService;
use crate::locks::Locks;
use crate::session::OpenVault;
use crate::shell::file_open::Resolution;
use crate::vault::config::read_vault_config;
use crate::vault::folder_file::{self, FolderConfigView, FolderFileError};
use crate::vault::layout::{ATTACHMENTS_DIR, CANVAS_DIR};
use crate::vault::path_key::folded_key;
use crate::vault::paths::resolve_vault_file;
use crate::vault::watch::filter::WatchFilter;

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
            let icon = shown_icon(icons.get(&path).cloned(), || file_icon(root, &path));
            FolderView { path, icon }
        })
        .collect())
}

/// The icon a folder shows: `recorded` (its record's, `None` without a record) when it has a
/// record, else its file's, read only then.
fn shown_icon(
    recorded: Option<Option<String>>,
    file_icon: impl FnOnce() -> Option<String>,
) -> Option<String> {
    recorded.unwrap_or_else(file_icon)
}

fn file_icon(root: &Path, folder: &str) -> Option<String> {
    file_of(root, folder).and_then(|file| file.icon().map(str::to_owned))
}

/// `folder`'s record icon: `None` when it has no record.
fn recorded_icon(open: &OpenVault, folder: &str) -> Result<Option<Option<String>>, NotesError> {
    Ok(open
        .vault
        .notes()
        .folders()?
        .into_iter()
        .find(|row| row.path == folder)
        .map(|row| row.icon))
}

/// `createTreeFolderFilter`: hides the attachments and canvases folders and the first folder
/// of each exclude pattern by their first segment, and the journal folder's subtree unless the
/// journal is shown in the sidebar.
pub(super) fn tree_filter(root: &Path) -> impl Fn(&str) -> bool {
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

/// A folder the renderer names (`""` is the vault root), as a plain path inside the vault. One
/// under a file is no folder; the disk would say so in its own words (`ENOTDIR` on Unix, not
/// found on Windows).
pub(crate) fn vault_folder(root: &Path, folder: &str) -> Result<String, NotesError> {
    let folder = plain_folder(folder)?;
    if folder.is_empty() {
        return Ok(folder);
    }
    if under_a_file(root, &folder)? {
        return Err(NotesError::InvalidFolder);
    }
    if resolve_vault_file(root, &folder)? == Resolution::Outside {
        return Err(NotesError::Outside);
    }
    Ok(folder)
}

/// Whether a folder above `folder` is a file. Links are followed: where one leads is
/// [`resolve_vault_file`]'s to judge.
fn under_a_file(root: &Path, folder: &str) -> io::Result<bool> {
    let Some((parents, _)) = folder.rsplit_once('/') else {
        return Ok(false);
    };
    let mut path = root.to_path_buf();
    for segment in parents.split('/') {
        path.push(segment);
        match fs::metadata(&path) {
            Ok(meta) if !meta.is_dir() => return Ok(true),
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        }
    }
    Ok(false)
}

/// Whether a segment of `folder` is spelled like a folder or file beside it in case only. A
/// case-blind disk (macOS, Windows) would create into that one while the record names this
/// spelling, a folder the other devices then hold twice. The same name in another Unicode
/// form is the same name.
pub(super) fn respells_a_sibling(root: &Path, folder: &str) -> io::Result<bool> {
    let mut dir = root.to_path_buf();
    for segment in folder.split('/') {
        if sibling_named(&dir, segment)?.is_some_and(|name| !name.nfc().eq(segment.nfc())) {
            return Ok(true);
        }
        dir.push(segment);
    }
    Ok(false)
}

/// Whether the journal's days can live in `folder` (canonical, vault-relative), by the rules a
/// folder move's target follows (`folder_move`): a folder path the records can name, outside
/// the folders the tree keeps to itself, none of whose segments is hidden or a link the open
/// walk would not enter, that the vault's exclude patterns do not drop, and that respells no
/// folder already there. A day moved where the next open does not find it under its name would
/// be read as removed.
pub(crate) fn holds_journal_days(
    root: &Path,
    folder: &str,
    exclude_patterns: Vec<String>,
) -> io::Result<bool> {
    let top = folder.split('/').next().unwrap_or(folder);
    Ok(valid_path(folder).is_ok()
        && top != ATTACHMENTS_DIR
        && top != CANVAS_DIR
        && !folder.split('/').any(|segment| segment.starts_with('.'))
        && !WatchFilter::new(exclude_patterns).ignores(folder)
        && plain_folders(root, folder)?
        && !respells_a_sibling(root, folder)?)
}

/// The entry of `dir` that a folder `segment` there would be on a disk that folds case or
/// Unicode form, as `dir` lists it: one spelled as `segment` in any Unicode form, else one
/// that differs from it in case only. `None` when there is none, or no `dir`. Every volume
/// answers alike, so a vault copied between them keeps one spelling per folder.
pub(super) fn sibling_named(dir: &Path, segment: &str) -> io::Result<Option<String>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let (wanted, folded) = (segment.nfc().collect::<String>(), folded_key(segment));
    let mut respelled = None;
    for entry in entries {
        let name = entry?.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.nfc().eq(wanted.chars()) {
            return Ok(Some(name.to_owned()));
        }
        if respelled.is_none() && folded_key(name) == folded {
            respelled = Some(name.to_owned());
        }
    }
    Ok(respelled)
}

/// `notes:get-folder-config`: `None` when the folder has no file, or one that cannot be read.
pub fn config(open: &OpenVault, folder: &str) -> Result<Option<FolderConfigView>, NotesError> {
    let root = open.path.as_path();
    let folder = vault_folder(root, folder)?;
    let Some(file) = file_of(root, &folder) else {
        return Ok(None);
    };
    let mut config = file.config();
    config.icon = shown_icon(recorded_icon(open, &folder)?, || {
        file.icon().map(str::to_owned)
    });
    Ok(Some(config))
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
    /// icon (Electron's create cleared it); one made outside the app gives its record its
    /// file's icon. A folder the tree hides (a dot folder, attachments, canvases, an excluded
    /// one) is refused, as a move into one is, and so is a spelling that differs from a
    /// sibling's in case only, and so is one inside a locked folder.
    pub fn create_folder(&self, open: &OpenVault, folder: &str) -> Result<(), NotesError> {
        let root = open.path.as_path();
        let folder = vault_folder(root, folder)?;
        Locks::of(open).refuse_parent_folder(&disk_spelling(root, &folder))?;
        if folder.is_empty()
            || folder.split('/').any(|segment| segment.starts_with('.'))
            || !tree_filter(root)(&folder)
        {
            return Err(NotesError::InvalidFolder);
        }
        if respells_a_sibling(root, &folder)? {
            return Err(NotesError::NameConflict);
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
        if recorded_icon(open, &folder)?.is_none() {
            let icon = file_icon(root, &folder);
            open.vault
                .notes_writer(self.store.clone())?
                .create_folder(folder, icon)?;
        }
        Ok(())
    }

    /// `notes:set-folder-config`: the icon, the template and `inherit` in the folder's file,
    /// which keeps its views; then the icon in the folder's record. An absent icon keeps the
    /// one the folder shows ([`shown_icon`]).
    pub fn set_folder_config(
        &self,
        open: &OpenVault,
        folder: &str,
        input: &FolderConfigInput,
    ) -> Result<(), NotesError> {
        let root = open.path.as_path();
        let folder = vault_folder(root, folder)?;
        let recorded = recorded_icon(open, &folder)?;
        let mut icon = None;
        folder_file::update(root, &folder, |file| {
            icon = match &input.icon {
                Some(given) => given.clone(),
                None => shown_icon(recorded, || file.icon().map(str::to_owned)),
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
